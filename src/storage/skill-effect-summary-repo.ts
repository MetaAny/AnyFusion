import type Database from 'better-sqlite3';
import type { PersistedSkillUsageEventType } from './skill-usage-event-repo.js';

interface SkillEffectSummaryRow {
  id: string;
  executor_name: string;
  skill_name: string;
  skill_version: string | null;
  used_count: number;
  success_count: number;
  failure_count: number;
  helpful_count: number;
  patch_candidate_count: number;
  last_used_at: string;
  last_failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillEffectSummaryRecord {
  id: string;
  executorName: string;
  skillName: string;
  skillVersion: string | null;
  usedCount: number;
  successCount: number;
  failureCount: number;
  helpfulCount: number;
  patchCandidateCount: number;
  lastUsedAt: string;
  lastFailureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillEffectUsageInput {
  executorName: string;
  skillName: string;
  skillVersion: string | null;
  eventType: PersistedSkillUsageEventType;
  helpful: boolean;
  patchCandidateCreated: boolean;
  failureReason: string | null;
  usedAt: string;
}

function rowToSummary(row: SkillEffectSummaryRow): SkillEffectSummaryRecord {
  return {
    id: row.id,
    executorName: row.executor_name,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    usedCount: row.used_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    helpfulCount: row.helpful_count,
    patchCandidateCount: row.patch_candidate_count,
    lastUsedAt: row.last_used_at,
    lastFailureReason: row.last_failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summaryId(input: { executorName: string; skillName: string; skillVersion: string | null }): string {
  const version = input.skillVersion ?? 'unversioned';
  return `ses_${Buffer.from(`${input.executorName}:${input.skillName}:${version}`).toString('base64url').slice(0, 40)}`;
}

function successIncrement(eventType: PersistedSkillUsageEventType): number {
  return eventType === 'skill_completed' ? 1 : 0;
}

function failureIncrement(eventType: PersistedSkillUsageEventType): number {
  return eventType === 'skill_failed' ? 1 : 0;
}

export class SkillEffectSummaryRepo {
  constructor(private readonly db: Database.Database) {}

  recordUsage(input: SkillEffectUsageInput): void {
    const success = successIncrement(input.eventType);
    const failure = failureIncrement(input.eventType);
    const helpful = input.helpful ? 1 : 0;
    const patch = input.patchCandidateCreated ? 1 : 0;
    const id = summaryId(input);

    this.db.prepare(`
      INSERT INTO skill_effect_summaries (
        id, executor_name, skill_name, skill_version, used_count, success_count,
        failure_count, helpful_count, patch_candidate_count, last_used_at,
        last_failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(executor_name, skill_name, skill_version_key) DO UPDATE SET
        used_count = used_count + excluded.used_count,
        success_count = success_count + excluded.success_count,
        failure_count = failure_count + excluded.failure_count,
        helpful_count = helpful_count + excluded.helpful_count,
        patch_candidate_count = patch_candidate_count + excluded.patch_candidate_count,
        last_used_at = excluded.last_used_at,
        last_failure_reason = COALESCE(excluded.last_failure_reason, skill_effect_summaries.last_failure_reason),
        updated_at = excluded.updated_at
    `).run(
      id,
      input.executorName,
      input.skillName,
      input.skillVersion,
      1,
      success,
      failure,
      helpful,
      patch,
      input.usedAt,
      input.failureReason,
      input.usedAt,
      input.usedAt,
    );
  }

  listTop(limit = 10): SkillEffectSummaryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM skill_effect_summaries
      ORDER BY used_count DESC, updated_at DESC
      LIMIT ?
    `).all(limit) as SkillEffectSummaryRow[];
    return rows.map(rowToSummary);
  }
}
