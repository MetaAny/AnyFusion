import type Database from 'better-sqlite3';
import type { KernelDecision, KernelDecisionAction, KernelEvent } from '../kernel/control-kernel.js';
import type {
  KernelApplicationStatus,
  KernelDecisionApplicationRecord,
  KernelWorkflowStore,
} from '../kernel/kernel-workflow.js';
import type { KernelDecisionLedgerRecord } from '../kernel/kernel-workflow.js';
import { KernelDecisionRepo } from './kernel-decision-repo.js';

interface ApplicationRow {
  id: string;
  decision_id: string;
  event_id: string;
  idempotency_key: string;
  status: KernelApplicationStatus;
  apply_attempts: number;
  observation_event_json: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
  decision_json: string;
  decision_schema_version: number;
}

/** SQLite v24 Adapter for the durable KernelWorkflow transaction boundary. */
export class KernelWorkflowRepo implements KernelWorkflowStore {
  private readonly decisions: KernelDecisionRepo;

  constructor(private readonly db: Database.Database) {
    this.decisions = new KernelDecisionRepo(db);
  }

  enqueue(event: KernelEvent, availableAt = event.occurredAt): boolean {
    return this.insertEvent(event, availableAt);
  }

  findEvent(id: string): KernelEvent | null {
    const row = this.db.prepare('SELECT schema_version, event_json FROM kernel_events WHERE id = ?')
      .get(id) as { schema_version: number; event_json: string } | undefined;
    return row ? parseCurrentEvent(row.event_json, row.schema_version) : null;
  }

  findApplicationByDecisionId(decisionId: string): KernelDecisionApplicationRecord | null {
    return this.findApplication(decisionId);
  }

  listCapacitySignals(
    taskId: string,
    cycleId: string,
  ): Array<Extract<KernelEvent, { type: 'capacity_signal' }>> {
    const rows = this.db.prepare(`
      SELECT schema_version, event_json FROM kernel_events
      WHERE task_id = ? AND event_type = 'capacity_signal'
      ORDER BY created_at ASC, id ASC
    `).all(taskId) as Array<{ schema_version: number; event_json: string }>;
    return rows
      .map(row => parseCurrentEvent(row.event_json, row.schema_version))
      .filter((event): event is Extract<KernelEvent, { type: 'capacity_signal' }> => (
        event.type === 'capacity_signal' && event.cycleId === cycleId
      ));
  }

