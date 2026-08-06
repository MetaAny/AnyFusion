// Resolves executor adapters and runs claimed subtask specs through the execution result normalization path.
import type {
  ExecutorAdapter,
  ExecutorInput,
  ExecutorProbeResult,
  ExecutorProgressEvent,
} from '../executor/adapter.js';
import type { AgentClass, ExecutorResult, ResolvedPreference, Subtask, WorkUnit } from '../core/types.js';
import type { SubtaskExecutionContext } from './subtask-execution-context.js';
import type { SubtaskResult } from './execution-aggregator.js';
import type { ActiveExecutionControl } from './active-execution-control.js';
import type { WorkGraphAcceptanceCriterion } from '../work-graph/index.js';
import { kernelFailure, type KernelFailure } from '../core/kernel-failure.js';
import type { AgentClassLookupPort } from '../executor/agent-class-lookup-port.js';
import type { AttemptSandboxPort } from './attempt-sandbox.js';
import { SandboxedExecutorAdapter } from '../executor/sandboxed-executor-adapter.js';
import type { AttemptSandboxRepositoryPort } from './repositories.js';

// Shared normalized result of running a task's work graph. Previously exported by
// the retired core/execution-planning-service module; kept here on the live path.
// Recovery strategy is not represented here: the Adapter emits a structured
// KernelFailure and ControlKernel alone decides retry, fallback, replan or block.
export interface ExecutionResult {
  taskId: string;
  executionId: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  executorName: string;
  output: string;
  error: string | null;
  failure: KernelFailure | null;
  artifacts: string[];
  subtaskResults: SubtaskResult[];
  durationMs: number;
  userPrompt: string;
  preferences: ResolvedPreference[];
  context: SubtaskExecutionContext;
}

export interface ExecutorRegistryDeps {
  agentClassLookup: AgentClassLookupPort;
  attemptSandbox: AttemptSandboxPort;
  attemptSandboxRepository?: AttemptSandboxRepositoryPort;
  controlNetwork?: string;
}

export interface ExecutorRegistrationInspection {
  configured: boolean;
  bindingSource: 'sandbox' | 'worktree' | 'unbound';
  adapterName: string | null;
}

/** Resolves AgentClasses to the canonical executor adapter and active backend. */
export class ExecutorRegistry {
  constructor(private readonly deps: ExecutorRegistryDeps) {}

  resolve(name: string): ExecutorAdapter | null {
    const agentClass = this.deps.agentClassLookup.findByName(name);
    return agentClass
      ? new SandboxedExecutorAdapter(agentClass, this.deps.attemptSandbox, this.deps.attemptSandboxRepository)
      : null;
  }

  inspect(name: string): ExecutorRegistrationInspection {
    const agentClass = this.deps.agentClassLookup.findByName(name);
    const worktree = (this.deps.attemptSandbox.kind ?? 'container') === 'worktree';
    const configured = Boolean(
      agentClass?.permissionProfileId
      && (worktree
        ? ['codex-cli', 'pi-agent'].includes(name)
        : agentClass.executionImageRef && agentClass.resolvedImageId),
    );
    return {
      configured,
      bindingSource: configured ? worktree ? 'worktree' : 'sandbox' : 'unbound',
      adapterName: configured ? name : null,
    };
  }

