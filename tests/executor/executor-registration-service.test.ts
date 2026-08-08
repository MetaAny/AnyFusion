import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  ExecutorRegistrationService,
  type ExecutorProcessRequest,
  type ExecutorProcessResult,
} from '../../src/executor/executor-registration-service.js';
import { ensureExecutorRegistryConfig } from '../../src/executor/executor-registry-config.js';
import { ExecutorRegistryService } from '../../src/executor/executor-registry-service.js';
import type { ExecutorDefinition } from '../../src/executor/executor-registry-types.js';
import { ExecutorVerificationRepo } from '../../src/storage/executor-verification-repo.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

function harness(runner: (request: ExecutorProcessRequest) => Promise<ExecutorProcessResult>) {
  const root = mkdtempSync(join(tmpdir(), 'executor-registration-'));
  const configPath = join(root, 'executors.yaml');
  ensureExecutorRegistryConfig(configPath);
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const verificationRepo = new ExecutorVerificationRepo(db);
  const statusRepo = new KernelExecutorStatusRepo(db);
  const registry = new ExecutorRegistryService({ verificationRepo, statusRepo, configPath });
  return {
    root,
    configPath,
    db,
    registry,
    verificationRepo,
    statusRepo,
    service: new ExecutorRegistrationService({
      registry,
      verificationRepo,
      statusRepo,
      processRunner: runner,
    }),
  };
}

function ok(overrides: Partial<ExecutorProcessResult> = {}): ExecutorProcessResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

function genericExecutor(root: string): ExecutorDefinition {
  return {
    id: 'custom-cli',
    profileId: null,
    description: 'A generic workspace Executor.',
    capabilities: ['workspace-engineering'],
    primaryUseCases: ['Implement and verify workspace changes.'],
    enabled: true,
    binding: {
      binaryPath: '/opt/custom/bin/custom-cli',
      versionArgs: ['version'],
      versionPattern: '^custom-cli 1\\.2\\.3$',
      driver: 'cli-session',
      runtimeHome: join(root, 'source-home'),
      environmentFiles: [],
      inheritEnvironment: ['PATH'],
      effectivePermissionProfile: 'workspace-engineering',
      backendSupport: ['worktree'],
      dockerImageRef: null,
      dockerImageId: null,
      sessionProtocol: {
        initialArgs: ['start', '--prompt', '{prompt}'],
        resumeArgs: ['resume', '{sessionId}', '--prompt', '{prompt}'],
        sessionIdPattern: 'session=(?<sessionId>[A-Za-z0-9-]+)',
        finalOutputPattern: 'final=(?<output>.+)',
        timeoutMs: 45_000,
        terminateSignal: 'SIGINT',
      },
    },
    strengths: [],
    weaknesses: [],
    riskLevel: 'medium',
    domains: [],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    avoidUseCases: [],
    affinity: {},
  };
}

function successfulRunner(requests: ExecutorProcessRequest[]) {
  return vi.fn(async (request: ExecutorProcessRequest) => {
    requests.push(request);
    if (request.command === process.execPath && request.timeoutMs === 25) {
      return ok({ exitCode: 1, timedOut: true });
    }
    if (request.command === process.execPath && request.maxOutputBytes === 128) {
      return ok({ exitCode: 1, aborted: true });
    }
    if (request.command === 'git') return ok();
    if (request.args[0] === 'version') return ok({ stdout: 'custom-cli 1.2.3' });
    const challenge = request.args.find(arg => arg.includes('ANYFUSION_VERIFY_'));
    if (!challenge) return ok({ exitCode: 1, stderr: 'challenge missing' });
    return ok({ stdout: `session=session-1\nfinal=${challenge}` });
  });
}

