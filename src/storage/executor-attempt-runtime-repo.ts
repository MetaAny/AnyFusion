import type Database from 'better-sqlite3';
import type { KernelRecoverySafety } from '../kernel/control-kernel.js';

export interface ExecutorAttemptRuntimeRecord {
  attemptId: string;
  sourceAttemptId: string | null;
  continuationToken: string | null;
  workspaceRoot: string | null;
  workspaceBaseline: Record<string, unknown>;
  workspaceDelta: Record<string, unknown>;
  progress: Record<string, unknown>;
  recoverySafety: KernelRecoverySafety;
  externalIdempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeRow {
  attempt_id: string;
  source_attempt_id: string | null;
  continuation_token: string | null;
  workspace_root: string | null;
  workspace_baseline_json: string;
  workspace_delta_json: string;
  progress_json: string;
  recovery_safety: KernelRecoverySafety;
  external_idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export class ExecutorAttemptRuntimeRepo {
  constructor(private readonly db: Database.Database) {}

  start(input: {
    attemptId: string;
    sourceAttemptId: string | null;
    workspaceRoot: string | null;
    workspaceBaseline?: Record<string, unknown>;
    recoverySafety: KernelRecoverySafety;
    externalIdempotencyKey?: string | null;
    now: string;
  }): ExecutorAttemptRuntimeRecord {
    this.db.prepare(`
      INSERT INTO executor_attempt_runtime (
        attempt_id, source_attempt_id, continuation_token, workspace_root,
        workspace_baseline_json, workspace_delta_json, progress_json,
        recovery_safety, external_idempotency_key, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, '{}', '{}', ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(
      input.attemptId,
      input.sourceAttemptId,
      input.workspaceRoot,
      JSON.stringify(input.workspaceBaseline ?? {}),
      input.recoverySafety,
      input.externalIdempotencyKey ?? null,
      input.now,
      input.now,
    );
    return this.find(input.attemptId)!;
  }

  recordContinuationToken(attemptId: string, token: string, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime
      SET continuation_token = ?, updated_at = ?
      WHERE attempt_id = ? AND (continuation_token IS NULL OR continuation_token = ?)
    `).run(token, now, attemptId, token);
  }

  recordProgress(attemptId: string, progress: Record<string, unknown>, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET progress_json = ?, updated_at = ? WHERE attempt_id = ?
    `).run(JSON.stringify(progress), now, attemptId);
  }

  recordWorkspaceDelta(attemptId: string, delta: object, now: string): void {
    this.db.prepare(`
      UPDATE executor_attempt_runtime SET workspace_delta_json = ?, updated_at = ? WHERE attempt_id = ?
    `).run(JSON.stringify(delta), now, attemptId);
  }

  find(attemptId: string): ExecutorAttemptRuntimeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM executor_attempt_runtime WHERE attempt_id = ?
    `).get(attemptId) as RuntimeRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row: RuntimeRow): ExecutorAttemptRuntimeRecord {
  return {
    attemptId: row.attempt_id,
    sourceAttemptId: row.source_attempt_id,
    continuationToken: row.continuation_token,
    workspaceRoot: row.workspace_root,
    workspaceBaseline: JSON.parse(row.workspace_baseline_json) as Record<string, unknown>,
    workspaceDelta: JSON.parse(row.workspace_delta_json) as Record<string, unknown>,
    progress: JSON.parse(row.progress_json) as Record<string, unknown>,
    recoverySafety: row.recovery_safety,
    externalIdempotencyKey: row.external_idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