  async probe(name: string, previousFailure?: KernelFailure | null): Promise<ExecutorProbeResult> {
    const agentClass = this.deps.agentClassLookup.findByName(name);
    if (!agentClass) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'agent_class_not_found',
          summary: `AgentClass ${name} is not registered`,
        },
      };
    }
    const worktree = (this.deps.attemptSandbox.kind ?? 'container') === 'worktree';
    if (worktree && !['codex-cli', 'pi-agent'].includes(name)) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'worktree_executor_not_canonical',
          summary: `Worktree execution supports only canonical Codex and Pi AgentClasses: ${name}`,
        },
      };
    }
    if (!worktree && agentClass.executionImageRef && !agentClass.resolvedImageId) {
      try {
        const imageId = await this.deps.attemptSandbox.resolveImage(agentClass.executionImageRef);
        if (!imageId.startsWith('sha256:')) {
          return {
            available: false,
            failure: {
              kind: 'configuration',
              scope: 'agent_class',
              code: 'executor_image_not_immutable',
              summary: `Executor image for ${name} did not resolve to an immutable image ID`,
            },
          };
        }
        this.deps.agentClassLookup.setResolvedImageId?.(name, imageId);
      } catch (error) {
        return {
          available: false,
          failure: {
            kind: 'adapter',
            scope: 'agent_class',
            code: 'executor_image_probe_failed',
            summary: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    const adapter = this.resolve(name);
    if (!adapter) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'executor_adapter_unbound',
          summary: `No Executor Adapter is configured for AgentClass ${name}`,
        },
      };
    }
    if (!worktree) {
      try {
        await this.deps.attemptSandbox.probeControlNetwork?.(
          this.deps.controlNetwork ?? process.env.METACLAW_CONTROL_NETWORK ?? 'metaclaw-control',
        );
      } catch (error) {
        return {
          available: false,
          failure: {
            kind: 'adapter',
            scope: 'agent_class',
            code: 'executor_control_network_unavailable',
            summary: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    return adapter.probe(previousFailure);
  }
}

export interface ExecutionRuntimeRunInput {
  taskId: string;
  executionId: string;
  spec: SubtaskExecutionSpec;
  executorInput: Omit<ExecutorInput, 'onProgress'>;
  onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;
}

export interface SubtaskExecutionSpec {
  subtask: Subtask;
  workUnit: WorkUnit;
  agentClass: AgentClass;
  acceptance: WorkGraphAcceptanceCriterion[];
  deliveryKind: Subtask['deliveryKind'];
}

/** Runs a claimed subtask with its selected executor and converts adapter output into the shared ExecutionResult shape. */
export class ExecutionRuntime implements ActiveExecutionControl {
  private readonly activeByTask = new Map<string, Map<string, {
    attemptId: string;
    workUnitId: string;
    executor: ExecutorAdapter;
  }>>();
  private executionTokenSequence = 0;

  constructor(private readonly registry: ExecutorRegistry) {}

  async isExecutorAvailable(name: string): Promise<boolean> {
    return (await this.registry.probe(name)).available;
  }

  probeExecutor(name: string, previousFailure?: KernelFailure | null): Promise<ExecutorProbeResult> {
    return this.registry.probe(name, previousFailure);
  }

  supportsResponseOnly(name: string): boolean {
    return typeof this.registry.resolve(name)?.executeResponseOnly === 'function';
  }

  supportsContinuation(name: string): boolean {
    return this.registry.resolve(name)?.supportsContinuation === true;
  }

  async runResponseOnly(agentClassName: string, prompt: string, maxBytes: number) {
    const executor = this.registry.resolve(agentClassName);
    if (!executor?.executeResponseOnly) return null;
    return executor.executeResponseOnly({ prompt, maxBytes });
  }

  inspectExecutorRegistration(name: string): ExecutorRegistrationInspection {
    return this.registry.inspect(name);
  }

  async run(input: ExecutionRuntimeRunInput): Promise<ExecutionResult> {
    const executor = this.registry.resolve(input.spec.agentClass.name);
    if (!executor) {
      const summary = `No Executor Adapter is configured for AgentClass ${input.spec.agentClass.name}`;
      return {
        taskId: input.taskId,
        executionId: input.executionId,
        status: 'failed',
        executorName: input.spec.agentClass.name,
        output: '',
        error: summary,
        failure: kernelFailure({
          kind: 'configuration',
          scope: 'agent_class',
          code: 'executor_adapter_unbound',
          summary,
        }),
        artifacts: [],
        subtaskResults: [],
        durationMs: 0,
        userPrompt: input.executorInput.context.currentSubtask.goal,
        preferences: [],
        context: input.executorInput.context,
      };
    }
    const executionToken = `${input.executionId}:${input.spec.workUnit.id}:${this.executionTokenSequence += 1}`;
    this.registerActive(
      input.taskId,
      executionToken,
      input.executorInput.context.identity.attemptId,
      input.spec.workUnit.id,
      executor,
    );
    try {
      const result = await this.executeOnce(
        executor,
        input.executorInput,
        input.onProgress,
      );
      return this.toExecutionResult({
        input,
        executor,
        result,
        subtaskResults: [],
      });
    } finally {
      this.clearActive(input.taskId, executionToken);
    }
  }

  abortAttempt(taskId: string, attemptId: string): boolean {
    const active = this.activeByTask.get(taskId);
    const entry = active
      ? [...active.values()].find(candidate => candidate.attemptId === attemptId)
      : null;
    if (!entry) return false;
    entry.executor.abort(attemptId);
    return true;
  }

  abortTask(taskId: string): number {
    const active = this.activeByTask.get(taskId);
    if (!active || active.size === 0) {
      return 0;
    }

    for (const entry of active.values()) {
      entry.executor.abort(entry.attemptId);
    }
    return active.size;
  }

  private registerActive(
    taskId: string,
    executionToken: string,
    attemptId: string,
    workUnitId: string,
    executor: ExecutorAdapter,
  ): void {
    const active = this.activeByTask.get(taskId) ?? new Map();
    active.set(executionToken, { attemptId, workUnitId, executor });
    this.activeByTask.set(taskId, active);
  }

  private clearActive(taskId: string, executionToken: string): void {
    const active = this.activeByTask.get(taskId);
    if (!active) return;
    active.delete(executionToken);
    if (active.size === 0) {
      this.activeByTask.delete(taskId);
    }
  }

  private toExecutionResult(input: {
    input: ExecutionRuntimeRunInput;
    executor: ExecutorAdapter;
    result: ExecutorResult;
    subtaskResults: SubtaskResult[];
  }): ExecutionResult {
    return {
      taskId: input.input.taskId,
      executionId: input.input.executionId,
      status: input.result.interrupted
        ? 'cancelled'
        : input.result.success ? 'success' : 'failed',
      executorName: input.executor.name,
      output: input.result.output,
      error: input.result.error ?? null,
      failure: input.result.failure ?? null,
      artifacts: input.subtaskResults.flatMap(result => result.artifacts),
      subtaskResults: input.subtaskResults,
      durationMs: input.result.durationMs,
      userPrompt: input.input.executorInput.context.currentSubtask.goal,
      preferences: [],
      context: input.input.executorInput.context,
    };
  }

  private async executeOnce(
    executor: ExecutorAdapter,
    input: Omit<ExecutorInput, 'onProgress'>,
    onProgress: (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void,
  ): Promise<ExecutorResult> {
    let progressCallbackError: Error | null = null;
    try {
      return await executor.execute({
        ...input,
        onProgress: event => {
          try {
            onProgress(event, executor);
          } catch (error) {
            progressCallbackError = error as Error;
            throw error;
          }
        },
      });
    } catch (error) {
      if (progressCallbackError === error) {
        throw error;
      }
      return {
        success: false,
        output: '',
        error: (error as Error).message,
        exitCode: 1,
        durationMs: 0,
      };
    }
  }
}
