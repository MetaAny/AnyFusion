import type Database from 'better-sqlite3';
import type { SubtaskStatus } from '../core/types.js';
import type { KernelEvent } from '../kernel/control-kernel.js';
import {
  ExecutorAttemptReceiptRepo,
  type ExecutorAttemptReceiptInsert,
} from '../storage/executor-attempt-receipt-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';

export interface AttemptTerminalLanding {
  receipt: ExecutorAttemptReceiptInsert;
  expectedSubtaskStatus: SubtaskStatus;
  nextSubtaskStatus: SubtaskStatus;
  subtaskError: string | null;
  event: KernelEvent;
  publication?: Parameters<WorkspacePublicationRepo['insertCandidate']>[0];
  repairPublication?: {
    publicationId: string;
    candidateCommit: string;
  };
  now: string;
}

export interface AttemptTerminalLandingResult {
  cancellationWon: boolean;
  pauseWon: boolean;
}

/**
 * Commits every durable database fact that makes one authorized attempt
 * terminal. Container, WorkUnit and resource-lease cleanup deliberately sits
 * outside this transaction and is resumed independently.
 */
export class AttemptTerminalService {
  private readonly receipts: ExecutorAttemptReceiptRepo;
  private readonly dispatchItems: KernelDispatchItemRepo;
  private readonly workflow: KernelWorkflowRepo;
  private readonly publications: WorkspacePublicationRepo;

  constructor(private readonly db: Database.Database) {
    this.receipts = new ExecutorAttemptReceiptRepo(db);
    this.dispatchItems = new KernelDispatchItemRepo(db);
    this.workflow = new KernelWorkflowRepo(db);
    this.publications = new WorkspacePublicationRepo(db);
  }

  land(input: AttemptTerminalLanding): AttemptTerminalLandingResult {
    return this.db.transaction(() => {
      const dispatch = this.dispatchItems.find(input.receipt.attemptId);
      if (!dispatch) {
        throw new Error(`authorized dispatch item not found: ${input.receipt.attemptId}`);
      }
      if (
        dispatch.taskId !== input.receipt.taskId
        || dispatch.subtaskId !== input.receipt.subtaskId
        || input.event.attemptId !== input.receipt.attemptId
        || input.event.taskId !== input.receipt.taskId
        || input.event.subtaskId !== input.receipt.subtaskId
      ) {
        throw new Error(`attempt terminal identity mismatch: ${input.receipt.attemptId}`);
      }
      if (input.publication && input.repairPublication) {
        throw new Error(`attempt terminal cannot create and repair a publication: ${input.receipt.attemptId}`);
      }

      const fence = this.db.prepare(`
        SELECT tasks.status AS task_status, subtasks.status AS subtask_status
        FROM tasks
        INNER JOIN subtasks ON subtasks.id = ?
        WHERE tasks.id = ?
      `).get(input.receipt.subtaskId, input.receipt.taskId) as {
        task_status: string;
        subtask_status: SubtaskStatus;
      } | undefined;
      if (!fence) {
        throw new Error(`attempt terminal fence facts not found: ${input.receipt.attemptId}`);
      }
      const cancellationWon = fence.task_status === 'cancelled'
        || fence.subtask_status === 'cancelled'
        || dispatch.status === 'cancelling'
        || dispatch.status === 'cancelled';
      const pauseWon = !cancellationWon && fence.task_status === 'parked';
      const receipt = pauseWon ? pausedReceipt(input.receipt) : input.receipt;

      this.receipts.insert(receipt);
      if (pauseWon) {
        const changed = this.db.prepare(`
          UPDATE subtasks
          SET status = 'ready', error = NULL, updated_at = ?
          WHERE id = ? AND task_id = ? AND status = ?
            AND EXISTS (
              SELECT 1 FROM tasks
              WHERE tasks.id = subtasks.task_id AND tasks.status = 'parked'
            )
        `).run(
          input.now,
          input.receipt.subtaskId,
          input.receipt.taskId,
          input.expectedSubtaskStatus,
        ).changes;
        if (changed !== 1) {
          throw new Error(`paused attempt fence changed: ${input.receipt.attemptId}`);
        }
      } else if (!cancellationWon) {
        const changed = this.db.prepare(`
          UPDATE subtasks
          SET status = ?, error = ?, updated_at = ?
          WHERE id = ? AND task_id = ? AND status = ?
            AND EXISTS (
              SELECT 1 FROM tasks
              WHERE tasks.id = subtasks.task_id AND tasks.status = 'running'
            )
        `).run(
          input.nextSubtaskStatus,
          input.subtaskError,
          input.now,
          input.receipt.subtaskId,
          input.receipt.taskId,
          input.expectedSubtaskStatus,
        ).changes;
        if (changed !== 1) {
          throw new Error(`attempt terminal fence changed: ${input.receipt.attemptId}`);
        }
        if (input.publication) {
          this.publications.insertCandidate(input.publication);
        }
        if (input.repairPublication) {
          this.publications.markPendingAfterRepair(
            input.repairPublication.publicationId,
            input.repairPublication.candidateCommit,
            input.now,
          );
          const repaired = this.db.prepare(`
            SELECT status, candidate_commit
            FROM workspace_publications
            WHERE id = ? AND task_id = ? AND subtask_id = ?
          `).get(
            input.repairPublication.publicationId,
            input.receipt.taskId,
            input.receipt.subtaskId,
          ) as { status: string; candidate_commit: string } | undefined;
          if (
            repaired?.status !== 'pending'
            || repaired.candidate_commit !== input.repairPublication.candidateCommit
          ) {
            throw new Error(`merge-repair publication did not become pending: ${input.receipt.attemptId}`);
          }
        }
      }

      this.dispatchItems.markTerminal(
        input.receipt.attemptId,
        receipt.errorDetail,
        input.now,
      );
      const terminalDispatch = this.dispatchItems.find(input.receipt.attemptId);
      if (!terminalDispatch || !['terminal', 'cancelled'].includes(terminalDispatch.status)) {
        throw new Error(`dispatch item did not become terminal: ${input.receipt.attemptId}`);
      }
      const event = pauseWon
        ? pauseOutcome(input.event, dispatch, input.now)
        : cancellationWon
          ? cancellationOutcome(input.event, dispatch, input.now)
          : input.event;
      this.workflow.enqueue(event, event.occurredAt);
      if (!this.workflow.findEvent(event.id)) {
        throw new Error(`attempt outcome inbox was not persisted: ${event.id}`);
      }
      return { cancellationWon, pauseWon };
    })();
  }
}

