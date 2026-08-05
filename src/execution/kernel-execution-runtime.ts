// Execution application service: Session supplies facade callbacks but owns no runtime policy.
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { ExecutionProgressService } from '../execution/execution-progress-service.js';
import type { SessionPersistenceService } from '../session/session-persistence-service.js';
import type { GuidanceProposal, Subtask, Suggestion } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import { generateInteractionId } from '../utils/id.js';
import type { QueuedExecutionRequest } from '../session/session-helpers.js';
import type { SessionPresentationService, GuidanceState } from '../session/session-presentation-service.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';
import type { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import type { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { SubtaskAttemptRunner, SubtaskAttemptOutcome } from '../execution/subtask-attempt-runner.js';
import {
  ControlKernel,
  type KernelAttemptFact,
  type KernelDecision,
  type KernelEvent,
  type KernelSnapshot,
} from '../kernel/control-kernel.js';
import { DurableKernelWorkflow, type KernelWorkflow, type KernelWorkflowStore } from '../kernel/kernel-workflow.js';
import type { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { deriveRecoverySafety } from '../executor/builtin-executor-catalog.js';
import type { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import { buildDefaultResourceClaims } from '../resource/index.js';
import { deriveRunnableFrontier } from '../work-graph/index.js';
import type { KernelDispatchItemRepo, KernelDispatchItemRecord } from '../storage/kernel-dispatch-item-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import { AttemptSupervisor, type AttemptSupervisorContext } from './attempt-supervisor.js';
import type {
  CancellationReceipt,
  TaskCancellationCoordinator,
} from './task-cancellation-coordinator.js';
import type {
  WorkspacePublicationWorker,
  WorkspacePublicationOutcome,
} from './workspace-publication-worker.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

interface DispatchStableFacts {
  executorStatuses: Extract<KernelSnapshot, { type: 'dispatch' }>['executorStatuses'];
  correctionSupportedAgentClasses: string[];
  nativeContinuationAgentClasses: string[];
}

function defaultResourceGrant(taskId: string, generationId: string, subtaskId: string) {
  return buildDefaultResourceClaims({
    workspaceId: `workspace-${taskId}-${generationId}-${subtaskId}`,
    sourceMountId: `source-${taskId}`,
    inputsMountId: `inputs-${taskId}`,
    handoffsMountId: `handoffs-${taskId}-${generationId}`,
    gitMetadataMountId: `git-metadata-${taskId}-${generationId}-${subtaskId}`,
  });
}

export interface KernelExecutionRuntimeInput {
  taskId: string;
  request: QueuedExecutionRequest;
  recoveryOnly?: boolean;
}

export interface PreparedKernelExecutionInput extends KernelExecutionRuntimeInput {
  graphState: 'ready' | 'missing' | 'conflict';
}

export interface KernelExecutionRuntimeDeps {
  sessionId: string;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  subtaskRepo: SubtaskRepo;
  workGraphRevisionRepo: WorkGraphRevisionRepo;
  effectOutboxRepo: KernelEffectOutboxRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  subtaskHandoffRepo: SubtaskHandoffRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  attemptRunner: SubtaskAttemptRunner;
  controlKernel: ControlKernel;
  kernelWorkflowStore: KernelWorkflowStore & {
    listCapacitySignals?(
      taskId: string,
      cycleId: string,
    ): Array<Extract<KernelEvent, { type: 'capacity_signal' }>>;
  };
  dispatchItemRepo: KernelDispatchItemRepo;
  maxConcurrentAttempts: number;
  publicationWorker: WorkspacePublicationWorker;
  publicationRepo: WorkspacePublicationRepo;
  generationReplanRepo: GenerationReplanRequestRepo;
  cancellationCoordinator: TaskCancellationCoordinator;
  executionProgressService: ExecutionProgressService;
  verificationAndDeliveryService: VerificationAndDeliveryService;
  persistenceService: SessionPersistenceService;
  kernelExecutorStatusProjector: KernelExecutorStatusProjector;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    refreshRuntimeState(): void;
    appendTaskQueueSnapshot(trigger: string): void;
    setFocusContext(focus: FocusContext | null): void;
    setRunningExecutorName(taskId: string, subtaskId: string, attemptId: string, name: string): void;
    clearRunningExecutorName(taskId: string, attemptId?: string): void;
    persistSessionState(changes: {
      lastFocusedTaskId?: string | null;
      lastCompletedTaskId?: string | null;
      lastSessionId?: string | null;
    }): void;
    setLatestGuidance(scene: string, suggestion: Suggestion): GuidanceState;
    queueProposal(scene: string, proposal: GuidanceProposal): void;
    requestReplan(decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
    }): Promise<KernelEvent>;
    requestMergeReplan(decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
    }): Promise<KernelEvent | null>;
    buildPlanAdmissionSnapshot(event: Extract<KernelEvent, { type: 'plan_proposed' }>): KernelSnapshot;
  };
}

/** Runtime handler set for Kernel decisions. It applies one authorized action and reports one fact. */
export class KernelExecutionRuntime {
  private readonly taskEvents: TaskEventRecorder;
  private readonly attemptSupervisor: AttemptSupervisor;
  private readonly cancellationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: KernelExecutionRuntimeDeps) {
    this.taskEvents = new TaskEventRecorder(deps.taskEventRepo);
    this.attemptSupervisor = new AttemptSupervisor(
      deps.dispatchItemRepo,
      deps.maxConcurrentAttempts,
    );
  }

  async cancelTask(taskId: string, reason = 'explicit Task cancellation command'): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      type: 'task_cancel_requested',
      id: `task_cancel_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId,
      reason,
    });
  }

  async cancelSubtasks(
    taskId: string,
    targetSubtaskIds: string[],
    reason = 'explicit Subtask cancellation command',
  ): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      type: 'subtasks_cancel_requested',
      id: `subtasks_cancel_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId,
      targetSubtaskIds,
      reason,
    });
  }

  async acceptPartialResult(taskId: string): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      type: 'partial_result_acceptance_requested',
      id: `partial_accept_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId,
    });
  }

  async recoverCancellations(taskId?: string): Promise<void> {
    await this.deps.cancellationCoordinator.recover(taskId);
  }

  async executorRecovered(agentClassName: string, recoveryCheckId: string): Promise<void> {
    for (const request of this.deps.generationReplanRepo.listWaitingForAvailability()) {
      const task = this.deps.taskRuntimeService.findTask(request.taskId);
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(request.taskId);
      const event: Extract<KernelEvent, { type: 'executor_recovered' }> = {
        schemaVersion: 5,
        type: 'executor_recovered',
        id: `executor_recovered_${recoveryCheckId}_${request.id}`,
        correlationId: request.id,
        causationId: recoveryCheckId,
        occurredAt: new Date().toISOString(),
        sessionId: this.deps.sessionId,
        taskId: request.taskId,
        agentClassName,
        recoveryCheckId,
      };
      const workflow = new DurableKernelWorkflow({
        kernel: this.deps.controlKernel,
        buildSnapshot: () => ({
          schemaVersion: 5,
          type: 'availability_recovery',
          task: task ? { id: task.id, status: task.status } : null,
          activeGenerationId: activeRevision?.generationId ?? null,
          activeGraphRevision: activeRevision?.revision ?? null,
          deferredPlan: request.deferredPlan,
          executorStatuses: this.deps.kernelExecutorStatusProjector.list(),
        }),
        store: this.deps.kernelWorkflowStore,
        clock: { now: () => new Date().toISOString() },
        runtime: {
          apply: async decision => {
            if (decision.action.type === 'no_op') return null;
            if (decision.action.type !== 'activate_deferred_task_plan') {
              throw new Error(`Availability recovery Runtime cannot apply ${decision.action.type}`);
            }
            const currentRequest = this.deps.generationReplanRepo.find(decision.action.replanRequestId);
            const currentTask = this.deps.taskRuntimeService.findTask(decision.action.taskId);
            if (currentRequest?.status !== 'waiting_for_availability' || currentTask?.status !== 'blocked') {
              return null;
            }
            const result = this.deps.workGraphRuntimeService.apply({
              task: currentTask,
              userPrompt: currentRequest.deferredPlan?.requestText ?? currentTask.goal,
              sessionId: this.deps.sessionId,
              authorizedWorkGraph: decision.action.workGraph,
              authorization: {
                decisionId: decision.id,
                generationId: decision.action.generationId,
                revision: decision.action.graphRevision,
                source: decision.action.proposalSource,
                automaticReplan: true,
              },
            });
            if (result.outcome === 'not_executable') return null;
            this.deps.generationReplanRepo.resolve(currentRequest.id, new Date().toISOString());
            this.deps.taskRuntimeService.unblockTask(currentTask.id);
            this.deps.callbacks.refreshRuntimeState();
            return null;
          },
        },
        acceptedEventTypes: ['executor_recovered'],
        acceptedActions: ['activate_deferred_task_plan', 'no_op'],
        taskId: request.taskId,
      });
      await workflow.submit(event);
    }
  }

  getSingleActiveTaskId(): string | null {
    return this.deps.taskRuntimeService.getCurrentRunningTask()?.id
      ?? this.deps.cancellationCoordinator.findCleanupTaskId();
  }

  private async submitTaskControlEvent(
    event: Extract<KernelEvent, {
      type: 'task_cancel_requested' | 'subtasks_cancel_requested'
        | 'partial_result_acceptance_requested';
    }>,
  ): Promise<CancellationReceipt> {
    let receipt: CancellationReceipt | null = null;
    let controlError: string | null = null;
    const workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot: () => this.deps.cancellationCoordinator.buildSnapshot(event.taskId!),
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'cancel_task' || decision.action.type === 'cancel_subtasks') {
            receipt = this.deps.cancellationCoordinator.apply(
              decision as Parameters<TaskCancellationCoordinator['apply']>[0],
            );
            void this.drainCancellation(event.taskId!);
            return null;
          }
          if (decision.action.type === 'accept_partial_result') {
            const action = decision.action;
            const revision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
            const blocked = this.deps.cancellationCoordinator.completionBlockedReasons(
              action.taskId,
              action.generationId,
              decision.id,
            );
            if (
              !revision
              || revision.generationId !== action.generationId
              || revision.revision !== action.graphRevision
              || blocked.length > 0
            ) {
              controlError = `partial acceptance changed before application${blocked.length > 0
                ? `: ${blocked.join(', ')}`
                : ''}`;
              return null;
            }
            const allSubtasks = this.deps.subtaskRepo.listActiveByTask(action.taskId);
            const done = allSubtasks.filter(subtask =>
              action.completedSubtaskIds.includes(subtask.id) && subtask.status === 'done'
            );
            const cancelled = allSubtasks.filter(subtask =>
              action.cancelledSubtaskIds.includes(subtask.id) && subtask.status === 'cancelled'
            );
            if (
              done.length !== action.completedSubtaskIds.length
              || cancelled.length !== action.cancelledSubtaskIds.length
            ) {
              controlError = 'partial acceptance Subtask facts changed before application';
              return null;
            }
            const task = this.deps.taskRuntimeService.findTask(action.taskId)!;
            await this.completeTask({
              taskId: action.taskId,
              decisionId: decision.id,
              executionId: `partial_${decision.id}`,
              request: {
                userPrompt: task.goal,
                contextTaskId: task.id,
                executionMode: 'follow-up',
                origin: 'user',
                schedulingReason: 'explicit partial result acceptance',
              },
              subtasks: done,
              cancelledSubtasks: cancelled,
              completionKind: 'partial_accepted',
              revisionCompletion: {
                revision: action.graphRevision,
                completionKind: 'partial_accepted',
              },
              finishExecution: async lines => {
                this.deps.callbacks.appendOutput(...lines);
                this.deps.callbacks.refreshRuntimeState();
              },
            });
            receipt = {
              taskId: action.taskId,
              affectedSubtaskIds: action.cancelledSubtaskIds,
              cleanupAttemptIds: [],
            };
            return null;
          }
          if (decision.action.type === 'reject_request' || decision.action.type === 'block_work') {
            controlError = decision.reason;
            return null;
          }
          if (decision.action.type === 'no_op') return null;
          throw new Error(`Task control Runtime cannot apply ${decision.action.type}`);
        },
      },
      acceptedEventTypes: [
        'task_cancel_requested',
        'subtasks_cancel_requested',
        'partial_result_acceptance_requested',
      ],
      acceptedActions: [
        'cancel_task',
        'cancel_subtasks',
        'accept_partial_result',
        'reject_request',
        'block_work',
        'no_op',
      ],
      taskId: event.taskId!,
    });
    await workflow.submit(event);
    if (controlError) throw new Error(controlError);
    if (!receipt) throw new Error('Task control decision produced no receipt');
    return receipt;
  }

  private async drainCancellation(taskId: string): Promise<void> {
    try {
      await this.attemptSupervisor.drain(taskId);
      await this.deps.cancellationCoordinator.recover(taskId);
      this.deps.callbacks.refreshRuntimeState();
      this.clearCancellationRetry(taskId);
      const remainingTaskId = this.deps.cancellationCoordinator.findCleanupTaskId();
      if (remainingTaskId) this.scheduleCancellationRetry(remainingTaskId);
    } catch {
      // Durable cancelling rows retain capacity while the same process and startup
      // recovery both retry cleanup.
      this.scheduleCancellationRetry(taskId);
    }
  }

  private scheduleCancellationRetry(taskId: string): void {
    if (this.cancellationRetryTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.cancellationRetryTimers.delete(taskId);
      void this.drainCancellation(taskId);
    }, 1_000);
    timer.unref?.();
    this.cancellationRetryTimers.set(taskId, timer);
  }

  private clearCancellationRetry(taskId: string): void {
    const timer = this.cancellationRetryTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.cancellationRetryTimers.delete(taskId);
  }

  async recoverDue(taskId: string, reason = 'durable workflow recovery'): Promise<boolean> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) return false;
    const before = task.updatedAt;
    await this.execute(this.prepareExecution({
      taskId,
      request: {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: task.status === 'blocked' ? 'resume-blocked' : 'follow-up',
        origin: 'system',
        schedulingReason: reason,
      },
      recoveryOnly: true,
    }));
    return this.deps.taskRuntimeService.findTask(taskId)?.updatedAt !== before;
  }

  private buildDispatchSnapshot(
    taskId: string,
    graphState: 'ready' | 'missing' | 'conflict' = 'ready',
    stableFacts: DispatchStableFacts = this.buildDispatchStableFacts(),
    attempts: KernelAttemptFact[] = [],
    recoverySubtaskId: string | null = null,
    capacityProbeAgentClasses: Record<string, string[]> = {},
  ): KernelSnapshot {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const subtasks = activeRevision
      ? this.deps.subtaskRepo.listActiveByTask(taskId)
      : this.deps.subtaskRepo.listByTask(taskId);
    const done = new Set(subtasks.filter(subtask => subtask.status === 'done').map(subtask => subtask.id));
    const handoffs = new Set(this.deps.subtaskHandoffRepo.listByTask(taskId)
      .map(handoff => `${handoff.fromSubtaskId}\u0000${handoff.toSubtaskId}`));
    const persistedAttempts: KernelAttemptFact[] = this.deps.attemptReceiptRepo.listByTask(taskId)
      .filter(receipt => receipt.terminalState !== 'contract_blocked')
      .filter(receipt => !activeRevision || (
        receipt.generationId === activeRevision.generationId
        && receipt.graphRevision === activeRevision.revision
      ))
      .map(receipt => ({
        attemptId: receipt.attemptId,
        subtaskId: receipt.subtaskId,
        agentClassName: receipt.agentClassName,
        attemptKind: receipt.attemptKind,
        sourceAttemptId: receipt.sourceAttemptId,
        terminalKind: receipt.terminalState === 'completed' ? 'completed' : 'failed',
        failure: receipt.failure,
        completedAt: receipt.completedAt,
      }));
    const attemptFacts = [...new Map(
      [...attempts, ...persistedAttempts].map(attempt => [attempt.attemptId, attempt]),
    ).values()];
    const dispatchItems = this.deps.dispatchItemRepo.listByTask(taskId);
    const firstDispatchOrder = new Map<string, number>();
    for (const item of dispatchItems) {
      const current = firstDispatchOrder.get(item.subtaskId);
      if (current === undefined || item.batchOrder < current) {
        firstDispatchOrder.set(item.subtaskId, item.batchOrder);
      }
    }
    const frontier = deriveRunnableFrontier(
      { subtasks },
      subtasks.map(subtask => ({
        subtaskId: subtask.id,
        status: subtask.status,
        firstDispatchOrder: firstDispatchOrder.get(subtask.id) ?? null,
        hasPendingOrActiveAttempt: dispatchItems.some(item =>
          item.subtaskId === subtask.id
          && ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status)
        ),
      })),
    ).filter(subtaskId => {
      const subtask = subtasks.find(item => item.id === subtaskId);
      return subtask?.dependencies.every(dependency =>
        done.has(dependency.fromSubtaskId)
        && handoffs.has(`${dependency.fromSubtaskId}\u0000${subtask.id}`)
      ) ?? false;
    });
    const recoverySubtask = recoverySubtaskId
      ? subtasks.find(subtask => subtask.id === recoverySubtaskId)
      : subtasks.find(subtask => frontier.includes(subtask.id));
    const recoverySafety = deriveRecoverySafety(recoverySubtask?.requiredCapabilities ?? []);
    return {
      schemaVersion: 5,
      type: 'dispatch',
      task: task ? { id: task.id, status: task.status } : null,
      runningTaskId: this.deps.taskRuntimeService.getCurrentRunningTask()?.id
        ?? this.deps.cancellationCoordinator.findCleanupTaskId(),
      graphState,
      subtasks: subtasks.map(subtask => ({
        id: subtask.id,
        taskId: subtask.taskId,
        status: subtask.status,
        preferredAgentClassList: subtask.preferredAgentClassList,
      })),
      frontier,
      dispatchItems: dispatchItems.map(item => ({
        attemptId: item.attemptId,
        subtaskId: item.subtaskId,
        status: item.status,
        order: item.batchOrder,
      })),
      maxConcurrentAttempts: this.deps.maxConcurrentAttempts,
      availableSlots: Math.max(
        0,
        this.deps.maxConcurrentAttempts - dispatchItems.filter(item =>
          ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status)
        ).length,
      ),
      resourceConflictSubtaskIds: [],
      capacityProbeAgentClasses,
      executorStatuses: stableFacts.executorStatuses,
      correctionSupportedAgentClasses: stableFacts.correctionSupportedAgentClasses,
      nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
      attempts: attemptFacts,
      generationId: activeRevision?.generationId ?? `generation_${taskId}_1`,
      graphRevision: activeRevision?.revision ?? 1,
      automaticReplansUsed: activeRevision
        ? this.deps.workGraphRevisionRepo.countAutomaticReplans(taskId, activeRevision.generationId)
        : 0,
      recoverySafety,
      automaticRecoveryAllowed: recoverySubtask
        ? recoverySafety !== 'external_non_idempotent'
        : true,
      resourceGrantsBySubtask: Object.fromEntries(subtasks.map(subtask => [
        subtask.id,
        defaultResourceGrant(
          taskId,
          activeRevision?.generationId ?? `generation_${taskId}_1`,
          subtask.id,
        ),
      ])),
      completionBlockedReasons: this.deps.cancellationCoordinator
        .completionBlockedReasons(
          taskId,
          activeRevision?.generationId ?? null,
        ),
      generationReplanRequest: activeRevision
        ? (() => {
            const request = this.deps.generationReplanRepo.findActive(
              taskId,
              activeRevision.generationId,
            );
            return request ? {
              id: request.id,
              status: request.status as 'pending_quiescence' | 'planning' | 'submitted',
            } : null;
          })()
        : null,
      generationQuiescent: frontier.length === 0
        && !dispatchItems.some(item =>
          ['pending_launch', 'launching', 'running', 'cancelling', 'uncertain']
            .includes(item.status)
        )
        && !this.deps.publicationRepo.hasBlockingResidue(
          taskId,
          activeRevision?.generationId,
        )
        && !this.deps.cancellationCoordinator.completionBlockedReasons(
          taskId,
          activeRevision?.generationId ?? null,
        ).some(reason => [
          'sandbox',
          'work_unit',
          'resource_lease',
          'attempt_receipt',
        ].includes(reason)),
    };
  }

  private buildDispatchStableFacts(): DispatchStableFacts {
    const agentClassNames = this.deps.agentClassService.listAgentClasses()
      .map(agentClass => agentClass.name);
    return {
      executorStatuses: this.deps.kernelExecutorStatusProjector.list(),
      correctionSupportedAgentClasses: agentClassNames
        .filter(name => this.deps.attemptRunner.supportsResponseOnly(name)),
      nativeContinuationAgentClasses: agentClassNames
        .filter(name => this.deps.attemptRunner.supportsContinuation(name)),
    };
  }

  private capacityProbeFacts(
    current: Extract<KernelEvent, { type: 'capacity_signal' }>,
  ): Record<string, string[]> {
    const taskId = current.taskId;
    const subtaskId = current.subtaskId;
    if (!taskId || !subtaskId) return {};
    const signals = this.deps.kernelWorkflowStore.listCapacitySignals?.(
      taskId,
      current.cycleId,
    ) ?? [current];
    const unavailable = new Map<string, Set<string>>();
    for (const signal of signals) {
      if (!signal.subtaskId) continue;
      const classes = unavailable.get(signal.subtaskId) ?? new Set<string>();
      if (signal.available) classes.delete(signal.agentClassName);
      else classes.add(signal.agentClassName);
      unavailable.set(signal.subtaskId, classes);
    }
    return Object.fromEntries(
      [...unavailable].map(([id, classes]) => [id, [...classes].sort()]),
    );
  }

  private async applyExecutionDecision(input: {
    decision: KernelDecision;
    executionId: string;
    request: QueuedExecutionRequest;
    progressTracker: ReturnType<ExecutionProgressService['createTracker']>;
    supervisorContext: AttemptSupervisorContext;
    attemptFacts: KernelAttemptFact[];
    finishExecution(lines: string[], scheduleNext?: boolean): Promise<void>;
  }): Promise<KernelEvent | null> {
    const { decision } = input;
    const action = decision.action;
    if (action.type === 'dispatch_batch') {
      const generationId = this.deps.workGraphRevisionRepo.findActive(action.taskId)?.generationId
        ?? `generation_${action.taskId}_1`;
      this.attemptSupervisor.enqueue(
        decision as KernelDecision & {
          action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
        },
        generationId,
        input.supervisorContext,
        new Date().toISOString(),
      );
      return null;
    }
    if (action.type === 'probe_capacity') {
      const available = await this.deps.workUnitClaimService.probe(action.agentClassName);
      return this.eventFromDecision(decision, {
        type: 'capacity_signal', taskId: action.taskId, subtaskId: action.subtaskId,
        agentClassName: action.agentClassName, available, cycleId: input.executionId,
        attemptKind: 'primary',
        attemptPayload: null,
      });
    }
    if (action.type === 'wait_for_capacity') {
      await this.blockTask(
        action.taskId, `capacity unavailable for Subtask ${action.subtaskId}`,
        input.finishExecution, 'kernel_capacity',
      );
      return null;
    }
    if (action.type === 'wait_for_retry') {
      await this.blockTask(
        action.taskId, `retry scheduled for ${action.resumeAt}`,
        input.finishExecution, 'kernel_retry',
      );
      return this.eventFromDecision(decision, {
        type: 'timer_tick',
        taskId: action.taskId,
        subtaskId: action.subtaskId,
        occurredAt: action.resumeAt,
        wakeKind: 'retry',
        sourceDecisionId: decision.id,
        scheduledFor: action.resumeAt,
        retry: { agentClassName: action.agentClassName, sourceAttemptId: action.sourceAttemptId },
      });
    }
    if (action.type === 'wait_for_partition') {
      await this.blockTask(
        action.taskId,
        `resource partition is waiting for leases: ${action.conflictingLeaseIds.join(', ')}`,
        input.finishExecution,
        'kernel_capacity',
      );
      return null;
    }
    if (action.type === 'recover_workspace_attempt') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      const subtask = this.deps.subtaskRepo.findById(action.subtaskId);
      if (!task || !subtask) throw new Error('sandbox recovery target no longer exists');
      if (subtask.status !== 'done' && subtask.status !== 'cancelled') {
        this.deps.subtaskRepo.updateStatus(subtask.id, 'ready', {
          error: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
        });
      }
      if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested', taskId: action.taskId,
        reason: `recover persistent workspace ${action.workspaceId}`,
      });
    }
    if (action.type === 'block_work') {
      if (action.subtaskId && this.deps.subtaskRepo.findById(action.subtaskId)?.status === 'awaiting_decision') {
        this.deps.subtaskRepo.updateStatus(action.subtaskId, 'blocked', { error: decision.reason });
      }
      await this.blockTask(action.taskId, decision.reason, input.finishExecution);
      return null;
    }
    if (action.type === 'park_for_replan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (task && task.status !== 'parked') this.deps.taskRuntimeService.transitionTask(task.id, 'parked');
      await input.finishExecution([decision.reason]);
      return null;
    }
    if (action.type === 'complete_task') {
      const effectId = `effect_${decision.id}_task_completion`;
      if (
        this.deps.taskRuntimeService.findTask(action.taskId)?.status === 'done'
        && this.deps.effectOutboxRepo.find(effectId)
      ) {
        return null;
      }
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
      const completionBlockedReasons = this.deps.cancellationCoordinator
        .completionBlockedReasons(
          action.taskId,
          activeRevision?.generationId ?? null,
          decision.id,
        );
      if (completionBlockedReasons.length > 0) {
        await this.blockTask(
          action.taskId,
          `Task completion blocked by runtime residue: ${completionBlockedReasons.join(', ')}`,
          input.finishExecution,
          'manual',
        );
        return null;
      }
      const subtasks = this.deps.subtaskRepo.listByTask(action.taskId).filter(subtask =>
        subtask.status === 'done'
        && (!activeRevision || subtask.generationId === activeRevision.generationId)
      );
      await this.completeTask({
        taskId: action.taskId, decisionId: decision.id, executionId: input.executionId, request: input.request, subtasks,
        revisionCompletion: activeRevision ? {
          revision: activeRevision.revision,
          completionKind: 'full',
        } : undefined,
        finishExecution: input.finishExecution,
      });
      return null;
    }
    if (action.type === 'queue_generation_replan') {
      this.deps.generationReplanRepo.enqueue({
        id: action.requestId,
        taskId: action.taskId,
        generationId: action.generationId,
        sourceRevision: action.sourceRevision,
        triggerDecisionId: decision.id,
        now: new Date().toISOString(),
      });
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested',
        taskId: action.taskId,
        reason: 'generation replan queued; continue independent work until quiescence',
      });
    }
    if (action.type === 'request_replan') {
      const request = this.deps.generationReplanRepo.findByGeneration(
        action.taskId,
        action.generationId,
        action.sourceRevision,
      );
      if (!request) throw new Error('generation replan request is missing');
      const token = `quiescence_${decision.id}`;
      if (!this.deps.generationReplanRepo.markPlanning(
        request.id,
        token,
        new Date().toISOString(),
      )) {
        return null;
      }
      try {
        const event = await this.deps.callbacks.requestReplan(
          decision as KernelDecision & {
            action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
          },
        );
        if (!this.deps.generationReplanRepo.submitPlan(
          request.id,
          token,
          event,
          new Date().toISOString(),
        )) {
          return null;
        }
        return event;
      } catch (error) {
        this.deps.generationReplanRepo.fail(
          request.id,
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
        );
        throw error;
      }
    }
    if (action.type === 'request_merge_replan') {
      const now = new Date().toISOString();
      this.deps.publicationRepo.incrementConflictReplan(action.publicationId, now);
      this.deps.publicationRepo.markParkedForConflictReplan(action.publicationId, now);
      return this.deps.callbacks.requestMergeReplan(
        decision as KernelDecision & {
          action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
        },
      );
    }
    if (action.type === 'defer_task_plan_for_availability') {
      const request = this.deps.generationReplanRepo.findByGeneration(
        action.taskId,
        action.proposalEvent.generationId,
        action.proposalEvent.targetGraphRevision - 1,
      );
      if (!request) throw new Error('generation replan request is missing for availability deferral');
      if (!this.deps.generationReplanRepo.deferForAvailability(
        request.id,
        action.proposalEvent,
        action.explanation,
        new Date().toISOString(),
      )) {
        return null;
      }
      await this.blockTask(
        action.taskId,
        action.explanation,
        input.finishExecution,
        'kernel_availability',
      );
      return null;
    }
    if (action.type === 'authorize_task_plan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (!task) throw new Error(`replan Task not found: ${action.taskId}`);
      const result = this.deps.workGraphRuntimeService.apply({
        task,
        userPrompt: input.request.userPrompt,
        sessionId: this.deps.sessionId,
        authorizedWorkGraph: action.workGraph,
        authorization: {
          decisionId: decision.id,
          generationId: action.generationId,
          revision: action.graphRevision,
          source: action.proposalSource,
          automaticReplan: action.proposalSource === 'replan',
        },
      });
      if (result.outcome === 'not_executable') throw new Error(`authorized replan could not apply: ${result.reason}`);
      if (action.proposalSource === 'replan') {
        const request = this.deps.generationReplanRepo.findByGeneration(
          action.taskId,
          action.generationId,
          action.graphRevision - 1,
        );
        if (request) this.deps.generationReplanRepo.resolve(request.id, new Date().toISOString());
      }
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested',
        taskId: action.taskId,
        reason: `graph revision ${action.graphRevision} activated`,
      });
    }
    if (action.type === 'no_op') return null;
    throw new Error(`Execution Runtime cannot apply ${action.type}`);
  }

  private eventFromDecision(
    decision: KernelDecision,
    event: Omit<KernelEvent, keyof import('../kernel/control-kernel.js').KernelEventEnvelope | 'schemaVersion' | 'id' | 'correlationId' | 'causationId' | 'occurredAt' | 'sessionId'> & Record<string, unknown>,
  ): KernelEvent {
    return {
      schemaVersion: 5,
      id: `event_${decision.id}_${String(event.type)}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      ...event,
    } as KernelEvent;
  }

  private async runDispatchItem(input: {
    item: KernelDispatchItemRecord;
    executionId: string;
    request: QueuedExecutionRequest;
    progressTracker: ReturnType<ExecutionProgressService['createTracker']>;
  }): Promise<KernelEvent> {
    const { item } = input;
    const existingReceipt = this.deps.attemptReceiptRepo.findByAttemptId(item.attemptId);
    if (existingReceipt && existingReceipt.terminalState !== 'contract_blocked') {
      this.projectPersistedReceipt(existingReceipt);
      return this.eventFromDispatchItem(item, {
        type: 'execution_outcome',
        terminalKind: existingReceipt.terminalState === 'completed' ? 'completed' : 'failed',
        agentClassName: existingReceipt.agentClassName,
        attemptKind: existingReceipt.attemptKind,
        sourceAttemptId: existingReceipt.sourceAttemptId,
        failure: existingReceipt.terminalState === 'completed'
          ? null
          : existingReceipt.failure ?? {
              kind: existingReceipt.terminalState === 'heartbeat_lost' ? 'heartbeat_lost' : 'unknown',
              scope: 'attempt',
              code: existingReceipt.errorCode ?? 'recovered_attempt_failure',
              summary: existingReceipt.errorDetail ?? 'Recovered terminal attempt receipt',
            },
      });
    }

    const subtask = this.deps.subtaskRepo.findById(item.subtaskId);
    if (!subtask) throw new Error(`Kernel-authorized Subtask not found: ${item.subtaskId}`);
    const task = this.deps.taskRuntimeService.findTask(item.taskId);
    if (!task) throw new Error(`Kernel-authorized Task not found: ${item.taskId}`);
    for (const resource of input.request.newlyProvidedResources ?? []) {
      this.deps.taskRuntimeService.attachResource(task.id, resource);
    }
    if (task.status === 'created') this.deps.taskRuntimeService.transitionTask(task.id, 'ready');
    else if (task.status === 'parked') this.deps.taskRuntimeService.resumeParkedTask(task.id);
    else if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
    if (this.deps.taskRuntimeService.findTask(task.id)?.status === 'ready') {
      this.deps.taskRuntimeService.transitionTask(task.id, 'running');
    }
    this.deps.callbacks.setRunningExecutorName(
      item.taskId,
      item.subtaskId,
      item.attemptId,
      item.agentClassName,
    );
    this.deps.callbacks.appendOutput(...this.deps.presentation.formatExecutorDispatch(item.agentClassName));

    const outcome = item.attemptKind === 'contract_correction'
      && item.attemptPayload?.protocol === 'completion-correction-v2'
      && item.sourceAttemptId
      ? await this.deps.attemptRunner.runCorrection({
          attemptId: item.attemptId,
          sourceAttemptId: item.sourceAttemptId,
          executionId: input.executionId,
          taskId: item.taskId,
          subtaskId: item.subtaskId,
          agentClassName: item.agentClassName,
          completionContract: item.attemptPayload.completionContract,
          violations: item.attemptPayload.violations as Parameters<
            SubtaskAttemptRunner['runCorrection']
          >[0]['violations'],
        })
      : await this.deps.attemptRunner.run({
          attemptId: item.attemptId,
          executionId: input.executionId,
          taskId: item.taskId,
          subtaskId: item.subtaskId,
          agentClassName: item.agentClassName,
          executionMode: input.request.executionMode,
          attemptKind: item.attemptKind,
          attemptPayload: item.attemptPayload,
          sourceAttemptId: item.sourceAttemptId,
          recoveryMode: item.recoveryMode,
          defaultResourceGrant: item.resourceGrant,
          onProgress: input.progressTracker.onProgress,
        });
    this.deps.callbacks.clearRunningExecutorName(item.taskId, item.attemptId);

    if (outcome.outcome === 'capacity_unavailable') {
      return this.eventFromDispatchItem(item, {
        type: 'capacity_signal',
        agentClassName: item.agentClassName,
        available: false,
        cycleId: input.executionId,
        attemptKind: item.attemptKind,
        attemptPayload: item.attemptPayload,
      });
    }
    if (outcome.outcome === 'partition_conflict') {
      return this.eventFromDispatchItem(item, {
        type: 'partition_conflict_observed',
        claims: outcome.claims,
        conflictingLeaseIds: outcome.conflictingLeaseIds,
      });
    }
    if (item.attemptKind === 'merge_repair' && outcome.outcome !== 'completed') {
      const payload = item.attemptPayload;
      if (payload?.protocol !== 'metaclaw:merge-repair:v1') {
        throw new Error(`merge repair dispatch item has invalid payload: ${item.attemptId}`);
      }
      const publication = this.deps.publicationRepo.find(payload.publicationId);
      if (!publication || !publication.conflictChainId) {
        throw new Error(`merge repair publication is missing: ${payload.publicationId}`);
      }
      return this.eventFromDispatchItem(item, {
        type: 'merge_conflict_observed',
        publicationId: publication.id,
        conflictChainId: publication.conflictChainId,
        agentClassName: publication.agentClassName,
        sourceAttemptId: publication.sourceAttemptId,
        repairAttemptsUsed: publication.repairAttemptsUsed,
        conflictReplansUsed: publication.conflictReplansUsed,
        conflictingPaths: payload.conflictingPaths,
      });
    }
    this.projectExecutorOutcome(item.agentClassName, outcome);
    if (outcome.outcome === 'contract_failed') {
      return this.eventFromDispatchItem(item, {
        type: 'handoff_contract_failed',
        workUnitId: outcome.workUnitId,
        agentClassName: outcome.agentClassName,
        contract: outcome.completionContract,
        violations: outcome.violations,
        receiptCount: outcome.receiptCount,
        responseBytes: outcome.responseBytes,
      });
    }
    return this.eventFromDispatchItem(item, {
      type: 'execution_outcome',
      terminalKind: outcome.outcome === 'completed' ? 'completed' : 'failed',
      agentClassName: item.agentClassName,
      attemptKind: item.attemptKind,
      sourceAttemptId: item.sourceAttemptId,
      failure: outcome.outcome === 'completed'
        ? null
        : outcome.outcome === 'executor_failed'
          ? outcome.failure
          : { kind: 'stale', scope: 'attempt', code: 'cancelled_or_stale', summary: outcome.reason },
    });
  }

  private eventFromDispatchItem(
    item: KernelDispatchItemRecord,
    event: Omit<KernelEvent, keyof import('../kernel/control-kernel.js').KernelEventEnvelope
      | 'schemaVersion' | 'id' | 'correlationId' | 'causationId' | 'occurredAt'
      | 'sessionId' | 'taskId' | 'subtaskId' | 'attemptId'> & Record<string, unknown>,
  ): KernelEvent {
    return {
      schemaVersion: 5,
      id: `event_${item.attemptId}_${String(event.type)}`,
      correlationId: item.decisionId,
      causationId: item.decisionId,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: item.taskId,
      subtaskId: item.subtaskId,
      attemptId: item.attemptId,
      ...event,
    } as KernelEvent;
  }

  private launchFailureEvent(item: KernelDispatchItemRecord, error: unknown): KernelEvent {
    const summary = error instanceof Error ? error.message : String(error);
    return this.eventFromDispatchItem(item, {
      type: 'execution_outcome',
      terminalKind: 'failed',
      agentClassName: item.agentClassName,
      attemptKind: item.attemptKind,
      sourceAttemptId: item.sourceAttemptId,
      failure: {
        kind: 'infrastructure',
        scope: 'attempt',
        code: 'dispatch_launch_failed',
        summary,
      },
    });
  }


  prepareExecution(input: KernelExecutionRuntimeInput): PreparedKernelExecutionInput {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    const graph = this.deps.workGraphRuntimeService.apply({
      task,
      userPrompt: input.request.userPrompt,
      sessionId: this.deps.sessionId,
      authorizedWorkGraph: input.request.authorizedWorkGraph ?? null,
      authorization: input.request.workGraphAuthorization ?? null,
    });
    if (graph.outcome === 'not_executable' && input.request.authorizedWorkGraph) {
      throw new Error(`authorized Work Graph could not be persisted: ${graph.reason}`);
    }
    return {
      ...input,
      graphState: graph.outcome === 'not_executable'
        ? graph.reason === 'missing_graph' ? 'missing' : 'conflict'
        : 'ready',
    };
  }

  async execute(input: PreparedKernelExecutionInput): Promise<void> {
    const { taskId, request } = input;
    const finishExecution = async (lines: string[], _scheduleNext = false) => {
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendTaskQueueSnapshot('task state changed');
    };

    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Error: task not found ${taskId}`);
      return;
    }
    const graphState = input.graphState;

    const executionId = `exec_${generateInteractionId()}`;
    const progressTracker = this.deps.executionProgressService.createTracker({ taskId, executionId });
    const attemptFacts: KernelAttemptFact[] = [];
    const stableFacts = this.buildDispatchStableFacts();
    const initialEvent: KernelEvent = {
      schemaVersion: 5,
      type: 'dispatch_requested',
      id: `dispatch_event_${executionId}`,
      correlationId: request.kernelDecisionId ?? executionId,
      causationId: request.kernelDecisionId ?? null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId,
      reason: request.schedulingReason ?? 'authorized execution request',
    };
    const buildSnapshot = (event: KernelEvent): KernelSnapshot => event.type === 'plan_proposed'
      ? this.deps.callbacks.buildPlanAdmissionSnapshot(event)
      : event.type === 'partition_conflict_observed' ? {
          schemaVersion: 5,
          type: 'partition',
          conflictConfirmed: event.conflictingLeaseIds.length > 0,
          workspaceId: null,
          checkpointId: null,
        }
      : event.type === 'sandbox_lost' ? {
          schemaVersion: 5,
          type: 'sandbox_recovery',
          workspaceExists: Boolean(event.workspaceId),
          workspaceId: event.workspaceId,
          checkpointId: event.checkpointId,
          activeLeaseIds: [],
        }
      : event.type === 'timer_tick' ? {
          schemaVersion: 5,
          type: 'timer',
          task: { id: task.id, status: task.status },
          wakeAuthorized: this.isKernelWakeAuthorized(task, event.wakeKind),
          capacityBlockedAt: null,
          recheckAfterMs: 0,
            capacityAgentClasses: [],
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
          executorStatuses: stableFacts.executorStatuses,
          defaultResourceGrant: defaultResourceGrant(task.id, `generation_${task.id}_1`, event.subtaskId ?? 'pending'),
        }
      : this.buildDispatchSnapshot(
          event.taskId ?? taskId,
          graphState,
          stableFacts,
          attemptFacts,
          event.type === 'execution_outcome'
            ? event.terminalKind === 'failed' ? event.subtaskId : null
            : event.type === 'handoff_contract_failed' ? event.subtaskId : null,
          event.type === 'capacity_signal'
            ? this.capacityProbeFacts(event)
            : {},
        );
    let workflow: KernelWorkflow;
    const supervisorContext: AttemptSupervisorContext = {
      run: item => this.runDispatchItem({ item, executionId, request, progressTracker }),
      submit: event => workflow.submit(event),
      onLaunchError: async (item, error) => this.launchFailureEvent(item, error),
    };
    workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot,
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: decision => this.applyExecutionDecision({
          decision,
          executionId,
          request,
          progressTracker,
          supervisorContext,
          attemptFacts,
          finishExecution,
        }),
      },
      acceptedEventTypes: [
        'dispatch_requested', 'capacity_signal', 'execution_outcome',
        'handoff_contract_failed', 'timer_tick', 'plan_proposed',
        'partition_conflict_observed', 'sandbox_lost', 'merge_conflict_observed',
        'generation_quiescence_observed',
      ],
      acceptedActions: [
        'dispatch_batch', 'probe_capacity', 'wait_for_capacity', 'wait_for_retry',
        'block_work', 'park_for_replan', 'complete_task', 'request_replan',
        'queue_generation_replan',
        'request_merge_replan',
        'authorize_task_plan', 'defer_task_plan_for_availability', 'no_op',
        'wait_for_partition', 'recover_workspace_attempt',
      ],
      taskId,
    });
    this.attemptSupervisor.recover(taskId, supervisorContext);
    await this.recoverExpiredAttempts(workflow, attemptFacts);
    if (input.recoveryOnly) await workflow.recover();
    else await workflow.submit(initialEvent);
    await this.attemptSupervisor.drain(taskId);
    await this.drainPublications({
      taskId,
      executionId,
      workflow,
    });
    await this.deps.cancellationCoordinator.recover(taskId);
    this.deps.cancellationCoordinator.settlePartialCancellation(taskId);
  }

  private async drainPublications(input: {
    taskId: string;
    executionId: string;
    workflow: KernelWorkflow;
  }): Promise<void> {
    while (true) {
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(input.taskId);
      if (!activeRevision) return;
      const outcomes = await this.deps.publicationWorker.drain(
        input.taskId,
        activeRevision.generationId,
      );
      if (outcomes.length === 0) return;
      let integrated = false;
      for (const outcome of outcomes) {
        if (outcome.type === 'conflicted') {
          await input.workflow.submit(outcome.event);
          await this.attemptSupervisor.drain(input.taskId);
          break;
        }
        if (outcome.type === 'cancelled') continue;
        integrated = true;
        this.projectIntegratedPublication(outcome);
      }
      if (integrated) {
        const lastIntegrated = [...outcomes].reverse().find(
          (outcome): outcome is Extract<WorkspacePublicationOutcome, { type: 'integrated' }> => (
            outcome.type === 'integrated'
          ),
        );
        await input.workflow.submit({
          schemaVersion: 5,
          type: 'dispatch_requested',
          id: `publication_dispatch_${input.executionId}_${lastIntegrated?.publicationId
            ?? activeRevision.revision}`,
          correlationId: input.executionId,
          causationId: lastIntegrated?.publicationId ?? null,
          occurredAt: new Date().toISOString(),
          sessionId: this.deps.sessionId,
          taskId: input.taskId,
          reason: 'candidate publication released downstream frontier',
        });
        await this.attemptSupervisor.drain(input.taskId);
      }
    }
  }

  private projectIntegratedPublication(
    outcome: Extract<WorkspacePublicationOutcome, { type: 'integrated' }>,
  ): void {
    const subtask = this.deps.subtaskRepo.findById(outcome.subtaskId);
    this.recordTaskEvent(outcome.taskId, outcome.subtaskId, 'subtask_done', subtask?.title ?? outcome.subtaskId, {
      attemptId: outcome.sourceAttemptId,
      executorName: outcome.agentClassName,
      warnings: outcome.warnings,
      integrationCommit: outcome.integrationCommit,
    });
    this.deps.callbacks.appendOutput(this.deps.presentation.formatExecutorFinalResult({
      executorName: outcome.agentClassName,
      taskId: outcome.taskId,
      subtaskId: outcome.subtaskId,
      output: outcome.output,
    }));
  }

  private async recoverExpiredAttempts(workflow: KernelWorkflow, attemptFacts: KernelAttemptFact[]): Promise<void> {
    for (const workUnit of this.deps.workUnitClaimService.sweepExpired()) {
      if (!workUnit.claimedTaskId || !workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
      const task = this.deps.taskRuntimeService.findTask(workUnit.claimedTaskId);
      const subtask = this.deps.subtaskRepo.findById(workUnit.claimedSubtaskId);
      if (
        !task
        || task.status === 'cancelled'
        || !subtask
        || subtask.status === 'done'
        || subtask.status === 'cancelled'
      ) continue;
      this.deps.attemptRunner.landHeartbeatLost({
        attemptId: workUnit.claimedAttemptId,
        executionId: `heartbeat_${workUnit.claimedAttemptId}`,
        taskId: task.id,
        subtaskId: subtask.id,
        workUnitId: workUnit.id,
        agentClassName: workUnit.agentClassName,
      });
      const occurredAt = new Date().toISOString();
      const event: Extract<KernelEvent, { type: 'execution_outcome' }> = {
        schemaVersion: 5,
        type: 'execution_outcome',
        id: `heartbeat_event_${workUnit.claimedAttemptId}`,
        correlationId: task.id,
        causationId: workUnit.claimedAttemptId,
        occurredAt,
        sessionId: this.deps.sessionId,
        taskId: task.id,
        subtaskId: subtask.id,
        attemptId: workUnit.claimedAttemptId,
        terminalKind: 'failed',
        agentClassName: workUnit.agentClassName,
        attemptKind: 'primary',
        sourceAttemptId: null,
        failure: { kind: 'heartbeat_lost', scope: 'agent_class', code: 'heartbeat_lost', summary: 'WorkUnit heartbeat lost' },
      };
      attemptFacts.unshift({
        attemptId: workUnit.claimedAttemptId,
        subtaskId: subtask.id,
        agentClassName: workUnit.agentClassName,
        attemptKind: 'primary',
        sourceAttemptId: null,
        terminalKind: 'failed',
        failure: event.failure,
        completedAt: occurredAt,
      });
      await workflow.submit(event);
      this.recordTaskEvent(task.id, subtask.id, 'work_unit_heartbeat_lost', workUnit.id, {
        workUnitId: workUnit.id,
        attemptId: workUnit.claimedAttemptId,
      });
    }
  }

  async recheckCapacity(input: {
    taskId: string;
    subtaskId: string;
    blockedDecisionId: string;
    blockedAt: string;
    recheckAfterMs: number;
    occurredAt: string;
  }): Promise<boolean> {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!task || task.status !== 'blocked' || !subtask || subtask.status !== 'ready') return false;

    const executionId = `timer_${input.blockedDecisionId}`;
    const request: QueuedExecutionRequest = {
      userPrompt: task.goal,
      contextTaskId: task.id,
      executionMode: 'resume-blocked',
      kernelDecisionId: input.blockedDecisionId,
      origin: 'system',
      schedulingReason: 'Kernel capacity timer recheck',
    };
    const progressTracker = this.deps.executionProgressService.createTracker({ taskId: task.id, executionId });
    const stableFacts = this.buildDispatchStableFacts();
    let applied = false;
    const finishExecution = async (lines: string[]) => {
      this.deps.callbacks.clearRunningExecutorName(task.id);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
    };
    const initialEvent: KernelEvent = {
      schemaVersion: 5,
      type: 'timer_tick',
      id: `timer_event_${input.blockedDecisionId}_${input.occurredAt}`,
      correlationId: input.blockedDecisionId,
      causationId: input.blockedDecisionId,
      occurredAt: input.occurredAt,
      sessionId: this.deps.sessionId,
      taskId: task.id,
      subtaskId: subtask.id,
      wakeKind: 'capacity',
      sourceDecisionId: input.blockedDecisionId,
      scheduledFor: input.occurredAt,
      retry: null,
    };
    let workflow: KernelWorkflow;
    const supervisorContext: AttemptSupervisorContext = {
      run: item => this.runDispatchItem({ item, executionId, request, progressTracker }),
      submit: event => workflow.submit(event),
      onLaunchError: async (item, error) => this.launchFailureEvent(item, error),
    };
    workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot: event => event.type === 'plan_proposed'
        ? this.deps.callbacks.buildPlanAdmissionSnapshot(event)
        : event.type === 'partition_conflict_observed' ? {
            schemaVersion: 5,
            type: 'partition',
            conflictConfirmed: event.conflictingLeaseIds.length > 0,
            workspaceId: null,
            checkpointId: null,
          }
        : event.type === 'sandbox_lost' ? {
            schemaVersion: 5,
            type: 'sandbox_recovery',
            workspaceExists: Boolean(event.workspaceId),
            workspaceId: event.workspaceId,
            checkpointId: event.checkpointId,
            activeLeaseIds: [],
          }
        : event.type === 'timer_tick' ? {
            schemaVersion: 5,
            type: 'timer',
            task: { id: task.id, status: task.status },
            wakeAuthorized: this.isKernelWakeAuthorized(task, event.wakeKind),
            capacityBlockedAt: input.blockedAt,
            recheckAfterMs: input.recheckAfterMs,
            capacityAgentClasses: subtask.preferredAgentClassList,
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
            executorStatuses: stableFacts.executorStatuses,
            defaultResourceGrant: defaultResourceGrant(task.id, subtask.generationId, subtask.id),
          }
        : this.buildDispatchSnapshot(task.id, 'ready', stableFacts),
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type !== 'no_op') applied = true;
          return this.applyExecutionDecision({
            decision,
            executionId,
            request,
            progressTracker,
            supervisorContext,
            attemptFacts: [],
            finishExecution,
          });
        },
      },
      acceptedEventTypes: [
        'dispatch_requested', 'capacity_signal', 'execution_outcome',
        'handoff_contract_failed', 'timer_tick', 'plan_proposed',
        'partition_conflict_observed', 'sandbox_lost', 'merge_conflict_observed',
        'generation_quiescence_observed',
      ],
      acceptedActions: [
        'dispatch_batch', 'probe_capacity', 'wait_for_capacity', 'wait_for_retry',
        'block_work', 'park_for_replan', 'complete_task', 'request_replan',
        'queue_generation_replan',
        'request_merge_replan',
        'authorize_task_plan', 'defer_task_plan_for_availability', 'no_op',
        'wait_for_partition', 'recover_workspace_attempt',
      ],
      taskId: task.id,
    });
    await workflow.submit(initialEvent);
    await this.attemptSupervisor.drain(task.id);
    await this.drainPublications({
      taskId: task.id,
      executionId,
      workflow,
    });
    await this.deps.cancellationCoordinator.recover(task.id);
    this.deps.cancellationCoordinator.settlePartialCancellation(task.id);
    return applied;
  }

  private async blockTask(
    taskId: string,
    reason: string,
    finishExecution: (lines: string[], scheduleNext?: boolean) => Promise<void>,
    dependencyType: import('../core/types.js').Dependency['type'] = 'manual',
  ): Promise<void> {
    if (this.deps.taskRuntimeService.findTask(taskId)?.status === 'running') {
      this.deps.taskRuntimeService.blockTask(taskId, {
        taskId,
        type: dependencyType,
        description: reason,
        status: 'waiting',
      });
    }
    this.recordTaskEvent(taskId, null, 'phase2_execution_blocked', reason, {});
    await finishExecution([`Execution blocked: ${reason}`]);
  }

  private isKernelWakeAuthorized(task: import('../core/types.js').Task, wakeKind: Extract<KernelEvent, { type: 'timer_tick' }>['wakeKind']): boolean {
    const expectedType = wakeKind === 'retry'
      ? 'kernel_retry'
      : wakeKind === 'capacity'
        ? 'kernel_capacity'
        : 'kernel_availability';
    return task.status === 'blocked'
      && task.dependencies.some(dependency => dependency.status === 'waiting' && dependency.type === expectedType);
  }

  private async completeTask(input: {
    taskId: string;
    decisionId: string;
    executionId: string;
    request: QueuedExecutionRequest;
    subtasks: Subtask[];
    cancelledSubtasks?: Subtask[];
    completionKind?: 'full' | 'partial_accepted';
    revisionCompletion?: {
      revision: number;
      completionKind: 'full' | 'partial_accepted';
    };
    finishExecution(lines: string[]): Promise<void>;
  }): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(input.taskId)!;
    const artifacts = [...new Set(input.subtasks.flatMap(subtask => subtask.artifacts))];
    const warnings = input.subtasks.flatMap(subtask => subtask.verification.warnings.map(warning => `${subtask.id}: ${warning}`));
    const persistedSummary = input.subtasks.map(subtask => {
      const firstLine = subtask.result.split(/\r?\n/).find(line => line.trim())?.trim() ?? 'completed';
      return `- ${subtask.title}: ${firstLine.slice(0, 240)}`;
    }).join('\n');
    const displaySummary = input.subtasks.map(subtask => `- ${subtask.title}: completed`).join('\n');
    const cancelledSubtasks = input.cancelledSubtasks ?? [];
    const completionKind = input.completionKind ?? 'full';
    const aggregateParts = (summary: string) => [
      completionKind === 'partial_accepted'
        ? `Task #${input.taskId} completed with an explicitly accepted partial result.`
        : `Task #${input.taskId} completed ${input.subtasks.length} Subtask(s).`,
      summary,
      cancelledSubtasks.length > 0
        ? `Cancelled Subtasks:\n${cancelledSubtasks.map(subtask => `- ${subtask.id}: ${subtask.title}`).join('\n')}`
        : '',
      warnings.length > 0 ? `Warnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}` : '',
      artifacts.length > 0 ? `Artifacts:\n${artifacts.map(path => `- ${path}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const cleanAggregate = aggregateParts(persistedSummary);
    const displayAggregate = aggregateParts(displaySummary);

    const effectId = `effect_${input.decisionId}_task_completion`;
    const effectPayload = {
      taskId: input.taskId,
      title: task.title,
      summary: cleanAggregate,
      output: cleanAggregate,
      artifactPaths: artifacts,
      durationMs: 0,
      executionMode: input.request.executionMode,
      origin: input.request.origin ?? 'user',
      recoveryTrigger: input.request.recoveryTrigger,
      completionKind,
      cancelledSubtaskIds: cancelledSubtasks.map(subtask => subtask.id),
    };
    this.deps.effectOutboxRepo.transaction(() => {
      if (input.revisionCompletion) {
        this.deps.workGraphRevisionRepo.complete(
          input.taskId,
          input.revisionCompletion.revision,
          new Date().toISOString(),
          input.revisionCompletion.completionKind,
        );
      }
      this.deps.taskRuntimeService.updateTask(input.taskId, { summary: cleanAggregate, artifacts });
      this.deps.persistenceService.recordInteraction({
        taskId: input.taskId,
        sessionId: this.deps.sessionId,
        userInput: input.request.userPrompt,
        systemOutput: cleanAggregate,
        executorUsed: input.subtasks.length === 1 ? input.subtasks[0]!.preferredAgentClassList[0] ?? 'executor' : 'work-graph',
      });
      if (['running', 'blocked'].includes(
        this.deps.taskRuntimeService.findTask(input.taskId)?.status ?? '',
      )) {
        this.deps.taskRuntimeService.transitionTask(input.taskId, 'done');
      }
      const now = new Date().toISOString();
      this.deps.effectOutboxRepo.enqueue({
        id: effectId,
        decisionId: input.decisionId,
        taskId: input.taskId,
        effectType: 'task_completion_notification',
        payload: effectPayload,
        availableAt: now,
      });
    });
    const completionLines: string[] = [];
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: input.taskId });
    this.deps.callbacks.persistSessionState({ lastFocusedTaskId: input.taskId, lastCompletedTaskId: input.taskId });
    completionLines.push(displayAggregate);

    let deliveryMessage: string | null = null;
    await this.deps.effectOutboxRepo.deliver(effectId, async () => {
      deliveryMessage = await this.deps.verificationAndDeliveryService.deliverTaskCompletion(
        this.deps.notifier,
        effectPayload,
      );
      return effectId;
    }, () => new Date().toISOString());
    if (deliveryMessage) this.deps.callbacks.appendOutput(deliveryMessage);

    const suggestion = this.deps.orchestration.suggestNext(input.taskId);
    const nextProposal = this.deps.orchestration.suggestNextProposal(input.taskId);
    if (suggestion) {
      const guidance = this.deps.callbacks.setLatestGuidance('completion suggestion', suggestion);
      completionLines.push(...this.deps.presentation.formatGuidanceBlock(
        'completion suggestion', suggestion, guidance.taskTitle, { emptyReason: 'follow-up task is available' },
      ));
    }
    await input.finishExecution(completionLines);
    if (nextProposal) this.deps.callbacks.queueProposal('completion suggestion', nextProposal);
  }

  private projectExecutorOutcome(agentClassName: string, outcome: SubtaskAttemptOutcome): void {
    if (outcome.outcome !== 'completed' && outcome.outcome !== 'executor_failed') return;
    const succeeded = outcome.outcome === 'completed';
    this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
      agentClassName, attemptId: outcome.attemptId,
      outcome: succeeded ? 'succeeded' : 'failed',
      failure: succeeded ? null : outcome.outcome === 'executor_failed' ? outcome.failure : null,
    });
  }

  private projectPersistedReceipt(receipt: import('../storage/executor-attempt-receipt-repo.js').ExecutorAttemptReceipt): void {
    this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
      agentClassName: receipt.agentClassName,
      attemptId: receipt.attemptId,
      outcome: receipt.terminalState === 'completed' ? 'succeeded' : 'failed',
      failure: receipt.terminalState === 'completed' ? null : receipt.failure,
      completedAt: receipt.completedAt,
    });
  }

  private recordTaskEvent(
    taskId: string,
    subtaskId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.taskEvents.record(taskId, subtaskId, eventType, message, payload);
  }
}
