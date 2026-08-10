import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import type { ExecutorVerificationRepo } from '../storage/executor-verification-repo.js';
import { digestBinaryPath, digestExecutorRegistryConfig, validateExecutorRegistryConfig } from './executor-registry-config.js';
import type { ExecutorRegistryService } from './executor-registry-service.js';
import { extractExecutorSessionId } from './executor-session-output.js';
import {
  runtimeContractForDriver,
  type ExecutorDefinition,
  type ExecutorDriverId,
  type ExecutorProfileDefinition,
  type ExecutorRegistryConfig,
  type ExecutorVerification,
  type RuntimeExecutorBinding,
} from './executor-registry-types.js';

const MAX_VERIFY_OUTPUT_BYTES = 1024 * 1024;

export interface ExecutorProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  terminateSignal?: 'SIGTERM' | 'SIGINT';
}

export interface ExecutorProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export type ExecutorProcessRunner = (request: ExecutorProcessRequest) => Promise<ExecutorProcessResult>;

export class ExecutorRegistrationService {
  constructor(private readonly deps: {
    registry: ExecutorRegistryService;
    verificationRepo: ExecutorVerificationRepo;
    statusRepo: KernelExecutorStatusRepo;
    processRunner?: ExecutorProcessRunner;
  }) {}

  async discover(): Promise<Array<{
    profileId: string;
    displayName: string;
    driver: ExecutorDriverId;
    binaryPath: string | null;
    version: string | null;
  }>> {
    const snapshot = this.deps.registry.current();
    const discovered = [];
    for (const profile of snapshot.profiles.values()) {
      const binaryPath = await discoverBinary(profile.discoveryCommands);
      let version: string | null = null;
      if (binaryPath) {
        const result = await this.runner()({
          command: binaryPath,
          args: ['--version'],
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 10_000,
          maxOutputBytes: 64_000,
        });
        version = result.exitCode === 0 ? `${result.stdout}\n${result.stderr}`.trim() : null;
      }
      discovered.push({
        profileId: profile.id,
        displayName: profile.displayName,
        driver: profile.driver,
        binaryPath,
        version,
      });
    }
    return discovered;
  }

