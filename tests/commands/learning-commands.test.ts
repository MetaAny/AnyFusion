import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { approveLearningCandidate, listLearningCandidates } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import type { CommandContext, ResolvedCommandArgs } from '../../src/commands/catalog.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function args(positionals: ResolvedCommandArgs['positionals'] = {}): ResolvedCommandArgs {
  return { positionals, options: {} };
}

describe('learning review commands', () => {
  it('lists pending learning candidates and supports approve/reject review actions', async () => {
    const db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const context = { db, memoryEngine } as never as CommandContext;
    const repo = new LearningCandidateRepo(db);

    repo.insert({
      id: 'lc_review_1',
      kind: 'skill',
      status: 'pending',
      title: '复用飞书截断调试流程',
      content: '先定位发送层 chunking，再做端到端验证。',
      sourceSkillUsageEventId: null,
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: null,
      createdAt: '2026-04-27T00:00:00Z',
      updatedAt: '2026-04-27T00:00:00Z',
    });

    const list = await listLearningCandidates(args(), context);
    expect(list.content).toContain('待审核学习候选');
    expect(list.content).toContain('lc_review_1');
    expect(list.content).toContain('复用飞书截断调试流程');

    const approve = await approveLearningCandidate(
      args({ candidateId: 'lc_review_1', note: '确认可沉淀' }),
      context,
    );
    expect(approve.content).toContain('已批准学习候选');
    expect(repo.findById('lc_review_1')?.status).toBe('approved');

    const empty = await listLearningCandidates(args(), context);
    expect(empty.content).toContain('暂无待审核学习候选');
  });
});
