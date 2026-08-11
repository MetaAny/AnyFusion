import type Database from 'better-sqlite3';

export interface SmokeRunAudit {
  runId: string;
  scenario: string;
  executorId: string | null;
  result: string;
  diagnostics: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export class SmokeRunAuditRepo {
  constructor(private readonly db: Database.Database) {}

  record(audit: SmokeRunAudit): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO smoke_run_audits (
          run_id, scenario, executor_id, result, diagnostics_json, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          result = excluded.result,
          diagnostics_json = excluded.diagnostics_json,
          completed_at = excluded.completed_at
      `).run(
        audit.runId,
        audit.scenario,
        audit.executorId,
        audit.result,
        JSON.stringify(audit.diagnostics),
        audit.startedAt,
        audit.completedAt,
      );
      this.db.prepare(`
        DELETE FROM smoke_run_audits
        WHERE run_id NOT IN (
          SELECT run_id FROM smoke_run_audits
          ORDER BY completed_at DESC, run_id DESC
          LIMIT 20
        )
      `).run();
    })();
  }

  list(limit = 20): SmokeRunAudit[] {
    return (this.db.prepare(`
      SELECT * FROM smoke_run_audits
      ORDER BY completed_at DESC, run_id DESC
      LIMIT ?
    `).all(Math.min(20, Math.max(1, limit))) as Array<{
      run_id: string;
      scenario: string;
      executor_id: string | null;
      result: string;
      diagnostics_json: string;
      started_at: string;
      completed_at: string;
    }>).map(row => ({
      runId: row.run_id,
      scenario: row.scenario,
      executorId: row.executor_id,
      result: row.result,
      diagnostics: JSON.parse(row.diagnostics_json) as Record<string, unknown>,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  }
}
