import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentClass } from '../../src/core/types.js';
import type { AttemptSandboxPort, CreateAttemptSandboxInput } from '../../src/execution/attempt-sandbox.js';
import { SandboxedExecutorAdapter } from '../../src/executor/sandboxed-executor-adapter.js';

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
    vi.stubEnv('METACLAW_CONTROL_HOST', 'metaclaw-control');
    const { sandbox, create } = sandboxPort();
    const adapter = new SandboxedExecutorAdapter(agentClass(), sandbox);

    try {
      const result = await adapter.execute(executorInput(directory));

      expect(result.success).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      const environment = create.mock.calls[0]![0].environment;
      expect(environment.OPENAI_API_KEY).toBeTruthy();
      expect(environment.OPENAI_API_KEY).not.toBe('openai-provider-secret');
      expect(environment.OPENAI_BASE_URL).toMatch(/^http:\/\/metaclaw-control:\d+\/v1$/u);
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
    const adapter = new SandboxedExecutorAdapter(agentClass(), sandbox);

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
      return sandboxRecord('sha256:pi');
    });
    const adapter = new SandboxedExecutorAdapter(agentClass(), sandbox);

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

  it('uses the native Pi attempt extension path when configured', async () => {
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
    const adapter = new SandboxedExecutorAdapter(agentClass(), sandbox);

    try {
      const result = await adapter.execute(executorInput(directory));

      expect(result.success).toBe(true);
      const args = create.mock.calls[0]![0].args;
      expect(args).toContain('/native/anyfusion/pi-attempt-tools.ts');
      expect(args).not.toContain('/opt/metaclaw/pi-attempt-tools.ts');
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
      'model = "gpt-5.6-terra"',
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
      return sandboxRecord('sha256:codex');
    });
    const adapter = new SandboxedExecutorAdapter({
      ...agentClass(),
      name: 'codex-cli',
      domains: ['coding'],
      capabilities: ['code-editing'],
      runtimeCommand: 'codex',
      executionImageRef: 'metaclaw-executor-codex:phase5',
      resolvedImageId: 'sha256:codex',
      permissionProfileId: 'workspace-engineering',
    }, sandbox);

    try {
      const result = await adapter.execute(executorInput(directory));

      expect(result.success).toBe(true);
      expect(renderedConfig).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/u);
      expect(renderedConfig).not.toContain('https://provider.invalid/v1');
      expect(attemptHome).not.toBe(codexHome);
      expect(existsSync(attemptHome)).toBe(false);
      const args = create.mock.calls[0]![0].args;
      expect(args).toContain('danger-full-access');
      expect(args).not.toContain('workspace-write');
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects noncanonical AgentClasses in the worktree backend', async () => {
    const { sandbox, create } = sandboxPort('worktree');
    const adapter = new SandboxedExecutorAdapter({
      ...agentClass(),
      name: 'custom-executor',
      runtimeCommand: 'custom-executor',
    }, sandbox);

    const result = await adapter.execute(executorInput('.'));

    expect(result).toMatchObject({
      success: false,
      failure: { code: 'worktree_executor_not_canonical' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('runs the same AgentClass concurrently and aborts only the requested attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-sandbox-concurrency-'));
    const envFile = join(directory, 'executor-pi.env');
    writeFileSync(envFile, [
      'OPENAI_API_KEY=provider-secret',
      'OPENAI_BASE_URL=https://provider.invalid/v1',
    ].join('\n'));
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    const waitResolvers = new Map<string, (exitCode: number) => void>();
    const create = vi.fn(async (input: CreateAttemptSandboxInput) => ({
      containerId: `container_${input.attemptId}`,
      imageId: 'sha256:pi',
      status: 'created' as const,
      exitCode: null,
      labels: {},
    }));
    const stop = vi.fn().mockResolvedValue(undefined);
    const sandbox: AttemptSandboxPort = {
      resolveImage: vi.fn().mockResolvedValue('sha256:pi'),
      create,
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn((containerId: string) => new Promise<number>(resolve => {
        waitResolvers.set(containerId, resolve);
      })),
      logs: vi.fn().mockResolvedValue('completed'),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue(null),
      stop,
      remove: vi.fn().mockResolvedValue(undefined),
      listManaged: vi.fn().mockResolvedValue([]),
    };
    const adapter = new SandboxedExecutorAdapter(agentClass(), sandbox);

    try {
      const first = adapter.execute(executorInput(directory, 'attempt_1', 'subtask_1'));
      const second = adapter.execute(executorInput(directory, 'attempt_2', 'subtask_2'));
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

      adapter.abort('attempt_1');

      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith('container_attempt_1');
      waitResolvers.get('container_attempt_1')?.(0);
      waitResolvers.get('container_attempt_2')?.(0);
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
    executionImageRef: 'metaclaw-executor-pi:phase5', resolvedImageId: 'sha256:pi',
    permissionProfileId: 'public-web-research', projectUrl: null,
  };
}

function sandboxPort(kind: 'container' | 'worktree' = 'container'): {
  sandbox: AttemptSandboxPort;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (_input: CreateAttemptSandboxInput) => sandboxRecord('sha256:pi'));
  return {
    create,
    sandbox: {
      kind,
      pathMode: kind === 'worktree' ? 'native' : 'container',
      resolveImage: vi.fn().mockResolvedValue('sha256:pi'), create,
      start: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(0),
      logs: vi.fn().mockResolvedValue('completed'), pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined), inspect: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined),
      listManaged: vi.fn().mockResolvedValue([]),
    },
  };
}

function sandboxRecord(imageId: string) {
  return {
    containerId: 'container_1', imageId, status: 'created' as const,
    exitCode: null, labels: {},
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
        id: subtaskId, title: 'Research', goal: 'Research', deliveryKind: 'report' as const,
        acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
      },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: root, targetPaths: [] },
      identity: {
        executionId: 'exec_1', taskId: 'task_1', subtaskId,
        attemptId, workUnitId: `work_unit_${attemptId}`,
      },
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->' as const, schemaVersion: 2 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'test' },
    },
    sandbox: {
      attemptId, taskId: 'task_1', generationId: 'generation_1', subtaskId,
      workUnitId: `work_unit_${attemptId}`, leaseToken: `lease_${attemptId}`, idempotencyKey: `attempt:${attemptId}`,
      workspacePath: join(root, `workspace-${attemptId}`), workspaceId: `workspace_${subtaskId}`, sourcePath: join(root, 'source'),
      inputsPath: join(root, 'inputs'), handoffsPath: join(root, 'handoffs'), gitMetadataPath: null,
      controlNetwork: 'metaclaw-control', capabilityBinding: null,
    },
  };
}
