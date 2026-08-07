import type Database from 'better-sqlite3';

export type LearningCandidateKind =
  | 'skill'
  | 'skill_patch'
  | 'preference'
  | 'workflow'
  | 'antipattern'
  | 'verification_recipe'
  | 'task_memory_card'
  | 'skill_deprecation'
  | 'skill_disable'
  | 'safety_rule';
export type LearningCandidateStatus = 'pending' | 'approved' | 'rejected' | 'promoted';
export type LearningCandidateSafetyStatus = 'pending' | 'passed' | 'blocked';

interface LearningCandidateRow {
  id: string;
  kind: LearningCandidateKind;
  status: LearningCandidateStatus;
  title: string;
  content: string;
  source_skill_usage_event_id: string | null;
  source_task_id: string | null;
  safety_status: LearningCandidateSafetyStatus;
  safety_reasons_json: string;
  review_note: string | null;
  promoted_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LearningCandidateRecord {
  id: string;
  kind: LearningCandidateKind;
  status: LearningCandidateStatus;
  title: string;
  content: string;
  sourceSkillUsageEventId: string | null;
  sourceTaskId: string | null;
  safetyStatus: LearningCandidateSafetyStatus;
  safetyReasons: string[];
  reviewNote: string | null;
  promotedAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningCandidateInsert extends LearningCandidateRecord {}

export interface LearningCandidateReviewUpdate {
  status: LearningCandidateStatus;
  reviewNote?: string | null;
  promotedAssetId?: string | null;
  updatedAt: string;
}

function rowToLearningCandidate(row: LearningCandidateRow): LearningCandidateRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    content: row.content,
    sourceSkillUsageEventId: row.source_skill_usage_event_id,
    sourceTaskId: row.source_task_id,
    safetyStatus: row.safety_status,
    safetyReasons: JSON.parse(row.safety_reasons_json || '[]'),
    reviewNote: row.review_note,
    promotedAssetId: row.promoted_asset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LearningCandidateRepo {
  constructor(private db: Database.Database) {}

  insert(record: LearningCandidateInsert): void {
    this.db.prepare(`
      INSERT INTO learning_candidates (
        id, kind, status, title, content, source_skill_usage_event_id, source_task_id,
        safety_status, safety_reasons_json, review_note, promoted_asset_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.kind,
      record.status,
      record.title,
      record.content,
      record.sourceSkillUsageEventId,
      record.sourceTaskId,
      record.safetyStatus,
      JSON.stringify(record.safetyReasons),
      record.reviewNote,
      record.promotedAssetId,
      record.createdAt,
      record.updatedAt,
    );
  }

  findById(id: string): LearningCandidateRecord | null {
    const row = this.db.prepare('SELECT * FROM learning_candidates WHERE id = ?').get(id) as LearningCandidateRow | undefined;
    return row ? rowToLearningCandidate(row) : null;
  }

  existsForSkillUsageEvent(eventId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM learning_candidates
      WHERE source_skill_usage_event_id = ?
      LIMIT 1
    `).get(eventId));
  }

  listPending(): LearningCandidateRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM learning_candidates
      WHERE status = 'pending'
      ORDER BY created_at DESC
    `).all() as LearningCandidateRow[];
    return rows.map(rowToLearningCandidate);
  }

  updateReview(id: string, update: LearningCandidateReviewUpdate): void {
    this.db.prepare(`
      UPDATE learning_candidates
      SET status = ?, review_note = ?, promoted_asset_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      update.status,
      update.reviewNote ?? null,
      update.promotedAssetId ?? null,
      update.updatedAt,
      id,
    );
  }
}
