import type Database from 'better-sqlite3';
import { redactSkillUsageEventPayload, redactSkillUsageEventText } from '../executor/skill-usage-event-parser.js';
import { SkillEffectSummaryRepo } from './skill-effect-summary-repo.js';

export type SkillUsageEventType =
  | 'skill_started'
  | 'skill_step_started'
  | 'skill_step_completed'
  | 'skill_progress'
  | 'skill_completed'
  | 'skill_failed'
  | 'skill_skipped'
  | 'skill_suggested_patch';

export type PersistedSkillUsageEventType = Extract<
  SkillUsageEventType,
  'skill_completed' | 'skill_failed' | 'skill_skipped' | 'skill_suggested_patch'
>;

const PERSISTED_EVENT_TYPES = new Set<SkillUsageEventType>([
  'skill_completed',
  'skill_failed',
  'skill_skipped',
  'skill_suggested_patch',
]);

function isPersistedEventType(eventType: SkillUsageEventType): eventType is PersistedSkillUsageEventType {
  return PERSISTED_EVENT_TYPES.has(eventType);
}

interface SkillUsageEventRow {
  id: string;
  task_id: string;
  execution_id: string;
  executor_name: string;
  skill_name: string;
  skill_version: string | null;
  event_type: PersistedSkillUsageEventType;
  message: string;
  payload_json: string;
  created_at: string;
}

export interface SkillUsageEventRecord {
  id: string;
  taskId: string;
  executionId: string;
  executorName: string;
  skillName: string;
  skillVersion: string | null;
  eventType: PersistedSkillUsageEventType;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type SkillUsageEventInsert = Omit<SkillUsageEventRecord, 'eventType'> & {
  eventType: SkillUsageEventType;
};

function rowToSkillUsageEvent(row: SkillUsageEventRow): SkillUsageEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    executorName: row.executor_name,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    eventType: row.event_type,
    message: row.message,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export class SkillUsageEventRepo {
  constructor(private readonly db: Database.Database) {}

  insert(record: SkillUsageEventInsert): void {
    if (!isPersistedEventType(record.eventType)) return;

    const eventType = record.eventType;
    const message = redactSkillUsageEventText(record.message);
    const payload = redactSkillUsageEventPayload(record.payload);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO executor_skill_usage_events (
          id, task_id, execution_id, executor_name, skill_name, skill_version,
          event_type, message, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.taskId,
        record.executionId,
        record.executorName,
        record.skillName,
        record.skillVersion,
        record.eventType,
        message,
        JSON.stringify(payload),
        record.createdAt,
      );
      new SkillEffectSummaryRepo(this.db).recordUsage({
        executorName: record.executorName,
        skillName: record.skillName,
        skillVersion: record.skillVersion,
        eventType,
        helpful: payload.helpful === true || eventType === 'skill_completed',
        patchCandidateCreated: eventType === 'skill_suggested_patch',
        failureReason: eventType === 'skill_failed' ? message : null,
        usedAt: record.createdAt,
      });
    })();
  }

  listRecent(limit = 50): SkillUsageEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM executor_skill_usage_events
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as SkillUsageEventRow[];
    return rows.map(rowToSkillUsageEvent);
  }
}
