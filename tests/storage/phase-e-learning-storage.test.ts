import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('Phase E learning storage', () => {
  it('persists learning candidates and supports review lifecycle updates', () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);

    repo.insert({
      id: 'lc_1',
      kind: 'skill',
      status: 'pending',
      title: '调试 Feishu 输出截断流程',
      content: '遇到飞书输出截断时，先定位发送层 chunking，再验证端到端。',
      sourceSkillUsageEventId: 'sue_1',
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: null,
      createdAt: '2026-04-27T00:00:00Z',
      updatedAt: '2026-04-27T00:00:00Z',
    });

    expect(repo.listPending()).toHaveLength(1);
    expect(repo.existsForSkillUsageEvent('sue_1')).toBe(true);

    repo.updateReview('lc_1', {
      status: 'approved',
      reviewNote: '用户确认可沉淀为 Skill candidate',
      updatedAt: '2026-04-27T00:05:00Z',
    });

    const approved = repo.findById('lc_1');
    expect(approved?.status).toBe('approved');
    expect(approved?.reviewNote).toBe('用户确认可沉淀为 Skill candidate');
    expect(approved?.updatedAt).toBe('2026-04-27T00:05:00Z');
    expect(repo.listPending()).toHaveLength(0);
  });
});