function pausedReceipt(receipt: ExecutorAttemptReceiptInsert): ExecutorAttemptReceiptInsert {
  const summary = 'Task pause fence won before attempt terminal landing';
  return {
    ...receipt,
    terminalState: 'cancelled_or_stale',
    errorCode: 'task_paused',
    errorDetail: summary,
    failure: {
      kind: 'cancelled',
      scope: 'attempt',
      code: 'task_paused',
      summary,
    },
  };
}

function pauseOutcome(
  event: KernelEvent,
  dispatch: NonNullable<ReturnType<KernelDispatchItemRepo['find']>>,
  now: string,
): KernelEvent {
  return {
    schemaVersion: 5,
    type: 'execution_outcome',
    id: event.id,
    correlationId: dispatch.decisionId,
    causationId: dispatch.decisionId,
    occurredAt: now,
    sessionId: event.sessionId,
    taskId: dispatch.taskId,
    subtaskId: dispatch.subtaskId,
    attemptId: dispatch.attemptId,
    terminalKind: 'failed',
    agentClassName: dispatch.agentClassName,
    attemptKind: dispatch.attemptKind,
    sourceAttemptId: dispatch.sourceAttemptId,
    failure: {
      kind: 'cancelled',
      scope: 'attempt',
      code: 'task_paused',
      summary: 'Task pause fence won before attempt terminal landing',
    },
  };
}

function cancellationOutcome(
  event: KernelEvent,
  dispatch: NonNullable<ReturnType<KernelDispatchItemRepo['find']>>,
  now: string,
): KernelEvent {
  return {
    schemaVersion: 5,
    type: 'execution_outcome',
    id: event.id,
    correlationId: dispatch.decisionId,
    causationId: dispatch.decisionId,
    occurredAt: now,
    sessionId: event.sessionId,
    taskId: dispatch.taskId,
    subtaskId: dispatch.subtaskId,
    attemptId: dispatch.attemptId,
    terminalKind: 'failed',
    agentClassName: dispatch.agentClassName,
    attemptKind: dispatch.attemptKind,
    sourceAttemptId: dispatch.sourceAttemptId,
    failure: {
      kind: 'stale',
      scope: 'attempt',
      code: 'cancelled_or_stale',
      summary: 'Cancellation fence won before attempt terminal landing',
    },
  };
}