  claimNext(now: string, eventTypes?: KernelEvent['type'][], taskId?: string): KernelEvent | null {
    if (eventTypes?.length === 0) return null;
    const eventFilter = eventTypes?.length
      ? ` AND event_type IN (${eventTypes.map(() => '?').join(', ')})`
      : '';
    const taskFilter = taskId ? ' AND task_id = ?' : '';
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id, schema_version, event_json FROM kernel_events
        WHERE status = 'pending' AND available_at <= ?${eventFilter}${taskFilter}
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(now, ...(eventTypes ?? []), ...(taskId ? [taskId] : [])) as {
        id: string;
        schema_version: number;
        event_json: string;
      } | undefined;
      if (!row) return null;
      const event = parseCurrentEvent(row.event_json, row.schema_version);
      const result = this.db.prepare(`
        UPDATE kernel_events
        SET status = 'processing', processing_started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, now, row.id);
      return result.changes === 1 ? event : null;
    });
    return claim();
  }

  issue(eventId: string, record: KernelDecisionLedgerRecord): KernelDecisionApplicationRecord {
    const issueTransaction = this.db.transaction(() => {
      const source = this.db.prepare('SELECT status FROM kernel_events WHERE id = ?').get(eventId) as { status: string } | undefined;
      if (!source) throw new Error(`Kernel event not found: ${eventId}`);
      this.decisions.issue(record);
      this.db.prepare(`
        INSERT OR IGNORE INTO kernel_decision_applications (
          id, decision_id, event_id, idempotency_key, status, apply_attempts,
          observation_event_id, observation_event_json, error_summary,
          applying_at, applied_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        `application_${record.id}`,
        record.id,
        eventId,
        `decision:${record.id}`,
        record.createdAt,
        record.createdAt,
      );
      this.db.prepare(`
        UPDATE kernel_events
        SET status = 'processed', processed_at = ?, processing_started_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(record.createdAt, record.createdAt, eventId);
      return this.findApplication(record.id);
    });
    const application = issueTransaction();
    if (!application) throw new Error(`Kernel application was not created: ${record.id}`);
    return application;
  }

  listRecoverableApplications(actions?: KernelDecisionAction['type'][], taskId?: string): KernelDecisionApplicationRecord[] {
    if (actions?.length === 0) return [];
    const actionFilter = actions?.length
      ? ` AND decision.action IN (${actions.map(() => '?').join(', ')})`
      : '';
    const taskFilter = taskId ? ' AND decision.task_id = ?' : '';
    const rows = this.db.prepare(`
      SELECT application.*, decision.decision_json,
             decision.schema_version AS decision_schema_version
      FROM kernel_decision_applications application
      JOIN kernel_decisions decision ON decision.id = application.decision_id
      WHERE application.status = 'pending'${actionFilter}${taskFilter}
      ORDER BY application.created_at ASC, application.id ASC
    `).all(...(actions ?? []), ...(taskId ? [taskId] : [])) as ApplicationRow[];
    return rows.map(rowToApplication);
  }

  markApplying(decisionId: string, now: string): KernelDecisionApplicationRecord {
    this.db.prepare(`
      UPDATE kernel_decision_applications
      SET status = 'applying', apply_attempts = apply_attempts + 1,
          applying_at = ?, updated_at = ?
      WHERE decision_id = ? AND status = 'pending'
    `).run(now, now, decisionId);
    const application = this.findApplication(decisionId);
    if (!application || application.status !== 'applying') {
      throw new Error(`Kernel application is not recoverable: ${decisionId}`);
    }
    return application;
  }

  markApplied(decisionId: string, observation: KernelEvent | null, now: string): void {
    const complete = this.db.transaction(() => {
      if (observation) this.insertEvent(observation, observation.occurredAt);
      const result = this.db.prepare(`
        UPDATE kernel_decision_applications
        SET status = 'applied', observation_event_id = ?, observation_event_json = ?,
            error_summary = NULL, applied_at = ?, updated_at = ?
        WHERE decision_id = ? AND status = 'applying'
      `).run(
        observation?.id ?? null,
        observation ? JSON.stringify(observation) : null,
        now,
        now,
        decisionId,
      );
      if (result.changes !== 1) throw new Error(`Kernel application cannot be completed: ${decisionId}`);
    });
    complete();
  }

  isDecisionApplied(decisionId: string): boolean {
    const row = this.db.prepare(`
      SELECT status FROM kernel_decision_applications WHERE decision_id = ?
    `).get(decisionId) as { status: KernelApplicationStatus } | undefined;
    return row?.status === 'applied';
  }

  markApplicationFailed(
    decisionId: string,
    status: Extract<KernelApplicationStatus, 'uncertain' | 'failed'>,
    errorSummary: string,
    now: string,
  ): void {
    this.db.prepare(`
      UPDATE kernel_decision_applications
      SET status = ?, error_summary = ?, updated_at = ?
      WHERE decision_id = ? AND status = 'applying'
    `).run(status, errorSummary, now, decisionId);
  }

  reconcileProcessing(): number {
    const reconcile = this.db.transaction(() => {
      const processed = this.db.prepare(`
        UPDATE kernel_events
        SET status = 'processed', processing_started_at = NULL, updated_at = created_at
        WHERE status = 'processing'
          AND EXISTS (SELECT 1 FROM kernel_decisions WHERE event_id = kernel_events.id)
      `).run().changes;
      const pending = this.db.prepare(`
        UPDATE kernel_events
        SET status = 'pending', processing_started_at = NULL, updated_at = created_at
        WHERE status = 'processing'
      `).run().changes;
      const applications = this.db.prepare(`
        UPDATE kernel_decision_applications
        SET status = 'pending', applying_at = NULL, updated_at = created_at
        WHERE status = 'applying'
      `).run().changes;
      return processed + pending + applications;
    });
    return reconcile();
  }

  countByApplicationStatus(): Record<KernelApplicationStatus, number> {
    const counts: Record<KernelApplicationStatus, number> = {
      pending: 0,
      applying: 0,
      applied: 0,
      uncertain: 0,
      failed: 0,
    };
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM kernel_decision_applications GROUP BY status
    `).all() as Array<{ status: KernelApplicationStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  hasRecoverableWork(taskId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS present
      WHERE EXISTS (
        SELECT 1 FROM kernel_events
        WHERE task_id = ? AND status IN ('pending', 'processing')
      ) OR EXISTS (
        SELECT 1
        FROM kernel_decision_applications application
        JOIN kernel_decisions decision ON decision.id = application.decision_id
        WHERE decision.task_id = ? AND application.status <> 'applied'
      )
    `).get(taskId, taskId) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  listRecoveryItems(taskId: string): KernelDecisionApplicationRecord[] {
    const rows = this.db.prepare(`
      SELECT application.*, decision.decision_json,
             decision.schema_version AS decision_schema_version
      FROM kernel_decision_applications application
      JOIN kernel_decisions decision ON decision.id = application.decision_id
      WHERE decision.task_id = ? AND application.status IN ('uncertain', 'failed')
      ORDER BY application.created_at ASC, application.id ASC
    `).all(taskId) as ApplicationRow[];
    return rows.map(rowToApplication);
  }

  findRecoveryItem(id: string): KernelDecisionApplicationRecord | null {
    const row = this.db.prepare(`
      SELECT application.*, decision.decision_json,
             decision.schema_version AS decision_schema_version
      FROM kernel_decision_applications application
      JOIN kernel_decisions decision ON decision.id = application.decision_id
      WHERE application.id = ? AND application.status IN ('uncertain', 'failed')
    `).get(id) as ApplicationRow | undefined;
    return row ? rowToApplication(row) : null;
  }

  resolveRecoveryItem(id: string, resolution: 'assume_applied' | 'retry', now: string): void {
    const nextStatus = resolution === 'assume_applied' ? 'applied' : 'pending';
    this.db.prepare(`
      UPDATE kernel_decision_applications
      SET status = ?, error_summary = NULL,
          applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END,
          updated_at = ?
      WHERE id = ? AND status IN ('uncertain', 'failed')
    `).run(nextStatus, nextStatus, now, now, id);
  }

  private insertEvent(event: KernelEvent, availableAt: string): boolean {
    if (event.schemaVersion !== 5) {
      throw new Error(`unsupported Kernel event schema version ${event.schemaVersion}`);
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO kernel_events (
        id, schema_version, event_type, correlation_id, causation_id,
        session_id, task_id, subtask_id, attempt_id, event_json,
        available_at, status, processing_started_at, processed_at,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
    `).run(
      event.id,
      event.schemaVersion,
      event.type,
      event.correlationId,
      event.causationId,
      event.sessionId,
      event.taskId ?? null,
      event.subtaskId ?? null,
      event.attemptId ?? null,
      JSON.stringify(event),
      availableAt,
      event.occurredAt,
      event.occurredAt,
    );
    return result.changes === 1;
  }

  private findApplication(decisionId: string): KernelDecisionApplicationRecord | null {
    const row = this.db.prepare(`
      SELECT application.*, decision.decision_json,
             decision.schema_version AS decision_schema_version
      FROM kernel_decision_applications application
      JOIN kernel_decisions decision ON decision.id = application.decision_id
      WHERE application.decision_id = ?
    `).get(decisionId) as ApplicationRow | undefined;
    return row ? rowToApplication(row) : null;
  }
}

function rowToApplication(row: ApplicationRow): KernelDecisionApplicationRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    applyAttempts: row.apply_attempts,
    observationEvent: row.observation_event_json
      ? parseCurrentEvent(row.observation_event_json)
      : null,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decision: parseCurrentDecision(row.decision_json, row.decision_schema_version),
  };
}

function parseCurrentEvent(raw: string, storedSchemaVersion?: number): KernelEvent {
  if (storedSchemaVersion !== undefined && storedSchemaVersion !== 5) {
    throw new Error(`unsupported Kernel event schema version ${storedSchemaVersion}`);
  }

  return parseCurrentKernelValue<KernelEvent>(raw, 'event');
}

function parseCurrentDecision(raw: string, storedSchemaVersion: number): KernelDecision {
  if (storedSchemaVersion !== 5) {
    throw new Error(`unsupported Kernel decision schema version ${storedSchemaVersion}`);
  }
  return parseCurrentKernelValue<KernelDecision>(raw, 'decision');
}

function parseCurrentKernelValue<T extends { schemaVersion: 5 }>(
  raw: string,
  kind: string,
): T {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object'
    || value === null
    || !('schemaVersion' in value)
    || value.schemaVersion !== 5
  ) {
    const version = typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? String(value.schemaVersion)
      : 'missing';
    throw new Error(`unsupported Kernel ${kind} schema version ${version}`);
  }
  return value as T;
}
