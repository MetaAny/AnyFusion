import type Database from 'better-sqlite3';
import type {
  KernelDecision,
  KernelDispatchItemStatus,
  KernelAttemptPayload,
  KernelAttemptKind,
  KernelRecoveryMode,
} from '../kernel/control-kernel.js';
import type { ResourceClaim } from '../resource/index.js';

export interface KernelDispatchItemRecord {
  attemptId: string;
  decisionId: string;
  batchOrder: number;
  taskId: string;
  generationId: string;
  subtaskId: string;
  agentClassName: string;
  attemptKind: KernelAttemptKind;
  sourceAttemptId: string | null;
  recoveryMode: KernelRecoveryMode;
  attemptPayload: KernelAttemptPayload;
  resourceGrant: ResourceClaim[];
  status: KernelDispatchItemStatus;
  workUnitId: string | null;
  sandboxRuntimeHandle: string | null;
  launchStartedAt: string | null;
  terminalAt: string | null;
  cancellationDecisionId: string | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DispatchItemRow {
  attempt_id: string;
  decision_id: string;
  batch_order: number;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  agent_class_name: string;
  attempt_kind: KernelAttemptKind;
  source_attempt_id: string | null;
  recovery_mode: KernelRecoveryMode;
  attempt_payload_json: string;
  resource_grant_json: string;
  status: KernelDispatchItemStatus;
  work_unit_id: string | null;
  sandbox_runtime_handle: string | null;
  launch_started_at: string | null;
  terminal_at: string | null;
  cancellation_decision_id: string | null;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

export class KernelDispatchItemRepo {
  constructor(private readonly db: Database.Database) {}

  insertBatch(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
    },
    generationId: string,
    now: string,
  ): KernelDispatchItemRecord[] {
    const insert = this.db.transaction(() => {
      const existing = decision.action.items.map(item => this.find(item.attemptId));
      if (existing.every((item): item is KernelDispatchItemRecord => item !== null)) {
        return existing;
      }
      if (existing.some(item => item !== null)) {
        throw new Error(`partially persisted dispatch batch requires reconciliation: ${decision.id}`);
      }
      const maximum = this.db.prepare(`
        SELECT COALESCE(MAX(batch_order), -1) AS value
        FROM kernel_dispatch_items
        WHERE task_id = ? AND generation_id = ?
      `).get(decision.action.taskId, generationId) as { value: number };
      const firstOrder = maximum.value + 1;
      for (const item of decision.action.items) {
        this.db.prepare(`
          INSERT INTO kernel_dispatch_items (
            attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
            agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
            attempt_payload_json, resource_grant_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_launch', ?, ?)
        `).run(
          item.attemptId,
          decision.id,
          firstOrder + item.order,
          decision.action.taskId,
          generationId,
          item.subtaskId,
          item.agentClassName,
          item.attemptKind,
          item.sourceAttemptId,
          item.recoveryMode,
          JSON.stringify(item.attemptPayload),
          JSON.stringify(item.defaultResourceGrant),
          now,
          now,
        );
      }
      return decision.action.items.map(item => {
        const persisted = this.find(item.attemptId);
        if (!persisted) throw new Error(`dispatch item was not persisted: ${item.attemptId}`);
        return persisted;
      });
    });
    return insert();
  }

  find(attemptId: string): KernelDispatchItemRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM kernel_dispatch_items WHERE attempt_id = ?
    `).get(attemptId) as DispatchItemRow | undefined;
    return row ? rowToDispatchItem(row) : null;
  }

  listByTask(taskId: string): KernelDispatchItemRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_dispatch_items
      WHERE task_id = ?
      ORDER BY batch_order ASC, created_at ASC, attempt_id ASC
    `).all(taskId) as DispatchItemRow[]).map(rowToDispatchItem);
  }

  listPending(taskId?: string): KernelDispatchItemRecord[] {
    const taskFilter = taskId ? ' AND task_id = ?' : '';
    return (this.db.prepare(`
      SELECT * FROM kernel_dispatch_items
      WHERE status = 'pending_launch'${taskFilter}
      ORDER BY batch_order ASC, created_at ASC, attempt_id ASC
    `).all(...(taskId ? [taskId] : [])) as DispatchItemRow[]).map(rowToDispatchItem);
  }

  claimPending(attemptId: string, now: string): KernelDispatchItemRecord | null {
    const claim = this.db.transaction(() => {
      const current = this.find(attemptId);
      if (!current) return null;
      const fence = this.db.prepare(`
        SELECT tasks.status AS task_status, subtasks.status AS subtask_status
        FROM tasks
        INNER JOIN subtasks ON subtasks.id = ?
        WHERE tasks.id = ?
      `).get(current.subtaskId, current.taskId) as {
        task_status: string;
        subtask_status: string;
      } | undefined;
      if (
        !fence
        || fence.task_status === 'cancelled'
        || fence.subtask_status === 'cancelled'
      ) return null;
      const changed = this.db.prepare(`
        UPDATE kernel_dispatch_items
        SET status = 'launching', launch_started_at = ?, updated_at = ?
        WHERE attempt_id = ? AND status = 'pending_launch'
      `).run(now, now, attemptId).changes;
      return changed === 1 ? this.find(attemptId) : null;
    });
    return claim();
  }

  markRunning(attemptId: string, workUnitId: string | null, now: string): boolean {
    return this.db.prepare(`
      UPDATE kernel_dispatch_items
      SET status = 'running', work_unit_id = COALESCE(?, work_unit_id), updated_at = ?
      WHERE attempt_id = ? AND status = 'launching'
    `).run(workUnitId, now, attemptId).changes === 1;
  }

  markRuntime(attemptId: string, runtimeHandle: string, now: string): void {
    this.db.prepare(`
      UPDATE kernel_dispatch_items
      SET sandbox_runtime_handle = ?, status = 'running', updated_at = ?
      WHERE attempt_id = ? AND status IN ('launching', 'running')
    `).run(runtimeHandle, now, attemptId);
  }

  markTerminal(attemptId: string, errorSummary: string | null, now: string): void {
    const finish = this.db.transaction(() => {
      const current = this.find(attemptId);
      if (current?.status === 'cancelling') {
        this.markCancelled(attemptId, now, errorSummary);
        return;
      }
      this.db.prepare(`
        UPDATE kernel_dispatch_items
        SET status = 'terminal', terminal_at = ?, error_summary = ?, updated_at = ?
        WHERE attempt_id = ? AND status IN ('launching', 'running', 'uncertain')
      `).run(now, errorSummary, now, attemptId);
    });
    finish();
  }

  markUncertain(attemptId: string, errorSummary: string, now: string): void {
    this.db.prepare(`
      UPDATE kernel_dispatch_items
      SET status = 'uncertain', error_summary = ?, updated_at = ?
      WHERE attempt_id = ? AND status IN ('pending_launch', 'launching', 'running')
    `).run(errorSummary, now, attemptId);
  }

  requestCancellation(input: {
    taskId: string;
    generationId?: string | null;
    subtaskIds?: readonly string[] | null;
    decisionId: string;
    now: string;
  }): KernelDispatchItemRecord[] {
    const request = this.db.transaction(() => {
      const filters = ['task_id = ?'];
      const parameters: unknown[] = [input.taskId];
      if (input.generationId) {
        filters.push('generation_id = ?');
        parameters.push(input.generationId);
      }
      if (input.subtaskIds) {
        if (input.subtaskIds.length === 0) return [];
        filters.push(`subtask_id IN (${input.subtaskIds.map(() => '?').join(', ')})`);
        parameters.push(...input.subtaskIds);
      }
      const where = filters.join(' AND ');
      this.db.prepare(`
        UPDATE kernel_dispatch_items
        SET status = 'cancelled',
            terminal_at = ?,
            cancellation_decision_id = ?,
            cancel_requested_at = ?,
            cancelled_at = ?,
            updated_at = ?
        WHERE ${where} AND status = 'pending_launch'
      `).run(
        input.now,
        input.decisionId,
        input.now,
        input.now,
        input.now,
        ...parameters,
      );
      this.db.prepare(`
        UPDATE kernel_dispatch_items
        SET status = 'cancelling',
            cancellation_decision_id = ?,
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            updated_at = ?
        WHERE ${where} AND status IN ('launching', 'running', 'uncertain')
      `).run(input.decisionId, input.now, input.now, ...parameters);
      return (this.db.prepare(`
        SELECT * FROM kernel_dispatch_items
        WHERE ${where}
          AND cancellation_decision_id = ?
          AND status IN ('cancelling', 'cancelled')
        ORDER BY batch_order, attempt_id
      `).all(...parameters, input.decisionId) as DispatchItemRow[]).map(rowToDispatchItem);
    });
    return request();
  }

  listCancelling(taskId?: string): KernelDispatchItemRecord[] {
    const filter = taskId ? ' AND task_id = ?' : '';
    return (this.db.prepare(`
      SELECT * FROM kernel_dispatch_items
      WHERE status = 'cancelling'${filter}
      ORDER BY batch_order, created_at, attempt_id
    `).all(...(taskId ? [taskId] : [])) as DispatchItemRow[]).map(rowToDispatchItem);
  }

  markCancelled(attemptId: string, now: string, errorSummary: string | null = null): void {
    this.db.prepare(`
      UPDATE kernel_dispatch_items
      SET status = 'cancelled',
          terminal_at = COALESCE(terminal_at, ?),
          cancelled_at = COALESCE(cancelled_at, ?),
          error_summary = COALESCE(?, error_summary),
          updated_at = ?
      WHERE attempt_id = ? AND status = 'cancelling'
    `).run(now, now, errorSummary, now, attemptId);
  }

  hasBlockingResidue(taskId: string, generationId?: string): boolean {
    const generationFilter = generationId ? ' AND generation_id = ?' : '';
    return Boolean(this.db.prepare(`
      SELECT 1 FROM kernel_dispatch_items
      WHERE task_id = ?${generationFilter}
        AND status IN ('pending_launch', 'launching', 'running', 'cancelling', 'uncertain')
      LIMIT 1
    `).get(taskId, ...(generationId ? [generationId] : [])));
  }

  reconcileLaunching(): number {
    return this.db.prepare(`
      UPDATE kernel_dispatch_items
      SET status = 'pending_launch', launch_started_at = NULL, updated_at = created_at
      WHERE status = 'launching' AND sandbox_runtime_handle IS NULL
    `).run().changes;
  }
}

function rowToDispatchItem(row: DispatchItemRow): KernelDispatchItemRecord {
  return {
    attemptId: row.attempt_id,
    decisionId: row.decision_id,
    batchOrder: row.batch_order,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    agentClassName: row.agent_class_name,
    attemptKind: row.attempt_kind,
    sourceAttemptId: row.source_attempt_id,
    recoveryMode: row.recovery_mode,
    attemptPayload: JSON.parse(row.attempt_payload_json) as KernelAttemptPayload,
    resourceGrant: JSON.parse(row.resource_grant_json) as ResourceClaim[],
    status: row.status,
    workUnitId: row.work_unit_id,
    sandboxRuntimeHandle: row.sandbox_runtime_handle,
    launchStartedAt: row.launch_started_at,
    terminalAt: row.terminal_at,
    cancellationDecisionId: row.cancellation_decision_id,
    cancelRequestedAt: row.cancel_requested_at,
    cancelledAt: row.cancelled_at,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
