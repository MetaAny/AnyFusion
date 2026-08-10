import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import type { AgentClass, Subtask, WorkUnit } from '../../src/core/types.js';
import { ExecutionRuntime, ExecutorRegistry } from '../../src/execution/execution-runtime.js';
import type { AgentClassLookupPort } from '../../src/executor/agent-class-lookup-port.js';
import type { AttemptSandboxPort, CreateAttemptSandboxInput, AttemptSandboxRecord } from '../../src/execution/attempt-sandbox.js';
import { testExecutorAgentClasses } from '../support/executor-registry.js';
import { createTestExecutorRegistrySnapshot } from '../../src/executor/test-executor-registry.js';

function createSandbox(overrides: Partial<AttemptSandboxPort> = {}): AttemptSandboxPort {
  const record: AttemptSandboxRecord = {
    runtimeHandle: 'worktree:attempt_test',
    processId: 1234,
    status: 'created',
    exitCode: null,
    labels: {},
  };
  return {
    create: vi.fn().mockImplementation(async (_input: CreateAttemptSandboxInput) => record),
    start: vi.fn().mockResolvedValue(record),
    wait: vi.fn().mockResolvedValue(0),
    logs: vi.fn().mockResolvedValue('sandbox output'),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(record),
    stop: vi.fn().mockResolvedValue(undefined),
    stopProcess: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    listManaged: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createAgentClass(name = 'codex-cli'): AgentClass {
  const canonical = testExecutorAgentClasses().find(agentClass => agentClass.name === name);
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
    permissionProfileId: null,
    projectUrl: null,
  };
}

function createConfiguredAgentClass(name = 'codex-cli'): AgentClass {
  return {
    ...createAgentClass(name),
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
    capabilityBinding: null,
    onRuntimeStarted: undefined,
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
  };
}

function createRegistry(agentClasses: AgentClass[], sandbox: AttemptSandboxPort): ExecutorRegistry {
  const snapshot = createRuntimeSnapshot(agentClasses);
  return new ExecutorRegistry({
    agentClassLookup: createLookup(agentClasses),
    snapshot: () => snapshot,
    attemptSandbox: sandbox,
  });
}

function createRuntimeSnapshot(agentClasses: AgentClass[]) {
  const snapshot = createTestExecutorRegistrySnapshot();
  const runtimeRoot = '/tmp/metaclaw-execution-runtime-test';
  const piHome = join(runtimeRoot, 'pi-home');
  const codexHome = join(runtimeRoot, 'codex-home');
  const envFile = join(runtimeRoot, 'executor.env');
  mkdirSync(join(piHome, '.pi', 'agent'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(envFile, 'OPENAI_API_KEY=test-key\nOPENAI_BASE_URL=https://provider.invalid/v1\n');
  writeFileSync(join(piHome, '.pi', 'agent', 'models.json'), JSON.stringify({
    providers: { anyint: { baseUrl: 'https://provider.invalid/v1' } },
  }));
  writeFileSync(join(piHome, '.pi', 'agent', 'settings.json'), '{}');
  writeFileSync(join(codexHome, 'config.toml'), 'base_url = "https://provider.invalid/v1"\n');
  const routable = new Set(agentClasses
    .filter(agentClass => agentClass.permissionProfileId)
    .map(agentClass => agentClass.name));
  return {
    ...snapshot,
    runtime: new Map([...snapshot.runtime]
      .filter(([name]) => routable.has(name))
      .map(([name, binding]) => [name, {
        ...binding,
        runtimeHome: binding.driver === 'pi' ? piHome : codexHome,
        environmentFiles: [envFile],
      }])),
  };
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
      bindingSource: 'worktree',
      adapterName: 'codex',
    });
  });

  it('reports unbound when the AgentClass has no verified Registry binding or permission profile', () => {
    const registry = createRegistry([createAgentClass('custom-unbound')], createSandbox());
    expect(registry.inspect('custom-unbound')).toEqual({
      configured: false,
      bindingSource: 'unbound',
      adapterName: null,
    });
  });

  it('fails closed when the verified Registry snapshot has no runtime binding', async () => {
    const unresolved: AgentClass = {
      ...createAgentClass('codex-cli'),
      permissionProfileId: 'workspace-engineering',
    };
    const lookup = createLookup([unresolved]);
    const sandbox = createSandbox();
    const snapshot = createRuntimeSnapshot([]);
    const registry = new ExecutorRegistry({
      agentClassLookup: lookup,
      snapshot: () => snapshot,
      attemptSandbox: sandbox,
    });

    await expect(registry.probe('codex-cli')).resolves.toMatchObject({
      available: false,
      failure: { code: 'executor_not_routable' },
    });
  });

  it('does not create a Runtime after the Registry binding fails closed', async () => {
    const unresolved: AgentClass = {
      ...createAgentClass('codex-cli'),
      permissionProfileId: 'workspace-engineering',
    };
    const sandbox = createSandbox();
    const registry = new ExecutorRegistry({
      agentClassLookup: createLookup([unresolved]),
      snapshot: () => createRuntimeSnapshot([]),
      attemptSandbox: sandbox,
    });

    await expect(registry.probe('codex-cli')).resolves.toMatchObject({
      available: false,
      failure: {
        code: 'executor_not_routable',
      },
    });
    expect(sandbox.create).not.toHaveBeenCalled();
  });

  it('is unavailable when the AgentClass does not exist', async () => {
    const registry = createRegistry([], createSandbox());
    await expect(registry.probe('missing')).resolves.toMatchObject({
      available: false,
      failure: { code: 'executor_not_routable' },
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
      command: '/usr/bin/pi',
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
