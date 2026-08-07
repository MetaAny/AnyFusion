import type Database from 'better-sqlite3';
import type { ActiveExecutionControl } from './active-execution-control.js';
import type { AttemptSandboxPort } from './attempt-sandbox.js';
import type { AttemptSandboxRepositoryPort } from './repositories.js';
import type { KernelDecision, KernelSnapshot } from '../kernel/control-kernel.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import type { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import type { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import type { ResourceLeaseService } from './resource-lease-service.js';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';

export interface CancellationReceipt {
  taskId: string;
  affectedSubtaskIds: string[];
  cleanupAttemptIds: string[];
}

type CancellationDecision = KernelDecision & {
  action: Extract<KernelDecision['action'], {
    type: 'cancel_task' | 'cancel_subtasks' | 'accept_partial_result';
  }>;
};

/**
 * Owns the durable cancellation fence and the asynchronous resource drain.
 * Callers submit one Kernel-authorized action; this module hides every storage
 * and sandbox ordering rule needed to make that action durable.
 */
export class TaskCancellationCoordinator {
  private readonly taskEvents: TaskEventRepo;

  constructor(private readonly deps: {
    db: Database.Database;
    taskRuntimeService: TaskRuntimeService;
    subtaskRepo: SubtaskRepo;
    taskEventRepo: TaskEventRepo;
    workGraphRevisionRepo: WorkGraphRevisionRepo;
    dispatchItemRepo: KernelDispatchItemRepo;
    publicationRepo: WorkspacePublicationRepo;
    generationReplanRepo: GenerationReplanRequestRepo;
    resourceLeaseService: ResourceLeaseService;
    workUnitClaimService: WorkUnitClaimService;
    activeExecutions: ActiveExecutionControl;
    attemptSandbox: AttemptSandboxPort;
    attemptSandboxRepository: AttemptSandboxRepositoryPort;
  }) {
    this.taskEvents = deps.taskEventRepo;
  }

