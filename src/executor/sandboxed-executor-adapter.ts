import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentClass, ExecutorResult } from '../core/types.js';
import type { AttemptSandboxPort } from '../execution/attempt-sandbox.js';
import { DEFAULT_ATTEMPT_SANDBOX_LIMITS } from '../execution/attempt-sandbox.js';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import { buildCodexNonInteractiveArgs, buildCodexResumeArgs } from './codex-args.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import type { AttemptSandboxRepositoryPort } from '../execution/repositories.js';
import { buildEnvFromFile } from '../utils/env-file.js';
import { AttemptModelGatewayServer } from '../execution/attempt-model-gateway.js';
import { normalizeExecutorFailure } from './error-utils.js';
import type { RuntimeExecutorBinding } from './executor-registry-types.js';
import { extractExecutorFinalOutput, extractExecutorSessionId } from './executor-session-output.js';

const EXECUTOR_PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
] as const;

const SANDBOX_SAFE_PROVIDER_ENV_KEYS = [
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
] as const;

const RESPONSE_ONLY_TIMEOUT_MS = 120_000;

export const EXECUTOR_RESULT_FILE_NAME = 'executor-final-response.md';

interface NativeExecutorEnvironment {
  environment: Record<string, string>;
  temporaryRoot: string;
}

export class SandboxedExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation: boolean;
  readonly supportsResponseOnly: boolean;
  private readonly activeRuntimes = new Map<string, string>();
  private readonly runtimeBinding: Readonly<RuntimeExecutorBinding>;
  private readonly sandbox: AttemptSandboxPort;
  private readonly repository?: AttemptSandboxRepositoryPort;
  private readonly agentClass: AgentClass;

  constructor(
    agentClass: AgentClass,
    runtimeBinding: Readonly<RuntimeExecutorBinding>,
    sandbox: AttemptSandboxPort,
    repository?: AttemptSandboxRepositoryPort,
  ) {
    this.agentClass = agentClass;
    this.runtimeBinding = runtimeBinding;
    this.sandbox = sandbox;
    this.repository = repository;
    this.name = agentClass.name;
    this.supportsContinuation = this.runtimeBinding.supportsSessionResume;
    this.supportsResponseOnly = ['codex', 'pi'].includes(this.runtimeBinding.driver);
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const binding = input.sandbox;
    if (!binding) return failed('sandbox binding is required', 'sandbox_binding_missing', startedAt);
    if (!this.agentClass.permissionProfileId) {
      return failed(`AgentClass ${this.name} has no permission profile`, 'agent_class_sandbox_unconfigured', startedAt);
    }
    const nativePaths = true;
    const usesDockerProxy = false;
    const executionWorkspacePath = nativePaths ? binding.workspacePath : '/workspace';
    const resultPath = join(binding.workspacePath, '.metaclaw', 'results', EXECUTOR_RESULT_FILE_NAME);
    const prompt = buildExecutorContextPrompt({
      ...input,
      context: {
        ...input.context,
        workspaceContext: {
          ...input.context.workspaceContext,
          workingDirectory: executionWorkspacePath,
          targetPaths: input.context.workspaceContext.targetPaths.map(target => (
            nativePaths
              ? target
              : target === binding.workspacePath || target.startsWith(`${binding.workspacePath}/`) || target.startsWith(`${binding.workspacePath}\\`)
              ? `/workspace${target.slice(binding.workspacePath.length).replaceAll('\\', '/')}`
              : target
          )),
        },
      },
    });
    const { command, args } = this.commandAndArgs(
      prompt,
      `${executionWorkspacePath}/.metaclaw/results/${EXECUTOR_RESULT_FILE_NAME}`,
      input,
      nativePaths,
    );
    let modelGateway: AttemptModelGatewayServer | null = null;
    let nativeExecutorTemporaryRoot: string | null = null;
    try {
      const providerEnvironment = this.providerEnvironment();
      const upstreamBaseUrl = providerEnvironment.OPENAI_BASE_URL;
      const upstreamApiKey = providerEnvironment.OPENAI_API_KEY;
      if (!upstreamBaseUrl || !upstreamApiKey) {
        throw new Error('attempt model gateway requires OPENAI_BASE_URL and OPENAI_API_KEY');
      }
      const sandboxProviderEnvironment = Object.fromEntries(SANDBOX_SAFE_PROVIDER_ENV_KEYS.flatMap(key => {
        const value = providerEnvironment[key];
        return value ? [[key, value]] : [];
      }));
      modelGateway = new AttemptModelGatewayServer({
        upstreamBaseUrl,
        upstreamApiKey,
        advertisedHost: nativePaths ? '127.0.0.1' : process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control',
      });
      const gateway = await modelGateway.start();
      sandboxProviderEnvironment.OPENAI_BASE_URL = gateway.baseUrl;
      sandboxProviderEnvironment.OPENAI_API_KEY = gateway.apiKey;
      const nativeExecutor = nativePaths
        ? await this.prepareNativeExecutorEnvironment(upstreamBaseUrl, gateway.baseUrl)
        : null;
      nativeExecutorTemporaryRoot = nativeExecutor?.temporaryRoot ?? null;
      const record = await this.sandbox.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        leaseToken: binding.leaseToken,
        idempotencyKey: binding.idempotencyKey,
        command,
        args,
        environment: {
          ...nativeExecutor?.environment,
          ...sandboxProviderEnvironment,
          METACLAW_ATTEMPT_ID: binding.attemptId,
          METACLAW_CAPABILITY_MCP_URL: binding.capabilityBinding?.mcpUrl ?? '',
          METACLAW_CAPABILITY_URL: binding.capabilityBinding?.jsonUrl ?? '',
          METACLAW_CAPABILITY_USE_URL: binding.capabilityBinding?.useUrl ?? '',
          METACLAW_CAPABILITY_TOKEN: binding.capabilityBinding?.bearerToken ?? '',
          METACLAW_EVIDENCE_MCP_URL: input.context.evidenceTools.binding?.mcpUrl ?? '',
          METACLAW_EVIDENCE_JSON_URL: input.context.evidenceTools.binding?.jsonUrl ?? '',
          METACLAW_EVIDENCE_TOKEN: input.context.evidenceTools.binding?.bearerToken ?? '',
          ...(usesDockerProxy ? {
            HTTP_PROXY: 'http://metaclaw-egress:8080',
            HTTPS_PROXY: 'http://metaclaw-egress:8080',
            NO_PROXY: 'metaclaw-control',
          } : {}),
        },
        mounts: [
          { source: binding.workspacePath, target: '/workspace', mode: 'rw' },
          { source: binding.sourcePath, target: '/source', mode: 'ro' },
          { source: binding.inputsPath, target: '/inputs', mode: 'ro' },
          { source: binding.handoffsPath, target: '/handoffs', mode: 'ro' },
          ...(binding.gitMetadataPath
            ? [{ source: binding.gitMetadataPath, target: '/workspace/.git', mode: 'ro' as const }]
            : []),
        ],
        egressMode: usesDockerProxy ? 'proxy' : 'disabled',
        nestedSandbox: !nativePaths && this.runtimeBinding.driver === 'codex' ? 'codex-workspace-write' : undefined,
        limits: DEFAULT_ATTEMPT_SANDBOX_LIMITS,
      });
      const createdAt = new Date().toISOString();
      this.repository?.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        workspaceId: binding.workspaceId,
        runtimeHandle: record.runtimeHandle,
        processId: null,
        status: 'created',
        leaseToken: binding.leaseToken,
        labels: record.labels,
        exitCode: null,
        resultCollectedAt: null,
        cleanupStatus: null,
        cleanupError: null,
        createdAt,
        updatedAt: createdAt,
      });
      this.activeRuntimes.set(binding.attemptId, record.runtimeHandle);
      const running = await this.sandbox.start(record.runtimeHandle);
      binding.onRuntimeStarted?.(record.runtimeHandle, running.processId);
      input.onProgress?.({ kind: 'status', text: `worktree execution ${record.runtimeHandle.slice(0, 24)} started` });
      this.repository?.update(binding.attemptId, {
        processId: running.processId, status: 'running', updatedAt: new Date().toISOString(),
      });
      const exitCode = await this.sandbox.wait(record.runtimeHandle);
      const logs = await this.sandbox.logs(record.runtimeHandle);
      this.repository?.update(binding.attemptId, {
        status: 'exited', exitCode, resultCollectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      this.captureContinuationToken(logs, input);
      let output = logs.trim();
      if (this.runtimeBinding.resultCollector === 'result-file' && exitCode === 0) {
        output = (await readFile(resultPath, 'utf8').catch(() => logs)).trim();
      }
      output = this.extractFinalOutput(output);
      if (output !== logs.trim()) this.captureContinuationToken(output, input);
      if (output && !nativePaths) {
        const runtimeWorkspacePath = binding.workspacePath.replaceAll('\\', '/');
        output = output.replaceAll(/\/workspace(?=\/|[\s`"')\]}]|$)/gu, runtimeWorkspacePath);
      }
      await this.sandbox.remove(record.runtimeHandle);
      this.repository?.update(binding.attemptId, { status: 'removed', cleanupStatus: 'removed', updatedAt: new Date().toISOString() });
      this.activeRuntimes.delete(binding.attemptId);
      return exitCode === 0 && output
        ? { success: true, output, exitCode, durationMs: Date.now() - startedAt }
        : failedExecution(logs.trim() || `sandbox exited with code ${exitCode}`, startedAt, exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let cleanupError: string | null = null;
      const activeRuntimeHandle = this.activeRuntimes.get(binding.attemptId) ?? null;
      if (activeRuntimeHandle) {
        try {
          await this.sandbox.stop(activeRuntimeHandle);
          await this.sandbox.remove(activeRuntimeHandle);
          this.repository?.update(binding.attemptId, {
            status: 'removed', cleanupStatus: 'removed', cleanupError: null, updatedAt: new Date().toISOString(),
          });
        } catch (cleanup) {
          cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup);
        }
      }
      if (cleanupError || !activeRuntimeHandle) {
        this.repository?.update(binding.attemptId, {
          cleanupStatus: 'failed', cleanupError: cleanupError ?? message, updatedAt: new Date().toISOString(),
        });
      }
      this.activeRuntimes.delete(binding.attemptId);
      return failed(message, 'sandbox_configuration_failure', startedAt);
    } finally {
      await modelGateway?.close().catch(() => undefined);
      if (nativeExecutorTemporaryRoot) {
        await rm(nativeExecutorTemporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async probe(
    _previousFailure?: import('../core/kernel-failure.js').KernelFailure | null,
  ): Promise<import('./adapter.js').ExecutorProbeResult> {
    if (!this.agentClass.permissionProfileId || !this.runtimeBinding.binaryPath) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'agent_class_sandbox_unconfigured',
          summary: `AgentClass ${this.name} has no verified Runtime binding or permission profile`,
        },
      };
    }
    try {
      const provider = this.providerEnvironment();
      if (!provider.OPENAI_BASE_URL || !provider.OPENAI_API_KEY) {
        return {
          available: false,
          failure: {
            kind: 'authentication',
            scope: 'agent_class',
            code: 'provider_configuration_missing',
            summary: 'OPENAI_BASE_URL and OPENAI_API_KEY are required',
          },
        };
      }
      return { available: true, failure: null };
    } catch (error) {
      return {
        available: false,
        failure: {
          kind: 'adapter',
          scope: 'agent_class',
          code: 'executor_local_probe_failed',
          summary: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async executeResponseOnly(input: { prompt: string; maxBytes: number }): Promise<ExecutorResult> {
    const startedAt = Date.now();
    if (!this.supportsResponseOnly) {
      return failed(
        `Executor ${this.name} does not support response-only correction`,
        'response_only_unsupported',
        startedAt,
      );
    }
    let modelGateway: AttemptModelGatewayServer | null = null;
    let temporaryRoot: string | null = null;
    try {
      const providerEnvironment = this.providerEnvironment();
      const upstreamBaseUrl = providerEnvironment.OPENAI_BASE_URL;
      const upstreamApiKey = providerEnvironment.OPENAI_API_KEY;
      if (!upstreamBaseUrl || !upstreamApiKey) {
        throw new Error('response-only model gateway requires OPENAI_BASE_URL and OPENAI_API_KEY');
      }
      modelGateway = new AttemptModelGatewayServer({
        upstreamBaseUrl,
        upstreamApiKey,
        advertisedHost: '127.0.0.1',
        bindHost: '127.0.0.1',
      });
      const gateway = await modelGateway.start();
      const nativeExecutor = await this.prepareNativeExecutorEnvironment(
        upstreamBaseUrl,
        gateway.baseUrl,
      );
      temporaryRoot = nativeExecutor.temporaryRoot;
      const outputPath = join(temporaryRoot, 'response-only-result.md');
      const args = this.responseOnlyArgs(input.prompt, outputPath, temporaryRoot);
      const result = await runResponseOnlyProcess({
        command: this.runtimeBinding.binaryPath,
        args,
        cwd: temporaryRoot,
        env: {
          ...process.env,
          ...nativeExecutor.environment,
          ...Object.fromEntries(SANDBOX_SAFE_PROVIDER_ENV_KEYS.flatMap(key => {
            const value = providerEnvironment[key];
            return value ? [[key, value]] : [];
          })),
          OPENAI_BASE_URL: gateway.baseUrl,
          OPENAI_API_KEY: gateway.apiKey,
        },
        maxBytes: input.maxBytes,
      });
      let output = result.stdout.trim();
      if (this.runtimeBinding.driver === 'codex' && result.exitCode === 0) {
        output = (await readFile(outputPath, 'utf8').catch(() => result.stdout)).trim();
      } else {
        output = this.extractFinalOutput(output);
      }
      return result.exitCode === 0 && output
        ? { success: true, output, exitCode: 0, durationMs: Date.now() - startedAt }
        : failedExecution(
            result.stderr.trim() || result.stdout.trim() || `response-only process exited with code ${result.exitCode}`,
            startedAt,
            result.exitCode,
          );
    } catch (error) {
      return failedExecution(
        error instanceof Error ? error.message : String(error),
        startedAt,
        1,
      );
    } finally {
      await modelGateway?.close().catch(() => undefined);
      if (temporaryRoot) {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  abort(attemptId?: string): void {
    const runtimeHandles = attemptId
      ? [this.activeRuntimes.get(attemptId)].filter((id): id is string => Boolean(id))
      : [...this.activeRuntimes.values()];
    for (const runtimeHandle of runtimeHandles) {
      void this.sandbox.stop(runtimeHandle).catch(() => undefined);
    }
  }

  private commandAndArgs(
    prompt: string,
    outputPath: string,
    input: ExecutorInput,
    nativePaths: boolean,
  ): { command: string; args: string[] } {
    const command = this.runtimeBinding.binaryPath;
    if (this.runtimeBinding.driver === 'codex') {
      const continuationToken = input.recovery?.continuationToken;
      const options = {
        ephemeral: false,
        json: true,
        outputLastMessagePath: outputPath,
        sandbox: nativePaths ? 'danger-full-access' as const : 'workspace-write' as const,
      };
      const args = continuationToken && input.recovery?.mode === 'native_session'
        ? buildCodexResumeArgs(continuationToken, prompt, options)
        : buildCodexNonInteractiveArgs(prompt, options);
      const runtimeMcpArgs: string[] = [];
      const evidenceMcpUrl = input.context.evidenceTools.binding?.mcpUrl;
      const capabilityMcpUrl = input.sandbox?.capabilityBinding?.mcpUrl;
      if (evidenceMcpUrl) {
        runtimeMcpArgs.push(
          '-c', `mcp_servers.metaclaw_evidence.url=${JSON.stringify(evidenceMcpUrl)}`,
          '-c', 'mcp_servers.metaclaw_evidence.bearer_token_env_var=\"METACLAW_EVIDENCE_TOKEN\"',
        );
      }
      if (capabilityMcpUrl) {
        runtimeMcpArgs.push(
          '-c', `mcp_servers.metaclaw_capability.url=${JSON.stringify(capabilityMcpUrl)}`,
          '-c', 'mcp_servers.metaclaw_capability.bearer_token_env_var=\"METACLAW_CAPABILITY_TOKEN\"',
        );
      }
      args.splice(args.length - 1, 0, ...runtimeMcpArgs);
      return { command, args };
    }
    if (this.runtimeBinding.driver === 'pi') {
      const extensionPath = process.env.METACLAW_PI_ATTEMPT_EXTENSION?.trim()
        || '/opt/metaclaw/pi-attempt-tools.ts';
      const continuationToken = input.recovery?.continuationToken;
      return {
        command,
        args: [
          '--mode', 'json',
          ...(continuationToken && input.recovery?.mode === 'native_session'
            ? ['--session', continuationToken]
            : []),
          '--no-extensions', '--extension', extensionPath, '--tools',
          'web_search,web_fetch,evidence_list,evidence_search,evidence_get,bash,read,write,edit,grep,find,ls',
          '-p', prompt,
        ],
      };
    }
    if (this.runtimeBinding.driver === 'hermes') {
      const continuationToken = input.recovery?.continuationToken;
      return {
        command,
        args: continuationToken && input.recovery?.mode === 'native_session'
          ? ['chat', '--resume', continuationToken, '-q', prompt, '-Q', '--yolo', '--source', 'anyfusion']
          : ['chat', '-q', prompt, '-Q', '--yolo', '--source', 'anyfusion'],
      };
    }
    const protocol = this.runtimeBinding.sessionProtocol;
    if (!protocol) throw new Error(`Executor ${this.name} cli-session binding has no session protocol`);
    const continuationToken = input.recovery?.continuationToken;
    const template = continuationToken && input.recovery?.mode === 'native_session'
      ? protocol.resumeArgs
      : protocol.initialArgs;
    return {
      command,
      args: template.map(arg => arg
        .replaceAll('{prompt}', prompt)
        .replaceAll('{sessionId}', continuationToken ?? '')
        .replaceAll('{outputPath}', outputPath)),
    };
  }

  private responseOnlyArgs(prompt: string, outputPath: string, cwd: string): string[] {
    if (this.runtimeBinding.driver === 'codex') {
      const args = buildCodexNonInteractiveArgs(prompt, {
        ephemeral: true,
        json: true,
        outputLastMessagePath: outputPath,
        sandbox: 'workspace-write',
      });
      args.splice(args.length - 1, 0, '--ignore-rules', '-C', cwd);
      return args;
    }
    return [
      '--mode', 'text',
      '--no-session',
      '--no-extensions',
      '--no-tools',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '-p', prompt,
    ];
  }

  private async prepareNativeExecutorEnvironment(
    upstreamBaseUrl: string,
    gatewayBaseUrl: string,
  ): Promise<NativeExecutorEnvironment> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'metaclaw-executor-attempt-'));
    try {
      if (this.runtimeBinding.driver === 'codex') {
        const sourceHome = this.runtimeBinding.runtimeHome;
        const source = await readFile(join(sourceHome, 'config.toml'), 'utf8');
        if (!source.includes(upstreamBaseUrl)) {
          throw new Error('Codex Executor config does not contain the configured provider base URL');
        }
        const attemptHome = join(temporaryRoot, 'codex');
        await mkdir(attemptHome, { recursive: true });
        await writeFile(
          join(attemptHome, 'config.toml'),
          source.replaceAll(upstreamBaseUrl, gatewayBaseUrl),
          { encoding: 'utf8', mode: 0o600 },
        );
        return { environment: { CODEX_HOME: attemptHome }, temporaryRoot };
      }

      if (this.runtimeBinding.homeMaterializer === 'hermes-config') {
        const attemptHome = join(temporaryRoot, 'hermes');
        const sourceConfig = this.runtimeBinding.runtimeHome.endsWith('/.hermes')
          ? join(this.runtimeBinding.runtimeHome, 'config.yaml')
          : join(this.runtimeBinding.runtimeHome, '.hermes', 'config.yaml');
        const targetConfig = join(attemptHome, '.hermes', 'config.yaml');
        await mkdir(join(attemptHome, '.hermes'), { recursive: true });
        await copyFile(sourceConfig, targetConfig);
        return { environment: { HOME: attemptHome }, temporaryRoot };
      }

      if (this.runtimeBinding.homeMaterializer !== 'pi-config') {
        const attemptHome = join(temporaryRoot, 'runtime-home');
        await mkdir(attemptHome, { recursive: true });
        return { environment: { HOME: attemptHome }, temporaryRoot };
      }
      const sourceHome = this.runtimeBinding.runtimeHome;
      const sourceAgentHome = join(sourceHome, '.pi', 'agent');
      const [modelsSource, settingsSource] = await Promise.all([
        readFile(join(sourceAgentHome, 'models.json'), 'utf8'),
        readFile(join(sourceAgentHome, 'settings.json'), 'utf8'),
      ]);
      const models = JSON.parse(modelsSource) as unknown;
      if (!isRecord(models) || !isRecord(models.providers)) {
        throw new Error('Pi Executor models.json has no providers object');
      }
      let replacements = 0;
      for (const provider of Object.values(models.providers)) {
        if (isRecord(provider) && provider.baseUrl === upstreamBaseUrl) {
          provider.baseUrl = gatewayBaseUrl;
          replacements += 1;
        }
      }
      if (replacements === 0) {
        throw new Error('Pi Executor config does not contain the configured provider base URL');
      }
      const attemptHome = join(temporaryRoot, 'pi');
      const attemptAgentHome = join(attemptHome, '.pi', 'agent');
      const attemptSessionHome = join(attemptAgentHome, 'sessions');
      await mkdir(attemptSessionHome, { recursive: true });
      await Promise.all([
        writeFile(join(attemptAgentHome, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 }),
        writeFile(join(attemptAgentHome, 'settings.json'), settingsSource, { mode: 0o600 }),
      ]);
      return {
        environment: {
          HOME: attemptHome,
          PI_CODING_AGENT_DIR: attemptAgentHome,
          PI_CODING_AGENT_SESSION_DIR: attemptSessionHome,
        },
        temporaryRoot,
      };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private providerEnvironment(): Record<string, string> {
    const inherited: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ));
    let source: Record<string, string> = inherited;
    for (const envFile of this.runtimeBinding.environmentFiles) {
      source = Object.fromEntries(Object.entries(buildEnvFromFile(envFile, source)).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ));
    }
    return Object.fromEntries(EXECUTOR_PROVIDER_ENV_KEYS.flatMap(key => {
      const value = source[String(key)];
      return value ? [[key, value]] : [];
    }));
  }

  private extractFinalOutput(output: string): string {
    return extractExecutorFinalOutput(this.runtimeBinding, output);
  }

  private captureContinuationToken(output: string, input: ExecutorInput): void {
    if (!input.recovery?.onContinuationToken) return;
    const token = extractExecutorSessionId(this.runtimeBinding, output);
    if (token) input.recovery.onContinuationToken(token);
  }
}

function runResponseOnlyProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBytes: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolvePromise => {
    execFile(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      encoding: 'utf8',
      timeout: RESPONSE_ONLY_TIMEOUT_MS,
      maxBuffer: input.maxBytes,
    }, (error, stdout, stderr) => {
      resolvePromise({
        exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr: error && !stderr ? error.message : stderr,
      });
    });
  });
}

function failed(message: string, code: string, startedAt: number, exitCode = 1): ExecutorResult {
  return {
    success: false,
    output: '',
    error: message,
    failure: { kind: 'configuration', scope: 'agent_class', code, summary: message },
    exitCode,
    durationMs: Date.now() - startedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failedExecution(message: string, startedAt: number, exitCode: number): ExecutorResult {
  const failure = normalizeExecutorFailure(message);
  return {
    success: false,
    output: '',
    error: failure.summary,
    failure,
    exitCode,
    durationMs: Date.now() - startedAt,
  };
}
