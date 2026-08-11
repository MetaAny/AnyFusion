import type Database from 'better-sqlite3';
import type {
  AttemptSandboxPersistenceRecord,
  AttemptSandboxRepositoryPort,
} from '../execution/repositories.js';

interface Row {
  attempt_id: string;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  work_unit_id: string;
  workspace_id: string;
  runtime_handle: string;
  process_id: number | null;
  status: AttemptSandboxPersistenceRecord['status'];
  lease_token: string;
  labels_json: string;
  exit_code: number | null;
  result_collected_at: string | null;
  cleanup_status: string | null;
  cleanup_error: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): AttemptSandboxPersistenceRecord {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    workUnitId: row.work_unit_id,
    workspaceId: row.workspace_id,
    runtimeHandle: row.runtime_handle,
    processId: row.process_id,
    status: row.status,
    leaseToken: row.lease_token,
    labels: JSON.parse(row.labels_json) as Record<string, string>,
    exitCode: row.exit_code,
    resultCollectedAt: row.result_collected_at,
    cleanupStatus: row.cleanup_status,
    cleanupError: row.cleanup_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteAttemptSandboxRepository implements AttemptSandboxRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  create(record: AttemptSandboxPersistenceRecord): AttemptSandboxPersistenceRecord {
    this.db.prepare(`
      INSERT INTO attempt_sandboxes (
        attempt_id, task_id, generation_id, subtask_id, work_unit_id,
        workspace_id, runtime_handle, process_id, status, lease_token,
        labels_json, exit_code, result_collected_at, cleanup_status,
        cleanup_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(
      record.attemptId, record.taskId, record.generationId, record.subtaskId,
      record.workUnitId, record.workspaceId, record.runtimeHandle, record.processId,
      record.status, record.leaseToken, JSON.stringify(record.labels),
      record.exitCode, record.resultCollectedAt, record.cleanupStatus,
      record.cleanupError, record.createdAt, record.updatedAt,
    );
    return this.find(record.attemptId)!;
  }

  find(attemptId: string): AttemptSandboxPersistenceRecord | null {
    const row = this.db.prepare('SELECT * FROM attempt_sandboxes WHERE attempt_id = ?').get(attemptId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  findByRuntimeHandle(runtimeHandle: string): AttemptSandboxPersistenceRecord | null {
    const row = this.db.prepare('SELECT * FROM attempt_sandboxes WHERE runtime_handle = ?').get(runtimeHandle) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  listActive(): AttemptSandboxPersistenceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM attempt_sandboxes WHERE status IN ('created', 'running', 'paused') ORDER BY created_at, attempt_id
    `).all() as Row[]).map(fromRow);
  }

  update(attemptId: string, changes: Parameters<AttemptSandboxRepositoryPort['update']>[1]): void {
    const existing = this.find(attemptId);
    if (!existing) return;
    this.db.prepare(`
      UPDATE attempt_sandboxes SET process_id = ?, status = ?, exit_code = ?, result_collected_at = ?,
        cleanup_status = ?, cleanup_error = ?, updated_at = ? WHERE attempt_id = ?
    `).run(
      changes.processId === undefined ? existing.processId : changes.processId,
      changes.status ?? existing.status,
      changes.exitCode === undefined ? existing.exitCode : changes.exitCode,
      changes.resultCollectedAt === undefined ? existing.resultCollectedAt : changes.resultCollectedAt,
      changes.cleanupStatus === undefined ? existing.cleanupStatus : changes.cleanupStatus,
      changes.cleanupError === undefined ? existing.cleanupError : changes.cleanupError,
      changes.updatedAt ?? new Date().toISOString(),
      attemptId,
    );
  }
}