  async register(executor: ExecutorDefinition): Promise<ExecutorVerification> {
    const current = this.deps.registry.current();
    const config = snapshotConfig(current);
    const nextExecutors = config.executors.filter(item => item.id !== executor.id);
    const candidate: ExecutorRegistryConfig = {
      ...config,
      executors: [...nextExecutors, { ...executor, enabled: true }]
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    const errors = validateExecutorRegistryConfig(candidate);
    if (errors.length > 0) throw new Error(errors.join('; '));
    const configDigest = digestExecutorRegistryConfig(candidate);
    const verifications = await this.verifyCandidateConfig(candidate, configDigest);
    const verification = verifications.find(item => item.executorId === executor.id)!;
    await this.writeConfig(candidate);
    for (const item of verifications) this.recordSuccessfulVerification(item);
    this.deps.registry.reload();
    return verification;
  }

  async verify(executorId: string): Promise<ExecutorVerification> {
    const snapshot = this.deps.registry.current();
    const executor = snapshot.executors.get(executorId);
    if (!executor) throw new Error(`Executor is not registered: ${executorId}`);
    const verification = await this.verifyDefinition(structuredClone(executor), snapshot.configDigest);
    this.deps.verificationRepo.upsert(verification);
    this.deps.statusRepo.upsert({
      agentClassName: executor.id,
      classHealth: verification.success ? 'healthy' : 'error',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: verification.verifiedAt,
    });
    this.deps.registry.reload();
    return verification;
  }

  async setEnabled(executorId: string, enabled: boolean): Promise<void> {
    const snapshot = this.deps.registry.current();
    const config = snapshotConfig(snapshot);
    const executor = config.executors.find(item => item.id === executorId);
    if (!executor) throw new Error(`Executor is not registered: ${executorId}`);
    executor.enabled = enabled;
    const nextDigest = digestExecutorRegistryConfig(config);
    const verifications = await this.verifyCandidateConfig(config, nextDigest);
    await this.writeConfig(config);
    for (const item of verifications) this.recordSuccessfulVerification(item);
    if (!enabled) {
      this.deps.statusRepo.upsert({
        agentClassName: executorId,
        classHealth: 'disabled',
        recentAttempts: [],
        recentRecoveryChecks: [],
        updatedAt: new Date().toISOString(),
      });
    }
    this.deps.registry.reload();
  }

  private async verifyCandidateConfig(
    config: ExecutorRegistryConfig,
    configDigest: string,
  ): Promise<ExecutorVerification[]> {
    const verifications: ExecutorVerification[] = [];
    for (const executor of config.executors.filter(item => item.enabled)) {
      const verification = await this.verifyDefinition(executor, configDigest);
      if (!verification.success) {
        this.deps.verificationRepo.upsert(verification);
        throw new Error(`${executor.id}: ${String(verification.result.error ?? 'Executor verification failed')}`);
      }
      verifications.push(verification);
    }
    return verifications;
  }

  private recordSuccessfulVerification(verification: ExecutorVerification): void {
    this.deps.verificationRepo.upsert(verification);
    this.deps.statusRepo.upsert({
      agentClassName: verification.executorId,
      classHealth: 'healthy',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: verification.verifiedAt,
    });
  }

  private async verifyDefinition(
    executor: ExecutorDefinition,
    configDigest: string,
  ): Promise<ExecutorVerification> {
    const verifiedAt = new Date().toISOString();
    const base = {
      executorId: executor.id,
      configDigest,
      binaryPath: executor.binding.binaryPath,
      binaryPathDigest: digestBinaryPath(executor.binding.binaryPath),
      version: '',
      driver: executor.binding.driver,
      verifiedAt,
    };
    const temporaryRoot = await mkdtemp(join(tmpdir(), `anyfusion-verify-${executor.id}-`));
    const workspace = join(temporaryRoot, 'workspace');
    const runtimeHome = join(temporaryRoot, 'runtime-home');
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(runtimeHome, { recursive: true });
      await materializeVerificationHome(executor.binding, runtimeHome);
      await this.validateProcessControls(temporaryRoot);
      const gitInit = await this.runner()({
        command: 'git',
        args: ['init', '--quiet', workspace],
        cwd: temporaryRoot,
        env: process.env,
        timeoutMs: 10_000,
        maxOutputBytes: 64_000,
      });
      if (gitInit.exitCode !== 0) throw new Error(`temporary Git workspace initialization failed: ${gitInit.stderr}`);
      const version = await this.runner()({
        command: executor.binding.binaryPath,
        args: executor.binding.versionArgs,
        cwd: workspace,
        env: await verificationEnvironment(executor.binding, runtimeHome),
        timeoutMs: 15_000,
        maxOutputBytes: 64_000,
      });
      const versionText = `${version.stdout}\n${version.stderr}`.trim();
      if (version.exitCode !== 0 || version.timedOut || !new RegExp(executor.binding.versionPattern, 'u').test(versionText)) {
        throw new Error(`version probe failed for ${executor.id}: ${versionText || `exit ${version.exitCode}`}`);
      }
      const firstChallenge = challenge();
      const first = await this.invokeChallenge(executor, workspace, runtimeHome, firstChallenge, null);
      if (!first.output.includes(firstChallenge)) throw new Error('first verification turn did not return the challenge');
      if (!first.sessionId) throw new Error('first verification turn did not expose a session ID');
      const secondChallenge = challenge();
      const second = await this.invokeChallenge(executor, workspace, runtimeHome, secondChallenge, first.sessionId);
      if (!second.output.includes(secondChallenge)) throw new Error('resumed verification turn did not return the second challenge');
      return {
        ...base,
        version: versionText.slice(0, 500),
        success: true,
        result: {
          firstSessionId: first.sessionId,
          resumedSessionId: second.sessionId ?? first.sessionId,
          cwdIsolated: true,
          homeIsolated: true,
          outputBytes: Buffer.byteLength(first.output) + Buffer.byteLength(second.output),
          timeoutValidated: true,
          abortValidated: true,
        },
      };
    } catch (error) {
      return {
        ...base,
        success: false,
        result: { error: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async invokeChallenge(
    executor: ExecutorDefinition,
    cwd: string,
    runtimeHome: string,
    challengeText: string,
    sessionId: string | null,
  ): Promise<{ output: string; sessionId: string | null }> {
    const binding: RuntimeExecutorBinding = {
      id: executor.id,
      configDigest: '',
      driver: executor.binding.driver,
      ...runtimeContractForDriver(executor.binding.driver, executor.binding.sessionProtocol),
      binaryPath: executor.binding.binaryPath,
      versionArgs: executor.binding.versionArgs,
      runtimeHome,
      environmentFiles: executor.binding.environmentFiles,
      inheritEnvironment: executor.binding.inheritEnvironment,
      permissionProfileId: executor.binding.effectivePermissionProfile,
      backendSupport: executor.binding.backendSupport,
      dockerImageRef: executor.binding.dockerImageRef,
      dockerImageId: executor.binding.dockerImageId,
      sessionProtocol: executor.binding.sessionProtocol,
    };
    const invocation = verificationInvocation(binding, challengeText, sessionId);
    const result = await this.runner()({
      command: binding.binaryPath,
      args: invocation.args,
      cwd,
      env: await verificationEnvironment(executor.binding, runtimeHome),
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: MAX_VERIFY_OUTPUT_BYTES,
      terminateSignal: executor.binding.sessionProtocol?.terminateSignal ?? 'SIGTERM',
    });
    if (result.timedOut) throw new Error('verification invocation timed out');
    if (result.aborted) throw new Error('verification invocation was aborted');
    if (result.exitCode !== 0) throw new Error(`verification invocation failed: ${result.stderr || result.stdout}`);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (Buffer.byteLength(output) > MAX_VERIFY_OUTPUT_BYTES) throw new Error('verification output exceeded the configured limit');
    return { output, sessionId: extractExecutorSessionId(binding, output) };
  }

  private async validateProcessControls(cwd: string): Promise<void> {
    const timeout = await this.runner()({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd,
      env: process.env,
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      terminateSignal: 'SIGTERM',
    });
    if (!timeout.timedOut) throw new Error('verification process timeout control failed');
    const outputLimit = await this.runner()({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4096))"],
      cwd,
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 128,
      terminateSignal: 'SIGTERM',
    });
    if (!outputLimit.aborted) throw new Error('verification process output-limit abort control failed');
  }

  private async writeConfig(config: ExecutorRegistryConfig): Promise<void> {
    const path = this.deps.registry.current().configPath;
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, dump(config, { noRefs: true, lineWidth: 120 }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  private runner(): ExecutorProcessRunner {
    return this.deps.processRunner ?? runExecutorProcess;
  }
}

export async function runExecutorProcess(request: ExecutorProcessRequest): Promise<ExecutorProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    const append = (current: string, chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > request.maxOutputBytes) {
        aborted = true;
        child.kill(request.terminateSignal ?? 'SIGTERM');
        return current;
      }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(request.terminateSignal ?? 'SIGTERM');
    }, request.timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, timedOut, aborted });
    });
  });
}