  buildSnapshot(taskId: string): Extract<KernelSnapshot, { type: 'task_control' }> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const revision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const subtasks = revision
      ? this.deps.subtaskRepo.listActiveByTask(taskId)
      : this.deps.subtaskRepo.listByTask(taskId);
    return {
      schemaVersion: 5,
      type: 'task_control',
      task: task ? { id: task.id, status: task.status } : null,
      generationId: revision?.generationId ?? null,
      graphRevision: revision?.revision ?? null,
      subtasks: subtasks.map(subtask => ({
        id: subtask.id,
        taskId: subtask.taskId,
        status: subtask.status,
        preferredAgentClassList: subtask.preferredAgentClassList,
        dependencySubtaskIds: subtask.dependencies.map(dependency => dependency.fromSubtaskId),
      })),
      completionBlockedReasons: this.completionBlockedReasons(
        taskId,
        revision?.generationId ?? null,
      ),
      partialCancellation: Boolean(
        task?.status !== 'cancelled'
        && subtasks.some(subtask => subtask.status === 'cancelled'),
      ),
    };
  }

  apply(decision: CancellationDecision): CancellationReceipt {
    const now = new Date().toISOString();
    const action = decision.action;
    if (action.type === 'accept_partial_result') {
      throw new Error('partial acceptance completion is applied by KernelExecutionRuntime');
    }
    const applyFence = this.deps.db.transaction((): CancellationReceipt => {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (!task) throw new Error(`Task not found: ${action.taskId}`);
      const revision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
      if (action.type === 'cancel_task') {
        if (action.generationId !== (revision?.generationId ?? null)) {
          throw new Error('Task cancellation generation changed before application');
        }
        this.deps.taskRuntimeService.cancelTask(action.taskId, decision.reason);
        const subtasks = revision
          ? this.deps.subtaskRepo.listActiveByTask(action.taskId)
          : this.deps.subtaskRepo.listByTask(action.taskId);
        const affected = subtasks
          .filter(subtask => !['done', 'cancelled'].includes(subtask.status))
          .map(subtask => subtask.id);
        for (const subtaskId of affected) {
          this.deps.subtaskRepo.updateStatus(subtaskId, 'cancelled', {
            error: `Task cancelled by ${decision.id}`,
          });
          this.taskEvents.record({
            taskId: action.taskId,
            subtaskId,
            eventType: 'subtask_cancelled',
            message: 'Task cancellation fence',
            payload: { decisionId: decision.id, scope: 'task' },
          });
        }
        const cleanupAttemptIds = this.requestDependentCancellation({
          taskId: action.taskId,
          generationId: revision?.generationId ?? null,
          subtaskIds: null,
          decisionId: decision.id,
          now,
        });
        this.deps.generationReplanRepo.cancelTask(action.taskId, decision.id, now);
        this.taskEvents.record({
          taskId: action.taskId,
          subtaskId: null,
          eventType: 'task_cancelled',
          message: decision.reason,
          payload: {
            decisionId: decision.id,
            affectedSubtaskIds: affected,
            cleanupAttemptIds,
          },
        });
        return { taskId: action.taskId, affectedSubtaskIds: affected, cleanupAttemptIds };
      }

      if (
        !revision
        || revision.generationId !== action.generationId
        || revision.revision !== action.graphRevision
      ) {
        throw new Error('Subtask cancellation graph revision changed before application');
      }
      const expected = new Map(action.expectedStatuses.map(item => [
        item.subtaskId,
        item.status,
      ]));
      const current = action.subtaskIds.map(subtaskId => this.deps.subtaskRepo.findById(subtaskId));
      if (current.some(subtask =>
        !subtask
        || subtask.taskId !== action.taskId
        || subtask.generationId !== action.generationId
        || subtask.status !== expected.get(subtask.id)
      )) {
        throw new Error('Subtask cancellation closure changed before application');
      }
      for (const subtaskId of action.subtaskIds) {
        this.deps.subtaskRepo.updateStatus(subtaskId, 'cancelled', {
          error: `Subtask cancelled by ${decision.id}`,
        });
        this.taskEvents.record({
          taskId: action.taskId,
          subtaskId,
          eventType: 'subtask_cancelled',
          message: 'Explicit atomic Subtask cancellation',
          payload: { decisionId: decision.id, scope: 'subtask' },
        });
      }
      const cleanupAttemptIds = this.requestDependentCancellation({
        taskId: action.taskId,
        generationId: action.generationId,
        subtaskIds: action.subtaskIds,
        decisionId: decision.id,
        now,
      });
      this.deps.generationReplanRepo.cancelTask(action.taskId, decision.id, now);
      this.taskEvents.record({
        taskId: action.taskId,
        subtaskId: null,
        eventType: 'subtask_cancellation_batch',
        message: 'Atomic Subtask cancellation batch committed',
        payload: {
          decisionId: decision.id,
          affectedSubtaskIds: action.subtaskIds,
          cleanupAttemptIds,
        },
      });
      return {
        taskId: action.taskId,
        affectedSubtaskIds: action.subtaskIds,
        cleanupAttemptIds,
      };
    });
    const receipt = applyFence.immediate();
    for (const attemptId of receipt.cleanupAttemptIds) {
      this.deps.activeExecutions.abortAttempt(receipt.taskId, attemptId);
    }
    return receipt;
  }

  async recover(taskId?: string): Promise<void> {
    const cancelling = this.deps.dispatchItemRepo.listCancelling(taskId);
    for (const item of cancelling) {
      this.deps.activeExecutions.abortAttempt(item.taskId, item.attemptId);
      const sandbox = this.deps.attemptSandboxRepository.find(item.attemptId);
      try {
        if (sandbox && ['created', 'running', 'paused'].includes(sandbox.status)) {
          await this.deps.attemptSandbox.stop(sandbox.containerId);
        }
        const observed = sandbox
          ? await this.deps.attemptSandbox.inspect(sandbox.containerId)
          : null;
        if (observed && observed.status !== 'exited') continue;
        if (sandbox) {
          await this.deps.attemptSandbox.remove(sandbox.containerId);
          this.deps.attemptSandboxRepository.update(item.attemptId, {
            status: 'removed',
            cleanupStatus: 'removed',
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {
        continue;
      }
      const now = new Date().toISOString();
      this.deps.resourceLeaseService.releaseRevokedAttempt(item.attemptId, now);
      if (item.workUnitId) {
        this.deps.workUnitClaimService.releaseOrphanedAttempt({
          workUnitId: item.workUnitId,
          taskId: item.taskId,
          subtaskId: item.subtaskId,
          attemptId: item.attemptId,
        });
      }
      this.deps.dispatchItemRepo.markCancelled(
        item.attemptId,
        now,
        'cancelled after sandbox exit was confirmed',
      );
    }

    for (const publication of this.deps.publicationRepo.listCancelling(taskId)) {
      const dispatchStillActive = this.deps.dispatchItemRepo.listByTask(publication.taskId)
        .some(item =>
          item.subtaskId === publication.subtaskId
          && item.status === 'cancelling'
        );
      if (!dispatchStillActive) {
        this.deps.publicationRepo.markCancelled(
          publication.id,
          publication.observedIntegrationCommit,
          new Date().toISOString(),
        );
      }
    }
    if (taskId) this.settlePartialCancellation(taskId);
    else {
      for (const candidateTaskId of this.deps.subtaskRepo.listTaskIds()) {
        this.settlePartialCancellation(candidateTaskId);
      }
    }
  }

  completionBlockedReasons(
    taskId: string,
    generationId: string | null,
    excludedDecisionId?: string,
  ): string[] {
    const reasons: string[] = [];
    const generation = generationId ? ' AND generation_id = ?' : '';
    const dispatchGeneration = generationId ? ' AND dispatch.generation_id = ?' : '';
    const parameters = generationId ? [taskId, generationId] : [taskId];
    if (this.deps.dispatchItemRepo.hasBlockingResidue(taskId, generationId ?? undefined)) {
      reasons.push('dispatch');
    }
    if (this.deps.publicationRepo.hasBlockingResidue(taskId, generationId ?? undefined)) {
      reasons.push('publication');
    }
    if (this.deps.db.prepare(`
      SELECT 1 FROM attempt_sandboxes
      WHERE task_id = ?${generation}
        AND status IN ('created', 'running', 'paused')
      LIMIT 1
    `).get(...parameters)) reasons.push('sandbox');
    if (this.deps.workUnitClaimService.hasClaimedByTask(taskId)) reasons.push('work_unit');
    if (this.deps.db.prepare(`
      SELECT 1 FROM resource_leases
      WHERE task_id = ?${generation} AND released_at IS NULL
      LIMIT 1
    `).get(...parameters)) reasons.push('resource_lease');
    if (this.deps.db.prepare(`
      SELECT 1 FROM generation_replan_requests
      WHERE task_id = ?${generation}
        AND status IN ('pending_quiescence', 'planning', 'submitted')
      LIMIT 1
    `).get(...parameters)) reasons.push('generation_replan');
    const applicationParameters: unknown[] = [taskId];
    let decisionFilter = '';
    if (excludedDecisionId) {
      decisionFilter = ' AND application.decision_id <> ?';
      applicationParameters.push(excludedDecisionId);
    }
    if (this.deps.db.prepare(`
      SELECT 1
      FROM kernel_decision_applications AS application
      INNER JOIN kernel_events AS event ON event.id = application.event_id
      WHERE event.task_id = ?
        AND application.status IN ('pending', 'applying', 'uncertain')
        ${decisionFilter}
      LIMIT 1
    `).get(...applicationParameters)) reasons.push('kernel_application');
    if (this.deps.db.prepare(`
      SELECT 1
      FROM kernel_dispatch_items AS dispatch
      LEFT JOIN executor_attempt_receipts AS receipt
        ON receipt.attempt_id = dispatch.attempt_id
      WHERE dispatch.task_id = ?${dispatchGeneration}
        AND dispatch.status = 'terminal'
        AND (dispatch.work_unit_id IS NOT NULL OR dispatch.sandbox_container_id IS NOT NULL)
        AND receipt.attempt_id IS NULL
      LIMIT 1
    `).get(...parameters)) reasons.push('attempt_receipt');
    return reasons;
  }

  findCleanupTaskId(): string | null {
    const row = this.deps.db.prepare(`
      SELECT task_id
      FROM (
        SELECT task_id, created_at FROM kernel_dispatch_items WHERE status = 'cancelling'
        UNION ALL
        SELECT task_id, created_at FROM workspace_publications WHERE status = 'cancelling'
        UNION ALL
        SELECT task_id, created_at FROM resource_leases
          WHERE released_at IS NULL AND revocation_requested_at IS NOT NULL
      )
      ORDER BY created_at, task_id
      LIMIT 1
    `).get() as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  settlePartialCancellation(taskId: string): void {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const revision = this.deps.workGraphRevisionRepo.findActive(taskId);
    if (!task || task.status === 'cancelled' || !revision) return;
    const subtasks = this.deps.subtaskRepo.listActiveByTask(taskId);
    if (
      subtasks.some(subtask => subtask.status === 'cancelled')
      && subtasks.every(subtask => ['done', 'cancelled'].includes(subtask.status))
      && this.completionBlockedReasons(taskId, revision.generationId).length === 0
      && task.status !== 'blocked'
    ) {
      this.deps.taskRuntimeService.updateTask(taskId, {
        status: 'blocked',
        lastInterruptionReason: 'partial Subtask cancellation requires explicit acceptance',
      });
      this.taskEvents.record({
        taskId,
        subtaskId: null,
        eventType: 'partial_result_pending_acceptance',
        message: 'Remaining sibling work is complete; explicit partial acceptance is required',
        payload: {
          generationId: revision.generationId,
          cancelledSubtaskIds: subtasks
            .filter(subtask => subtask.status === 'cancelled')
            .map(subtask => subtask.id),
        },
      });
    }
  }

  private requestDependentCancellation(input: {
    taskId: string;
    generationId: string | null;
    subtaskIds: readonly string[] | null;
    decisionId: string;
    now: string;
  }): string[] {
    const dispatch = this.deps.dispatchItemRepo.requestCancellation(input);
    this.deps.publicationRepo.requestCancellation(input);
    this.deps.resourceLeaseService.requestRevocation({
      ...input,
      reason: `cancelled by ${input.decisionId}`,
    });
    this.deps.resourceLeaseService.cancelWaits(input);
    return dispatch
      .filter(item => item.status === 'cancelling')
      .map(item => item.attemptId);
  }
}
