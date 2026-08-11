import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentClass } from '../../src/core/types.js';
import type { AttemptSandboxPort, CreateAttemptSandboxInput } from '../../src/execution/attempt-sandbox.js';
import {
  EXECUTOR_RESULT_FILE_NAME,
  SandboxedExecutorAdapter,
} from '../../src/executor/sandboxed-executor-adapter.js';
import {
  runtimeContractForDriver,
  type RuntimeExecutorBinding,
} from '../../src/executor/executor-registry-types.js';

describe('SandboxedExecutorAdapter provider isolation', () => {
  it('passes only the attempt gateway token instead of provider credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-sandbox-provider-'));
    const envFile = join(directory, 'executor-pi.env');
    writeFileSync(envFile, [
      'OPENAI_API_KEY=openai-provider-secret',
      'OPENAI_BASE_URL=https://provider.invalid/v1',
      'ANTHROPIC_API_KEY=anthropic-provider-secret',
      'ANTHROPIC_BASE_URL=https://anthropic.invalid',
      'DEEPSEEK_API_KEY=deepseek-provider-secret',
      'GOOGLE_GENERATIVE_AI_API_KEY=google-provider-secret',
      'OPENROUTER_API_KEY=openrouter-provider-secret',
      'PI_SKIP_VERSION_CHECK=1',
      'PI_TELEMETRY=0',
    ].join('\n'));
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    preparePiHome(directory);
    vi.stubEnv('METACLAW_CONTROL_HOST', 'metaclaw-control');
    const { sandbox, create } = sandboxPort();
    const adapter = new SandboxedExecutorAdapter(agentClass(), testRuntimeBinding(agentClass(), sandbox.kind), sandbox);

    try {
      const result = await adapter.execute(executorInput(directory));

      expect(result.success).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      const environment = create.mock.calls[0]![0].environment;
      expect(environment.OPENAI_API_KEY).toBeTruthy();
      expect(environment.OPENAI_API_KEY).not.toBe('openai-provider-secret');
      expect(environment.OPENAI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(environment).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(environment).not.toHaveProperty('DEEPSEEK_API_KEY');
      expect(environment).not.toHaveProperty('GOOGLE_GENERATIVE_AI_API_KEY');
      expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
      expect(environment).toMatchObject({ PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed instead of injecting a credential without a gateway endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-sandbox-provider-'));
    const envFile = join(directory, 'executor-pi.env');
    writeFileSync(envFile, 'OPENAI_API_KEY=unpaired-provider-secret\n');
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    vi.stubEnv('OPENAI_BASE_URL', '');
    const { sandbox, create } = sandboxPort();
    const adapter = new SandboxedExecutorAdapter(agentClass(), testRuntimeBinding(agentClass(), sandbox.kind), sandbox);

    try {
      const result = await adapter.execute(executorInput(directory));

      expect(result).toMatchObject({
        success: false,
        failure: { code: 'sandbox_configuration_failure' },
      });
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs canonical Pi directly in the worktree without the Docker egress proxy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-worktree-provider-'));
    const envFile = join(directory, 'executor-pi.env');
    const piHome = join(directory, 'pi-home');
    const piAgentHome = join(piHome, '.pi', 'agent');
    mkdirSync(piAgentHome, { recursive: true });
    writeFileSync(envFile, [
      'OPENAI_API_KEY=provider-secret',
      'OPENAI_BASE_URL=https://provider.invalid/v1',
    ].join('\n'));
    writeFileSync(join(piAgentHome, 'models.json'), JSON.stringify({
      providers: { anyint: { baseUrl: 'https://provider.invalid/v1' } },
    }));
    writeFileSync(join(piAgentHome, 'settings.json'), '{}');
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    vi.stubEnv('METACLAW_EXECUTOR_PI_HOME', piHome);
    const { sandbox, create } = sandboxPort('worktree');
    let attemptHome = '';
    let renderedModels = '';
    create.mockImplementation(async (input: CreateAttemptSandboxInput) => {
      attemptHome = input.environment.HOME;
      renderedModels = readFileSync(join(attemptHome, '.pi', 'agent', 'models.json'), 'utf8');
      return sandboxRecord();
    });
    const adapter = new SandboxedExecutorAdapter(agentClass(), testRuntimeBinding(agentClass(), sandbox.kind), sandbox);

    try {
      const result = await adapter.execute(executorInput(directory));

      expect(result.success).toBe(true);
      const attempt = create.mock.calls[0]![0];
      expect(attempt.egressMode).toBe('disabled');
      expect(attempt.environment).not.toHaveProperty('HTTP_PROXY');
      expect(attempt.environment).not.toHaveProperty('HTTPS_PROXY');
      expect(attempt.environment.OPENAI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(JSON.parse(renderedModels).providers.anyint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      expect(renderedModels).not.toContain('https://provider.invalid/v1');
      expect(attemptHome).not.toBe(piHome);
      expect(existsSync(attemptHome)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs a Pi recovery-packet retry with the full tool profile and completion contract', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-worktree-pi-extension-'));
    const envFile = join(directory, 'executor-pi.env');
    const piHome = join(directory, 'pi-home');
    const piAgentHome = join(piHome, '.pi', 'agent');
    mkdirSync(piAgentHome, { recursive: true });
    writeFileSync(envFile, [
      'OPENAI_API_KEY=provider-secret',
      'OPENAI_BASE_URL=https://provider.invalid/v1',
    ].join('\n'));
    writeFileSync(join(piAgentHome, 'models.json'), JSON.stringify({
      providers: { anyint: { baseUrl: 'https://provider.invalid/v1' } },
    }));
    writeFileSync(join(piAgentHome, 'settings.json'), '{}');
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    vi.stubEnv('METACLAW_EXECUTOR_PI_HOME', piHome);
    vi.stubEnv('METACLAW_PI_ATTEMPT_EXTENSION', '/native/anyfusion/pi-attempt-tools.ts');
    const { sandbox, create } = sandboxPort('worktree');
    const adapter = new SandboxedExecutorAdapter(agentClass(), testRuntimeBinding(agentClass(), sandbox.kind), sandbox);

    try {
      const input = executorInput(directory, 'attempt_retry');
      input.context.recovery = {
        mode: 'recovery_packet',
        sourceAttemptId: 'attempt_primary',
        packet: { completionRetry: { protocol: 'completion-correction-v2' } },
      };
      const result = await adapter.execute(input);

      expect(result.success).toBe(true);
      const args = create.mock.calls[0]![0].args;
      expect(args).toContain('/native/anyfusion/pi-attempt-tools.ts');
      expect(args).not.toContain('/opt/metaclaw/pi-attempt-tools.ts');
      expect(args).not.toContain('--no-tools');
      expect(args[args.indexOf('--tools') + 1]).toContain('evidence_search');
      expect(args[args.indexOf('--tools') + 1]).toContain('bash');
      expect(args.at(-1)).toContain('recovery_packet');
      expect(args.at(-1)).toContain('completion-correction-v2');
      expect(args.at(-1)).toContain('<!-- metaclaw:completion:v4 -->');
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders a scoped Codex home against the attempt model gateway in worktree mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-worktree-codex-provider-'));
    const envFile = join(directory, 'executor-codex.env');
    const codexHome = join(directory, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(envFile, [
      'OPENAI_API_KEY=provider-secret',
      'OPENAI_BASE_URL=https://provider.invalid/v1',
    ].join('\n'));
    writeFileSync(join(codexHome, 'config.toml'), [
      'model = "deepseek-v4-flash"',
      'model_reasoning_effort = "max"',
      'model_provider = "anyint"',
      '[model_providers.anyint]',
      'base_url = "https://provider.invalid/v1"',
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
    ].join('\n'));
    vi.stubEnv('METACLAW_CODEX_EXECUTOR_ENV_FILE', envFile);
    vi.stubEnv('METACLAW_EXECUTOR_CODEX_HOME', codexHome);
    const { sandbox, create } = sandboxPort('worktree');
    let attemptHome = '';
    let renderedConfig = '';
    create.mockImplementation(async (input: CreateAttemptSandboxInput) => {
      attemptHome = input.environment.CODEX_HOME;
      renderedConfig = readFileSync(join(attemptHome, 'config.toml'), 'utf8');
      const workspaceMount = input.mounts.find(mount => mount.target === '/workspace');
      if (!workspaceMount) throw new Error('workspace mount missing in test');
      const resultPath = join(workspaceMount.source, '.metaclaw', 'results', EXECUTOR_RESULT_FILE_NAME);
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, 'completed');
      return sandboxRecord();
    });
    const codexAgent = {
      ...agentClass(),
      name: 'codex-cli',
      domains: ['coding'],
      capabilities: ['code-editing'],
      runtimeCommand: 'codex',
      permissionProfileId: 'workspace-engineering',
    };
    const adapter = new SandboxedExecutorAdapter(
      codexAgent,
      testRuntimeBinding(codexAgent, sandbox.kind),
      sandbox,
    );

    try {
      const longAttemptId = `attempt_${'x'.repeat(400)}`;
      const result = await adapter.execute(executorInput(directory, longAttemptId));

      expect(result.success).toBe(true);
      expect(renderedConfig).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/u);
      expect(renderedConfig).toContain('model_reasoning_effort = "max"');
      expect(renderedConfig).not.toContain('https://provider.invalid/v1');
      expect(attemptHome).not.toBe(codexHome);
      expect(existsSync(attemptHome)).toBe(false);
      const args = create.mock.calls[0]![0].args;
      expect(args).toContain('danger-full-access');
      expect(args).not.toContain('workspace-write');
      const outputPathIndex = args.indexOf('--output-last-message');
      expect(outputPathIndex).toBeGreaterThanOrEqual(0);
      const outputPath = args[outputPathIndex + 1];
      expect(outputPath).toContain(`/.metaclaw/results/${EXECUTOR_RESULT_FILE_NAME}`);
      expect(outputPath).not.toContain(longAttemptId);
      expect(outputPath.length).toBeLessThan(255);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows a registered generic CLI binding in the worktree backend', async () => {
    const { sandbox, create } = sandboxPort('worktree');
    const customAgent = {
      ...agentClass(),
      name: 'custom-executor',
      runtimeCommand: 'custom-executor',
    };
    const adapter = new SandboxedExecutorAdapter(
      customAgent,
      testRuntimeBinding(customAgent, sandbox.kind),
      sandbox,
    );

    const result = await adapter.execute(executorInput('.'));

    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it('runs the same AgentClass concurrently and aborts only the requested attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-sandbox-concurrency-'));
    const envFile = join(directory, 'executor-pi.env');
    writeFileSync(envFile, [
      'OPENAI_API_KEY=provider-secret',
      'OPENAI_BASE_URL=https://provider.invalid/v1',
    ].join('\n'));
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    preparePiHome(directory);
    const waitResolvers = new Map<string, (exitCode: number) => void>();
    const create = vi.fn(async (input: CreateAttemptSandboxInput) => ({
      runtimeHandle: `worktree:${input.attemptId}`,
      processId: 1_000,
      status: 'created' as const,
      exitCode: null,
      labels: {},
    }));
    const stop = vi.fn().mockResolvedValue(undefined);
    const sandbox: AttemptSandboxPort = {
      create,
      start: vi.fn(async runtimeHandle => ({
        runtimeHandle, processId: 1_000, status: 'running' as const, exitCode: null, labels: {},
      })),
      wait: vi.fn((runtimeHandle: string) => new Promise<number>(resolve => {
        waitResolvers.set(runtimeHandle, resolve);
      })),
      logs: vi.fn().mockResolvedValue('completed'),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue(null),
      stop,
      stopProcess: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      listManaged: vi.fn().mockResolvedValue([]),
    };
    const adapter = new SandboxedExecutorAdapter(agentClass(), testRuntimeBinding(agentClass(), sandbox.kind), sandbox);

    try {
      const first = adapter.execute(executorInput(directory, 'attempt_1', 'subtask_1'));
      const second = adapter.execute(executorInput(directory, 'attempt_2', 'subtask_2'));
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

      adapter.abort('attempt_1');

      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith('worktree:attempt_1');
      waitResolvers.get('worktree:attempt_1')?.(0);
      waitResolvers.get('worktree:attempt_2')?.(0);
      await Promise.all([first, second]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function agentClass(): AgentClass {
  return {
    name: 'pi-agent', kind: 'executor', domains: ['research'], capabilities: ['current-web-research'],
    inputTypes: ['text'], outputTypes: ['text'], strengths: [], weaknesses: [], primaryUseCases: [],
    avoidUseCases: [], intentAffinity: {}, riskLevel: 'medium', harness: null, model: null, skills: [],
    mcpServers: [], plugins: [], runtimeCommand: 'pi', runtimeArgs: [], runtimeCheckCommand: null,
    permissionProfileId: 'public-web-research', projectUrl: null,
  };
}

function sandboxPort(_kind: 'worktree' = 'worktree'): {
  sandbox: AttemptSandboxPort;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (_input: CreateAttemptSandboxInput) => sandboxRecord());
  return {
    create,
    sandbox: {
      kind: 'worktree',
      pathMode: 'native',
      create,
      start: vi.fn().mockResolvedValue({ ...sandboxRecord(), status: 'running' }), wait: vi.fn().mockResolvedValue(0),
      logs: vi.fn().mockResolvedValue('completed'), pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined), inspect: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue(undefined), stopProcess: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      listManaged: vi.fn().mockResolvedValue([]),
    },
  };
}

function sandboxRecord() {
  return {
    runtimeHandle: 'worktree:attempt_1', processId: 1_000, status: 'created' as const,
    exitCode: null, labels: {},
  };
}

function piRuntimeBinding(
  binaryPath: string,
  runtimeHome: string,
  environmentFile: string,
): RuntimeExecutorBinding {
  return {
    id: 'pi-agent',
    configDigest: 'test-config',
    driver: 'pi',
    ...runtimeContractForDriver('pi', null),
    binaryPath,
    versionArgs: ['--version'],
    runtimeHome,
    environmentFiles: [environmentFile],
    inheritEnvironment: [],
    permissionProfileId: 'public-web-research',
    sessionProtocol: null,
  };
}

function preparePiHome(root: string): string {
  const piHome = join(root, 'pi-home');
  const agentHome = join(piHome, '.pi', 'agent');
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(join(agentHome, 'models.json'), JSON.stringify({
    providers: { anyint: { baseUrl: 'https://provider.invalid/v1' } },
  }));
  writeFileSync(join(agentHome, 'settings.json'), '{}');
  vi.stubEnv('METACLAW_EXECUTOR_PI_HOME', piHome);
  return piHome;
}

function testRuntimeBinding(
  executor: AgentClass,
  _backend: AttemptSandboxPort['kind'],
): RuntimeExecutorBinding {
  const command = executor.runtimeCommand ?? executor.name;
  const driver = command === 'codex'
    ? 'codex'
    : command === 'pi'
      ? 'pi'
      : 'cli-session';
  const sessionProtocol = driver === 'cli-session'
    ? {
        initialArgs: [...executor.runtimeArgs],
        resumeArgs: [...executor.runtimeArgs],
        sessionIdPattern: 'session[_-]?id[:=]\\s*([^\\s]+)',
        finalOutputPattern: null,
        timeoutMs: 120_000,
        terminateSignal: 'SIGTERM' as const,
      }
    : null;
  return {
    id: executor.name,
    configDigest: 'test-config',
    driver,
    ...runtimeContractForDriver(driver, sessionProtocol),
    binaryPath: command,
    versionArgs: ['--version'],
    runtimeHome: driver === 'codex'
      ? process.env.METACLAW_EXECUTOR_CODEX_HOME ?? '/tmp/codex-home'
      : process.env.METACLAW_EXECUTOR_PI_HOME ?? '/tmp/pi-home',
    environmentFiles: [
      ...(driver === 'codex' && process.env.METACLAW_CODEX_EXECUTOR_ENV_FILE
        ? [process.env.METACLAW_CODEX_EXECUTOR_ENV_FILE]
        : []),
      ...(driver === 'pi' && process.env.METACLAW_PI_EXECUTOR_ENV_FILE
        ? [process.env.METACLAW_PI_EXECUTOR_ENV_FILE]
        : []),
    ],
    inheritEnvironment: [],
    permissionProfileId: executor.permissionProfileId ?? 'restricted-custom',
    sessionProtocol,
  };
}

function executorInput(
  root: string,
  attemptId = 'attempt_1',
  subtaskId = 'subtask_1',
) {
  return {
    context: {
      taskBackground: { id: 'task_1', title: 'Task', goal: 'Research', instruction: 'background_only' as const },
      currentSubtask: {
        id: subtaskId, title: 'Research', goal: 'Research',
        acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
      },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: root, targetPaths: [] },
      identity: {
        executionId: 'exec_1', taskId: 'task_1', subtaskId,
        attemptId, workUnitId: `work_unit_${attemptId}`,
      },
      completionContract: { marker: '<!-- metaclaw:completion:v4 -->' as const, schemaVersion: 4 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'test' },
    },
    sandbox: {
      attemptId, taskId: 'task_1', generationId: 'generation_1', subtaskId,
      workUnitId: `work_unit_${attemptId}`, leaseToken: `lease_${attemptId}`, idempotencyKey: `attempt:${attemptId}`,
      workspacePath: join(root, `workspace-${subtaskId}`), workspaceId: `workspace_${subtaskId}`, sourcePath: join(root, 'source'),
      inputsPath: join(root, 'inputs'), handoffsPath: join(root, 'handoffs'), gitMetadataPath: null,
      capabilityBinding: null,
    },
  };
}
