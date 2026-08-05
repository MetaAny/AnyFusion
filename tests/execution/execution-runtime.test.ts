import { describe, expect, it, vi } from 'vitest';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import type { AgentClass, Subtask, WorkUnit } from '../../src/core/types.js';
import { ExecutionRuntime, ExecutorRegistry } from '../../src/execution/execution-runtime.js';
import type { AgentClassLookupPort } from '../../src/executor/agent-class-lookup-port.js';
import type { AttemptSandboxPort, CreateAttemptSandboxInput, AttemptSandboxRecord } from '../../src/execution/attempt-sandbox.js';
import { getBuiltinExecutorAgentClasses } from '../../src/executor/builtin-executor-catalog.js';

function createSandbox(overrides: Partial<AttemptSandboxPort> = {}): AttemptSandboxPort {
  const record: AttemptSandboxRecord = {
    containerId: 'container_test',
    imageId: 'sha256:test',
    status: 'created',
    exitCode: null,
    labels: {},
  };
  return {
    resolveImage: vi.fn().mockResolvedValue('sha256:test'),
    create: vi.fn().mockImplementation(async (_input: CreateAttemptSandboxInput) => record),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(0),
    logs: vi.fn().mockResolvedValue('sandbox output'),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(record),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    listManaged: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createAgentClass(name = 'codex-cli'): AgentClass {
  const canonical = getBuiltinExecutorAgentClasses().find(agentClass => agentClass.name === name);
  if (canonical) return canonical;
  return {
    name,
    kind: 'executor',
    domains: ['software'],
    capabilities: ['coding'],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    executionImageRef: null,
    resolvedImageId: null,
    permissionProfileId: null,
    projectUrl: null,
  };
}

function createConfiguredAgentClass(name = 'codex-cli'): AgentClass {
  return {
    ...createAgentClass(name),
    executionImageRef: 'metaclaw/test:latest',
    resolvedImageId: 'sha256:test',
    permissionProfileId: 'workspace-engineering',
  };
}

function createSubtask(): Subtask {
  return {
    id: 'subtask_runtime',
    taskId: 'task_runtime',
    graphRevision: 1,
    generationId: 'gen_runtime',
    title: 'Runtime subtask',
    goal: 'execute runtime subtask',
    status: 'running',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'medium',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
  };
}

function createWorkUnit(agentClassName = 'codex-cli'): WorkUnit {
  return {
    id: 'executor-1',
    agentClassName,
    agentClassKind: 'executor',
    state: 'running',
    claimedTaskId: 'task_runtime',
    claimedSubtaskId: 'subtask_runtime',
    claimedAttemptId: 'attempt_runtime',
    heartbeatAt: '2026-06-22T00:00:00Z',
    leaseExpiresAt: null,
    createdAt: '2026-06-22T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
  };
}

function createSandboxBinding(): NonNullable<ExecutorInput['sandbox']> {
  return {
    attemptId: 'attempt_runtime',
    taskId: 'task_runtime',
    generationId: 'gen_runtime',
    subtaskId: 'subtask_runtime',
    workUnitId: 'executor-1',
    leaseToken: 'lease_runtime',
    idempotencyKey: 'idem_runtime',
    workspacePath: process.cwd(),
    workspaceId: 'workspace_runtime',
    sourcePath: process.cwd(),
    inputsPath: process.cwd(),
    handoffsPath: process.cwd(),
    gitMetadataPath: null,
    controlNetwork: 'metaclaw-control',
    capabilityBinding: null,
    onContainerCreated: undefined,
  };
}

function createExecutorInput(withSandbox = true): Omit<ExecutorInput, 'onProgress'> {
  const subtask = createSubtask();
  return {
    context: {
      taskBackground: { id: 'task_runtime', title: 'runtime task', goal: 'execute runtime task', instruction: 'background_only' },
      currentSubtask: {
        id: subtask.id, title: subtask.title, goal: subtask.goal,
        deliveryKind: subtask.deliveryKind, acceptance: subtask.acceptance,
      },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: process.cwd(), targetPaths: [] },
      identity: {
        executionId: 'exec_runtime', taskId: 'task_runtime', subtaskId: subtask.id,
        attemptId: 'attempt_runtime', workUnitId: 'executor-1',
      },
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->', schemaVersion: 2 },
      evidenceTools: { availability: 'unavailable', reason: 'unit test' },
    },
    ...(withSandbox ? { sandbox: createSandboxBinding() } : {}),
  };
}

function createLookup(agentClasses: AgentClass[]): AgentClassLookupPort {
  const byName = new Map(agentClasses.map(agentClass => [agentClass.name, agentClass]));
  return {
    findByName: name => byName.get(name) ?? null,
    listAgentClasses: () => [...byName.values()],
    setResolvedImageId: (name, imageId) => {
      const existing = byName.get(name);
      if (existing) byName.set(name, { ...existing, resolvedImageId: imageId });
    },
  };
}

function createRegistry(agentClasses: AgentClass[], sandbox: AttemptSandboxPort): ExecutorRegistry {
  return new ExecutorRegistry({ agentClassLookup: createLookup(agentClasses), attemptSandbox: sandbox });
}

describe('ExecutionRuntime', () => {
  it('returns a class-level configuration failure when no AgentClass is bound', async () => {
    const registry = createRegistry([], createSandbox());
    const runtime = new ExecutionRuntime(registry);
    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_unbound',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('unbound-agent'),
        agentClass: createAgentClass('unbound-agent'),
        acceptance: [],
        deliveryKind: 'report',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'failed',
      executorName: 'unbound-agent',
      failure: { kind: 'configuration', scope: 'agent_class', code: 'executor_adapter_unbound' },
    });
  });

  it('resolves a configured AgentClass to a sandboxed adapter and reports sandbox binding source', () => {
    const registry = createRegistry([createConfiguredAgentClass('codex-cli')], createSandbox());
    expect(registry.resolve('codex-cli')?.name).toBe('codex-cli');
    expect(registry.inspect('codex-cli')).toEqual({
      configured: true,
      bindingSource: 'sandbox',
      adapterName: 'codex-cli',
    });
  });

  it('reports unbound when the AgentClass has no verified image or permission profile', () => {
    const registry = createRegistry([createAgentClass('codex-cli')], createSandbox());
    expect(registry.inspect('codex-cli')).toEqual({
      configured: false,
      bindingSource: 'unbound',
      adapterName: null,
    });
  });

  it('resolves and caches the image id for an AgentClass with an unresolved image ref', async () => {
    const unresolved: AgentClass = {
      ...createAgentClass('codex-cli'),
      executionImageRef: 'metaclaw/test:latest',
      resolvedImageId: null,
      permissionProfileId: 'workspace-engineering',
    };
    const lookup = createLookup([unresolved]);
    const sandbox = createSandbox();
    const registry = new ExecutorRegistry({ agentClassLookup: lookup, attemptSandbox: sandbox });

    await expect(registry.probe('codex-cli')).resolves.toEqual({
      available: true,
      failure: null,
    });
    expect(sandbox.resolveImage).toHaveBeenCalledWith('metaclaw/test:latest');
    expect(lookup.findByName('codex-cli')?.resolvedImageId).toBe('sha256:test');
  });

  it('preserves image resolution failures for the WorkUnit probe audit', async () => {
    const unresolved: AgentClass = {
      ...createAgentClass('codex-cli'),
      executionImageRef: 'metaclaw/test:latest',
      resolvedImageId: null,
      permissionProfileId: 'workspace-engineering',
    };
    const sandbox = createSandbox({
      resolveImage: vi.fn().mockRejectedValue(
        new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
      ),
    });
    const registry = createRegistry([unresolved], sandbox);

    await expect(registry.probe('codex-cli')).resolves.toMatchObject({
      available: false,
      failure: {
        code: 'executor_image_probe_failed',
        summary: expect.stringContaining('Cannot connect to the Docker daemon'),
      },
    });
  });

  it('is unavailable when the AgentClass does not exist', async () => {
    const registry = createRegistry([], createSandbox());
    await expect(registry.probe('missing')).resolves.toMatchObject({
      available: false,
      failure: { code: 'agent_class_not_found' },
    });
  });

  it('runs a claimed subtask through the sandboxed adapter for the claimed AgentClass', async () => {
    const sandbox = createSandbox();
    const registry = createRegistry([createConfiguredAgentClass('pi-agent')], sandbox);
    const runtime = new ExecutionRuntime(registry);
    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('pi-agent'),
        agentClass: createConfiguredAgentClass('pi-agent'),
        acceptance: [],
        deliveryKind: 'report',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.executorName).toBe('pi-agent');
    expect(result).toMatchObject({ status: 'success', error: null });
    expect(sandbox.create).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt_runtime',
      imageRef: 'metaclaw/test:latest',
      resolvedImageId: 'sha256:test',
    }));
  });

  it('fails closed when the sandbox adapter reports a failure', async () => {
    const sandbox = createSandbox({ wait: vi.fn().mockResolvedValue(1), logs: vi.fn().mockResolvedValue('boom') });
    const registry = createRegistry([createConfiguredAgentClass('codex-cli')], sandbox);
    const runtime = new ExecutionRuntime(registry);
    const result = await runtime.run({
      taskId: 'task_runtime',
      executionId: 'exec_runtime',
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('codex-cli'),
        agentClass: createConfiguredAgentClass('codex-cli'),
        acceptance: [],
        deliveryKind: 'report',
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    expect(result.status).toBe('failed');
  });

  it('resolves a fresh adapter per run and tracks aborts per task token', async () => {
    const registry = createRegistry([createConfiguredAgentClass('codex-cli')], createSandbox());
    const runtime = new ExecutionRuntime(registry);
    const input = (executionId: string, taskId: string) => ({
      taskId,
      executionId,
      spec: {
        subtask: createSubtask(),
        workUnit: createWorkUnit('codex-cli'),
        agentClass: createConfiguredAgentClass('codex-cli'),
        acceptance: [],
        deliveryKind: 'report' as const,
      },
      executorInput: createExecutorInput(),
      onProgress: vi.fn(),
    });

    // Each run resolves its own adapter, then registers and clears its own abort token.
    const [first, second] = await Promise.all([
      runtime.run(input('exec_first', 'task_first')),
      runtime.run(input('exec_second', 'task_second')),
    ]);
    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    // Tokens were cleared after completion, so nothing remains to abort.
    expect(runtime.abortTask('task_first')).toBe(0);
    expect(runtime.abortTask('task_second')).toBe(0);
  });
});
