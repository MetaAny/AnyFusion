import type { KernelDecision, KernelEvent } from '../kernel/control-kernel.js';
import type { KernelRuntime } from '../kernel/kernel-workflow.js';
import type { MemoryContextService } from '../memory/memory-context-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { ActiveExecutionControl } from '../execution/active-execution-control.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { SessionPresentationService } from './session-presentation-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { TaskClearScope, TaskStatusQueryScope } from '../task/task-control-types.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionKernelRuntimeDeps {
  sessionId: string;
  taskRuntimeService: TaskRuntimeService;
  memoryContextService: MemoryContextService;
  orchestration: OrchestrationEngine;
  activeExecutions: ActiveExecutionControl;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    deliverDirectReply(userInput: string, reply: string): void;
    prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): void;
    refreshRuntimeState(): void;
    setCurrentTaskId(taskId: string | null): void;
    getCurrentTaskId(): string | null;
    setFocusContext(focus: FocusContext | null): void;
    resolveRequestText(eventId: string): string;
    cancelTask(taskId: string, reason: string): Promise<void>;
  };
}

/** Session-side Runtime handlers for Kernel decisions; it contains no next-action policy. */
export class SessionKernelRuntime {
  constructor(private readonly deps: SessionKernelRuntimeDeps) {}

  forInput(userInput?: string): KernelRuntime {
    return {
      apply: decision => this.apply(
        decision,
        userInput ?? this.deps.callbacks.resolveRequestText(decision.eventId),
      ),
    };
  }