function verificationInvocation(
  binding: RuntimeExecutorBinding,
  prompt: string,
  sessionId: string | null,
): { args: string[]; timeoutMs: number } {
  if (binding.driver === 'codex') {
    return {
      args: sessionId
        ? ['exec', 'resume', '--json', sessionId, prompt]
        : ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', prompt],
      timeoutMs: 120_000,
    };
  }
  if (binding.driver === 'pi') {
    return {
      args: sessionId
        ? ['--mode', 'json', '--session', sessionId, '-p', prompt]
        : ['--mode', 'json', '-p', prompt],
      timeoutMs: 120_000,
    };
  }
  if (binding.driver === 'hermes') {
    return {
      args: sessionId
        ? ['chat', '--resume', sessionId, '-q', prompt, '-Q', '--yolo', '--source', 'anyfusion-verification']
        : ['chat', '-q', prompt, '-Q', '--yolo', '--source', 'anyfusion-verification'],
      timeoutMs: 120_000,
    };
  }
  const protocol = binding.sessionProtocol;
  if (!protocol) throw new Error('cli-session verification requires sessionProtocol');
  const template = sessionId ? protocol.resumeArgs : protocol.initialArgs;
  return {
    args: template.map(arg => arg.replaceAll('{prompt}', prompt).replaceAll('{sessionId}', sessionId ?? '')),
    timeoutMs: protocol.timeoutMs,
  };
}

