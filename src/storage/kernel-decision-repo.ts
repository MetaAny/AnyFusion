import type Database from 'better-sqlite3';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../kernel/control-kernel.js';
import type { KernelDecisionLedgerRecord } from '../kernel/kernel-workflow.js';
export type { KernelDecisionLedgerRecord } from '../kernel/kernel-workflow.js';

interface KernelDecisionRow {
  id: string;
  schema_version: number;
  event_id: string;
  event_type: KernelEvent['type'];
  correlation_id: string;
  causation_id: string | null;
  session_id: string;
  task_id: string | null;
  subtask_id: string | null;
  attempt_id: string | null;
  event_json: string;
  snapshot_json: string;
  decision_json: string;
  action: KernelDecision['action']['type'];
  reason: string;
  created_at: string;
}

/** Storage Adapter for ledger-first Kernel decision issuance. */
export class KernelDecisionRepo {
  constructor(private readonly db: Database.Database) {}

  insertIfAbsent(record: KernelDecisionLedgerRecord): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, causation_id,
        session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
        decision_json, action, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.schemaVersion, record.eventId, record.eventType,
      record.correlationId, record.causationId, record.sessionId, record.taskId,
      record.subtaskId, record.attemptId, JSON.stringify(record.event),
      JSON.stringify(record.snapshot), JSON.stringify(record.decision), record.action,
      record.reason, record.createdAt,
    );
    return result.changes === 1;
  }

  issue(record: KernelDecisionLedgerRecord): boolean {
    return this.insertIfAbsent(record);
  }

  findByEventId(eventId: string): KernelDecisionLedgerRecord | null {
    const row = this.db.prepare('SELECT * FROM kernel_decisions WHERE event_id = ?').get(eventId) as KernelDecisionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listBySession(sessionId: string): KernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_decisions WHERE session_id = ? ORDER BY created_at ASC, id ASC
    `).all(sessionId) as KernelDecisionRow[]).map(rowToRecord);
  }

  listByCorrelation(correlationId: string): KernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_decisions WHERE correlation_id = ? ORDER BY created_at ASC, id ASC
    `).all(correlationId) as KernelDecisionRow[]).map(rowToRecord);
  }

  listByTask(taskId: string): KernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_decisions WHERE task_id = ? ORDER BY created_at ASC, id ASC
    `).all(taskId) as KernelDecisionRow[]).map(rowToRecord);
  }

  listCurrentByAction(action: KernelDecision['action']['type']): KernelDecisionLedgerRecord[] {
    return (this.db.prepare(`
      SELECT decision.*
      FROM kernel_decisions decision
      WHERE decision.action = ?
        AND decision.task_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM kernel_decisions later
          WHERE later.task_id = decision.task_id
            AND later.action NOT IN ('no_op', 'probe_capacity')
            AND (later.created_at > decision.created_at
              OR (later.created_at = decision.created_at AND later.id > decision.id))
        )
      ORDER BY decision.created_at ASC, decision.id ASC
    `).all(action) as KernelDecisionRow[]).map(rowToRecord);
  }
}

function rowToRecord(row: KernelDecisionRow): KernelDecisionLedgerRecord {
  assertCurrentSchema(row.schema_version, 'decision');
  const event = parseCurrentKernelValue<KernelEvent>(row.event_json, 'event');
  const snapshot = parseCurrentKernelValue<KernelSnapshot>(row.snapshot_json, 'snapshot');
  const decision = parseCurrentKernelValue<KernelDecision>(row.decision_json, 'decision');
  return {
    id: row.id,
    schemaVersion: 5,
    eventId: row.event_id,
    eventType: row.event_type,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    event,
    snapshot,
    decision,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function assertCurrentSchema(schemaVersion: number, kind: string): asserts schemaVersion is 5 {
  if (schemaVersion !== 5) {
    throw new Error(`unsupported Kernel ${kind} schema version ${schemaVersion}`);
  }
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