  private async apply(decision: KernelDecision, userInput: string): Promise<KernelEvent | null> {
    switch (decision.action.type) {
      case 'reject_request':
        this.deps.callbacks.appendOutput(this.deps.presentation.formatKernelRejection(decision.reason));
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'request_clarification':
        this.deps.callbacks.appendOutput(`MetaClaw: ${decision.action.question}`);
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'deliver_direct_reply':
        this.deps.callbacks.deliverDirectReply(userInput, decision.action.response);
        return null;
      case 'no_op':
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'authorize_task_control':
        await this.applyTaskControl(decision, userInput);
        return null;
      case 'authorize_task_plan':
        await this.applyTaskPlan(decision, userInput);
        return null;
      case 'record_permission_resolution':
        return null;
      case 'block_work': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (task?.status === 'running') {
          this.deps.taskRuntimeService.blockTask(task.id, {
            taskId: task.id, type: 'manual', description: decision.reason, status: 'waiting',
          });
        }
        this.deps.callbacks.refreshRuntimeState();
        return null;
      }
      case 'park_for_replan': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (task && task.status !== 'parked') this.deps.taskRuntimeService.transitionTask(task.id, 'parked');
        return null;
      }
      case 'wait_for_capacity':
      case 'wait_for_retry':
      case 'probe_capacity':
      case 'dispatch_batch':
      case 'complete_task':
      case 'request_replan':
      case 'queue_generation_replan':
      case 'request_merge_replan':
      case 'cancel_task':
      case 'cancel_subtasks':
      case 'accept_partial_result':
      case 'resolve_recovery':
      case 'grant_capability':
      case 'deny_capability':
      case 'escalate_capability':
      case 'wait_for_partition':
      case 'recover_workspace_attempt':
      case 'defer_task_plan_for_availability':
      case 'activate_deferred_task_plan':
        throw new Error(`${decision.action.type} must be applied by the execution Runtime`);
    }
  }

  private async applyTaskControl(
    decision: Extract<KernelDecision, { action: { type: 'authorize_task_control' } }> | KernelDecision,
    userInput: string,
  ): Promise<void> {
    if (decision.action.type !== 'authorize_task_control') return;
    const taskCommand = decision.action.task;
    if (taskCommand.control === 'status_query') {
      const scope = normalizeStatusScope(taskCommand.scope);
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskStatus({
        scope,
        blockedTasks: this.deps.orchestration.getBlockedTasks(),
        runningTask: this.deps.taskRuntimeService.listTasksByStatus('running')[0] ?? null,
        activeTasks: this.deps.taskRuntimeService.listActiveTasks(),
        latestDone: this.deps.taskRuntimeService.listTasksByStatus('done')[0] ?? null,
        dashboard: this.deps.orchestration.getDashboard(),
      }));
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
    if (taskCommand.control === 'clear_tasks') {
      const scope = normalizeClearScope(taskCommand.scope);
      const statuses = scope === 'all'
        ? ['created', 'ready', 'running', 'parked', 'blocked']
        : [scope];
      const candidates = this.deps.taskRuntimeService.listTasks()
        .filter(task => statuses.includes(task.status));
      for (const task of candidates) {
        await this.deps.callbacks.cancelTask(
          task.id,
          `Planner-authorized clear_tasks (${scope})`,
        );
      }
      const result = { cancelled: candidates, runningCancelled: candidates.some(task => task.status === 'running') };
      if (result.cancelled.some(task => task.id === this.deps.callbacks.getCurrentTaskId())) {
        this.deps.callbacks.setCurrentTaskId(null);
        this.deps.callbacks.setFocusContext(null);
      }
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskClearResult({ scope, ...result }));
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
    if (!taskCommand.taskId) throw new Error('authorized executable task control requires taskId');
    const task = this.deps.taskRuntimeService.findTask(taskCommand.taskId);
    if (!task) throw new Error(`task not found: ${taskCommand.taskId}`);
    this.deps.callbacks.setCurrentTaskId(task.id);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
    this.deps.callbacks.prepareTaskExecution(task.id, buildExecutionRequest({
      userInput,
      taskId: task.id,
      executionMode: task.status === 'blocked' ? 'resume-blocked' : 'resume-parked',
      decision,
    }));
  }

  private async applyTaskPlan(
    decision: Extract<KernelDecision, { action: { type: 'authorize_task_plan' } }> | KernelDecision,
    userInput: string,
  ): Promise<void> {
    if (decision.action.type !== 'authorize_task_plan') return;
    const command = decision.action.task;
    const inline = this.deps.memoryContextService.normalizeInlineResourcesFromInput(userInput);
    const task = command.taskId
      ? this.deps.taskRuntimeService.findTask(command.taskId)
      : this.deps.taskRuntimeService.createTask({
          id: decision.action.taskId,
          title: (command.title ?? inline.normalizedGoal).slice(0, 50),
          goal: command.goal ?? inline.normalizedGoal,
          resources: inline.resources,
        });
    if (!task) throw new Error(`task not found: ${command.taskId}`);
    if (command.priority) {
      this.deps.taskRuntimeService.updateTask(task.id, {
        prioritySignals: {
          ...task.prioritySignals,
          semanticPriority: command.priority.level,
          semanticPriorityReason: command.priority.reason,
        },
      });
    }
    this.deps.callbacks.setCurrentTaskId(task.id);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
    this.deps.callbacks.prepareTaskExecution(task.id, {
      ...buildExecutionRequest({ userInput, taskId: task.id, executionMode: 'fresh', decision }),
      authorizedWorkGraph: decision.action.workGraph,
      workGraphAuthorization: {
        decisionId: decision.id,
        generationId: decision.action.generationId,
        revision: decision.action.graphRevision,
        source: decision.action.proposalSource,
        automaticReplan: decision.action.proposalSource === 'replan',
      },
      includeRecentConversationContext: command.includeRecentConversationContext,
    });
  }
}

function buildExecutionRequest(input: {
  userInput: string;
  taskId: string;
  executionMode: QueuedExecutionRequest['executionMode'];
  decision: KernelDecision;
}): QueuedExecutionRequest {
  return {
    userPrompt: input.userInput,
    contextTaskId: input.taskId,
    executionMode: input.executionMode,
    kernelDecisionId: input.decision.id,
    schedulingReason: input.decision.reason,
  };
}

function normalizeStatusScope(scope: string | null): TaskStatusQueryScope {
  if (scope === 'blocked' || scope === 'running' || scope === 'dashboard') return scope;
  throw new Error(`Invalid status scope: ${String(scope)}`);
}

function normalizeClearScope(scope: string | null): TaskClearScope {
  if (scope === 'parked' || scope === 'blocked' || scope === 'all') return scope;
  throw new Error(`Invalid clear scope: ${String(scope)}`);
}