describe('ExecutorRegistrationService', () => {
  it('verifies version, isolation, initial session and resume before atomically loading the candidate', async () => {
    const requests: ExecutorProcessRequest[] = [];
    const runner = successfulRunner(requests);
    const test = harness(runner);

    const verification = await test.service.register(genericExecutor(test.root));

    expect(verification).toMatchObject({
      executorId: 'custom-cli',
      version: 'custom-cli 1.2.3',
      success: true,
      result: {
        firstSessionId: 'session-1',
        resumedSessionId: 'session-1',
        cwdIsolated: true,
        homeIsolated: true,
        timeoutValidated: true,
        abortValidated: true,
      },
    });
    expect(test.registry.current().runtime.get('custom-cli')).toMatchObject({
      driver: 'cli-session',
      supportsSessionResume: true,
      resultCollector: 'pattern',
    });
    const challengeRequests = requests.filter(request =>
      request.args.some(arg => arg.includes('ANYFUSION_VERIFY_'))
    );
    expect(challengeRequests).toHaveLength(2);
    expect(challengeRequests[0]?.args).toEqual(expect.arrayContaining(['start', '--prompt']));
    expect(challengeRequests[1]?.args).toEqual(expect.arrayContaining(['resume', 'session-1', '--prompt']));
    expect(challengeRequests.every(request => request.cwd.endsWith('/workspace'))).toBe(true);
    expect(challengeRequests.every(request => (
      typeof request.env.HOME === 'string'
      && request.env.HOME.includes('/runtime-home')
      && request.env.HOME !== genericExecutor(test.root).binding.runtimeHome
    ))).toBe(true);
    expect(challengeRequests.every(request => request.terminateSignal === 'SIGINT')).toBe(true);
    expect(test.statusRepo.findByAgentClassName('custom-cli')?.classHealth).toBe('healthy');
  });

  it('keeps the previous YAML and snapshot active when candidate verification fails', async () => {
    const requests: ExecutorProcessRequest[] = [];
    const runner = successfulRunner(requests);
    const test = harness(async request => {
      const result = await runner(request);
      if (request.args[0] === 'version') return ok({ stdout: 'unexpected version' });
      return result;
    });
    const before = readFileSync(test.configPath, 'utf8');
    const beforeDigest = test.registry.current().configDigest;

    await expect(test.service.register(genericExecutor(test.root)))
      .rejects.toThrow('version probe failed');

    expect(readFileSync(test.configPath, 'utf8')).toBe(before);
    expect(test.registry.current().configDigest).toBe(beforeDigest);
    expect(test.registry.current().executors.has('custom-cli')).toBe(false);
    expect(test.verificationRepo.list()).toEqual([
      expect.objectContaining({ executorId: 'custom-cli', success: false }),
    ]);
  });

  it('marks a prior verification stale after a manual config digest change', async () => {
    const requests: ExecutorProcessRequest[] = [];
    const test = harness(successfulRunner(requests));
    await test.service.register(genericExecutor(test.root));
    const verifiedDigest = test.registry.current().configDigest;
    const raw = load(readFileSync(test.configPath, 'utf8')) as {
      executors: Array<{ id: string; description: string }>;
    };
    raw.executors.find(executor => executor.id === 'custom-cli')!.description = 'Manually changed.';
    writeFileSync(test.configPath, dump(raw, { noRefs: true }));

    const next = test.registry.reload();

    expect(next.configDigest).not.toBe(verifiedDigest);
    expect(next.tui.find(executor => executor.id === 'custom-cli')?.verification).toBe('stale');
    expect(next.planner.executors).toEqual([]);
    expect(next.runtime.has('custom-cli')).toBe(false);
  });

  it('materializes a dedicated Codex home for verification and removes it afterwards', async () => {
    const requests: ExecutorProcessRequest[] = [];
    let materializedConfig = '';
    let isolatedHome = '';
    const runner = vi.fn(async (request: ExecutorProcessRequest) => {
      requests.push(request);
      if (request.command === process.execPath && request.timeoutMs === 25) {
        return ok({ exitCode: 1, timedOut: true });
      }
      if (request.command === process.execPath && request.maxOutputBytes === 128) {
        return ok({ exitCode: 1, aborted: true });
      }
      if (request.command === 'git') return ok();
      if (request.args[0] === '--version') return ok({ stdout: 'codex 1.0.0' });
      isolatedHome = String(request.env.CODEX_HOME);
      materializedConfig = readFileSync(join(isolatedHome, 'config.toml'), 'utf8');
      const challenge = request.args.find(arg => arg.includes('ANYFUSION_VERIFY_'))!;
      return ok({ stdout: `{"thread_id":"thread-1"}\n${challenge}` });
    });
    const test = harness(runner);
    const sourceHome = join(test.root, 'codex-source');
    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(join(sourceHome, 'config.toml'), 'model = "test"\n');
    const executor = genericExecutor(test.root);
    executor.id = 'repo-codex';
    executor.profileId = 'codex';
    executor.binding = {
      ...executor.binding,
      binaryPath: '/usr/bin/codex',
      versionArgs: ['--version'],
      versionPattern: '^codex 1\\.0\\.0$',
      driver: 'codex',
      runtimeHome: sourceHome,
      sessionProtocol: null,
    };

    await expect(test.service.register(executor)).resolves.toMatchObject({ success: true });

    expect(materializedConfig).toBe('model = "test"\n');
    expect(isolatedHome).not.toBe(sourceHome);
    expect(existsSync(isolatedHome)).toBe(false);
  });

  it('extracts and resumes the native Pi JSONL session header', async () => {
    const requests: ExecutorProcessRequest[] = [];
    const runner = vi.fn(async (request: ExecutorProcessRequest) => {
      requests.push(request);
      if (request.command === process.execPath && request.timeoutMs === 25) {
        return ok({ exitCode: 1, timedOut: true });
      }
      if (request.command === process.execPath && request.maxOutputBytes === 128) {
        return ok({ exitCode: 1, aborted: true });
      }
      if (request.command === 'git') return ok();
      if (request.args[0] === '--version') return ok({ stdout: '0.81.1' });
      const challenge = request.args.find(arg => arg.includes('ANYFUSION_VERIFY_'))!;
      return ok({
        stdout: [
          '{"type":"session","version":3,"id":"pi-session-1","cwd":"/tmp/workspace"}',
          JSON.stringify({ type: 'message_update', challenge }),
        ].join('\n'),
      });
    });
    const test = harness(runner);
    const sourceHome = join(test.root, 'pi-source');
    mkdirSync(join(sourceHome, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(sourceHome, '.pi', 'agent', 'models.json'), '{}');
    writeFileSync(join(sourceHome, '.pi', 'agent', 'settings.json'), '{}');
    const executor = genericExecutor(test.root);
    executor.id = 'pi-agent';
    executor.profileId = 'pi';
    executor.binding = {
      ...executor.binding,
      binaryPath: '/usr/bin/pi',
      versionArgs: ['--version'],
      versionPattern: '^0\\.81\\.1$',
      driver: 'pi',
      runtimeHome: sourceHome,
      sessionProtocol: null,
    };

    await expect(test.service.register(executor)).resolves.toMatchObject({
      success: true,
      result: {
        firstSessionId: 'pi-session-1',
        resumedSessionId: 'pi-session-1',
      },
    });

    const resumed = requests.find(request => request.args.includes('--session'));
    expect(resumed?.args).toEqual(expect.arrayContaining(['--session', 'pi-session-1']));
  });
});