async function materializeVerificationHome(
  binding: ExecutorDefinition['binding'],
  runtimeHome: string,
): Promise<void> {
  if (binding.driver === 'codex') {
    await copyRequiredFile(
      join(binding.runtimeHome, 'config.toml'),
      join(runtimeHome, 'config.toml'),
      'Codex config.toml',
    );
    return;
  }
  if (binding.driver === 'pi') {
    const sourceAgentHome = join(binding.runtimeHome, '.pi', 'agent');
    const targetAgentHome = join(runtimeHome, '.pi', 'agent');
    await mkdir(targetAgentHome, { recursive: true });
    await Promise.all([
      copyRequiredFile(join(sourceAgentHome, 'models.json'), join(targetAgentHome, 'models.json'), 'Pi models.json'),
      copyRequiredFile(join(sourceAgentHome, 'settings.json'), join(targetAgentHome, 'settings.json'), 'Pi settings.json'),
    ]);
    return;
  }
  if (binding.driver === 'hermes') {
    const source = binding.runtimeHome.endsWith('/.hermes')
      ? join(binding.runtimeHome, 'config.yaml')
      : join(binding.runtimeHome, '.hermes', 'config.yaml');
    await copyRequiredFile(source, join(runtimeHome, '.hermes', 'config.yaml'), 'Hermes config.yaml');
  }
}

async function copyRequiredFile(source: string, target: string, label: string): Promise<void> {
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch (error) {
    throw new Error(`${label} could not be materialized from ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verificationEnvironment(
  binding: ExecutorDefinition['binding'],
  runtimeHome: string,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of binding.inheritEnvironment) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const file of binding.environmentFiles) {
    const content = await readFile(file, 'utf8');
    for (const line of content.split(/\r?\n/u)) {
      const separator = line.indexOf('=');
      if (separator <= 0 || line.trimStart().startsWith('#')) continue;
      environment[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  environment.HOME = runtimeHome;
  if (binding.driver === 'codex') environment.CODEX_HOME = runtimeHome;
  if (binding.driver === 'pi') {
    environment.PI_CODING_AGENT_DIR = join(runtimeHome, '.pi', 'agent');
    environment.PI_CODING_AGENT_SESSION_DIR = join(runtimeHome, '.pi', 'agent', 'sessions');
    await mkdir(environment.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
  }
  return environment;
}

async function discoverBinary(commands: string[]): Promise<string | null> {
  for (const command of commands) {
    const result = await runExecutorProcess({
      command: 'which',
      args: [command],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    });
    const path = result.stdout.trim();
    if (result.exitCode === 0 && path.startsWith('/')) return path;
  }
  return null;
}

function challenge(): string {
  return `ANYFUSION_VERIFY_${randomBytes(16).toString('hex')}`;
}

function snapshotConfig(snapshot: ReturnType<ExecutorRegistryService['current']>): ExecutorRegistryConfig {
  return {
    schemaVersion: 1,
    capabilities: [...snapshot.capabilities.values()].map(item => structuredClone(item)),
    profiles: [...snapshot.profiles.values()].map(item => structuredClone(item)),
    executors: [...snapshot.executors.values()].map(item => structuredClone(item)),
  };
}

export function profileRegistrationDefaults(
  profile: ExecutorProfileDefinition,
  binaryPath: string,
  runtimeHome: string,
): Pick<ExecutorDefinition, 'profileId' | 'description' | 'capabilities' | 'binding'> {
  return {
    profileId: profile.id,
    description: profile.defaultDescription,
    capabilities: [...profile.suggestedCapabilities],
    binding: {
      binaryPath,
      versionArgs: ['--version'],
      versionPattern: '.+',
      driver: profile.driver,
      runtimeHome,
      environmentFiles: [],
      inheritEnvironment: [],
      effectivePermissionProfile: profile.suggestedCapabilities.includes('current-web-research')
        ? 'public-web-research'
        : 'workspace-engineering',
      backendSupport: ['worktree'],
      dockerImageRef: null,
      dockerImageId: null,
      sessionProtocol: null,
    },
  };
}
