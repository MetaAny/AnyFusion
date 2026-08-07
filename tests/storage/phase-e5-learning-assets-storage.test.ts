import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';
import { SkillEffectSummaryRepo } from '../../src/storage/skill-effect-summary-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('Phase E5 learning asset storage', () => {
  it('persists task memory cards as queryable task-level recall assets', () => {
    const db = createTestDb();
    const repo = new TaskMemoryCardRepo(db);

    repo.insert({
      id: 'tmc_1',
      taskId: 'task_1',
      title: 'MetaClaw E4 skill patch promotion',
      goal: '完成 skill_patch updateSkill 闭环',
      summary: '实现了从 skill_suggested_patch 到 executor.updateSkill 的闭环。',
      keyDecisions: ['approve 与 promote 分离', 'Executor 自己选择 skill'],
      changedFiles: ['src/learning/skill-usage-candidate-builder.ts', 'src/commands/learning-commands.ts'],
      verificationCommands: ['npm test -- tests/integration/phase-e4-skill-patch-promotion.integration.test.ts', 'npm run lint'],
      pitfalls: ['approve update 时必须保留 promotedAssetId'],
      artifacts: ['docs/metaclaw-phase-e-unified-learning-and-executor-skill-evolution.md'],
      outcome: 'success',
      sourceCandidateId: 'lc_card_1',
      createdAt: '2026-04-27T02:00:00Z',
      updatedAt: '2026-04-27T02:00:00Z',
    });

    expect(repo.findByTaskId('task_1')).toMatchObject({
      id: 'tmc_1',
      taskId: 'task_1',
      title: 'MetaClaw E4 skill patch promotion',
      outcome: 'success',
      keyDecisions: ['approve 与 promote 分离', 'Executor 自己选择 skill'],
      verificationCommands: ['npm test -- tests/integration/phase-e4-skill-patch-promotion.integration.test.ts', 'npm run lint'],
      sourceCandidateId: 'lc_card_1',
    });
    expect(repo.listRecent(5)[0].taskId).toBe('task_1');
  });

  it('upserts skill effect summaries from skill usage outcomes', () => {
    const db = createTestDb();
    const repo = new SkillEffectSummaryRepo(db);

    repo.recordUsage({
      executorName: 'mock-executor',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_completed',
      helpful: true,
      patchCandidateCreated: false,
      failureReason: null,
      usedAt: '2026-04-27T02:00:00Z',
    });
    repo.recordUsage({
      executorName: 'mock-executor',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_failed',
      helpful: false,
      patchCandidateCreated: true,
      failureReason: 'missing verification step',
      usedAt: '2026-04-27T02:10:00Z',
    });

    const summary = repo.listTop(10)[0];
    expect(summary).toMatchObject({
      executorName: 'mock-executor',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      usedCount: 2,
      successCount: 1,
      failureCount: 1,
      helpfulCount: 1,
      patchCandidateCount: 1,
      lastUsedAt: '2026-04-27T02:10:00Z',
      lastFailureReason: 'missing verification step',
    });
    expect(repo.listTop(10)[0].skillName).toBe('test-driven-development');
  });
});
