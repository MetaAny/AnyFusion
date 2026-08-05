import type Database from 'better-sqlite3';
import type { PlannerToolCallTrace } from '../planning/planner-process-runner.js';
import { generateInteractionId } from '../utils/id.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export interface PlannerRunAuditStart {
  id: string;
  sessionId: string;
  requestSource: string;
  createdAt: string;
}

export class PlannerRunRepo {
  constructor(private readonly db: Database.Database) {}

  start(sessionId: string, requestSource: string): PlannerRunAuditStart {
    const record = {
      id: `planner_run_${generateInteractionId()}`,
      sessionId,
      requestSource,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO planner_runs (
        id, session_id, request_source, status, attempt_count, duration_ms, created_at
      ) VALUES (?, ?, ?, 'running', 0, 0, ?)
    `).run(record.id, record.sessionId, record.requestSource, record.createdAt);
    return record;
  }

  finish(input: {
    id: string;
    status: 'completed' | 'failed';
    attemptCount: number;
    durationMs: number;
    errorSummary?: string | null;
    toolCalls: PlannerToolCallTrace[];
  }): void {
    const completedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE planner_runs
        SET status = ?, attempt_count = ?, duration_ms = ?, error_summary = ?, completed_at = ?
        WHERE id = ?
      `).run(
        input.status,
        input.attemptCount,
        input.durationMs,
        input.errorSummary ? truncate(redactSensitiveText(input.errorSummary), 500) : null,
        completedAt,
        input.id,
      );
      const statement = this.db.prepare(`
        INSERT INTO planner_tool_calls (
          id, planner_run_id, sequence, tool_name, status,
          arguments_summary_json, result_summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      input.toolCalls.forEach((call, index) => statement.run(
        `planner_tool_${generateInteractionId()}`,
        input.id,
        index + 1,
        truncate(call.toolName, 120),
        call.status,
        JSON.stringify(sanitizeSummary(call.argumentsSummary)),
        JSON.stringify(sanitizeSummary(call.resultSummary)),
        completedAt,
      ));
    })();
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function sanitizeSummary(value: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (/secret|token|key|content|conversation|prompt/i.test(key)) continue;
    if (typeof raw === 'string') summary[key] = truncate(raw, 200);
    else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) summary[key] = raw;
    else if (Array.isArray(raw)) summary[key] = { count: raw.length };
    else if (raw && typeof raw === 'object') summary[key] = { keys: Object.keys(raw).slice(0, 8) };
  }
  return summary;
}
