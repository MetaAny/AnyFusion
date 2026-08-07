import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';
import { SkillEffectSummaryRepo } from '../../src/storage/skill-effect-summary-repo.js';
import { LearningWeeklyReviewBuilder } from '../../src/learning/learning-weekly-review-builder.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('LearningWeeklyReviewBuilder', () => {
  it('builds an auditable weekly learning review from pending candidates, memory cards, and skill risks', () => {
    const db = createTestDb();
    const candidateRepo = new LearningCandidateRepo(db);
    const cardRepo = new TaskMemoryCardRepo(db);
    const summaryRepo = new SkillEffectSummaryRepo(db);

    candidateRepo.insert({
      id: 'lc_disable_1',
      kind: 'skill_disable',
      status: 'pending',
      title: '建议停用 Skill：fragile-skill',
      content: 'Skill Governance Candidate\nexecutor：mock-executor\nskill：fragile-skill\n推荐动作：disable',
      sourceSkillUsageEventId: null,
      sourceTaskId: null,
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: 'mock-executor/fragile-skill@1.0.0',
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    });
    candidateRepo.insert({
      id: 'lc_skill_1',
      kind: 'skill',
      status: 'pending',
      title: '建议沉淀 Skill：release-checklist',
      content: 'Candidate',
      sourceSkillUsageEventId: null,
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: null,
      createdAt: '2026-04-21T00:00:00Z',
      updatedAt: '2026-04-21T00:00:00Z',
    });

    cardRepo.insert({
      id: 'tmc_1',
      taskId: 'task_1',
      title: '完成 E6 Skill 治理闭环',
      goal: '让 MetaClaw 生成可审核治理候选',
      summary: '已完成 disable/deprecation candidate 与 promote audit。',
      keyDecisions: ['MetaClaw 不直接禁用 Skill'],
      changedFiles: ['src/learning/skill-governance-engine.ts'],
      verificationCommands: ['npm test -- tests/core/phase-e6-skill-governance-engine.test.ts'],
      pitfalls: ['旧 executor 可能不支持 governance API'],
      artifacts: [],
      outcome: 'success',
      sourceCandidateId: 'lc_task_memory_card_1',
      createdAt: '2026-04-22T00:00:00Z',
      updatedAt: '2026-04-22T00:00:00Z',
    });

    for (let i = 0; i < 4; i += 1) {
      summaryRepo.recordUsage({
        executorName: 'mock-executor',
        skillName: 'fragile-skill',
        skillVersion: '1.0.0',
        eventType: 'skill_failed',
        helpful: false,
        patchCandidateCreated: false,
        failureReason: 'same failure repeats',
        usedAt: `2026-04-2${i}T00:00:00Z`,
      });
    }

    const review = new LearningWeeklyReviewBuilder(db).build({
      now: '2026-04-27T00:00:00Z',
      since: '2026-04-20T00:00:00Z',
    });

    expect(review.title).toBe('MetaClaw 学习周报 2026-04-20 ~ 2026-04-27');
    expect(review.pendingCandidates).toHaveLength(2);
    expect(review.pendingCandidates[0]).toMatchObject({ id: 'lc_skill_1', kind: 'skill' });
    expect(review.recentTaskMemoryCards[0]).toMatchObject({ taskId: 'task_1', title: '完成 E6 Skill 治理闭环' });
    expect(review.skillGovernanceRecommendations[0]).toMatchObject({
      kind: 'skill_disable',
      title: '建议停用 Skill：fragile-skill',
    });
    expect(review.markdown).toContain('## 待审核学习候选');
    expect(review.markdown).toContain('/learning approve lc_skill_1');
    expect(review.markdown).toContain('/learning reject lc_disable_1');
    expect(review.markdown).toContain('## 最近任务记忆卡');
    expect(review.markdown).toContain('## Skill 治理建议');
    expect(review.markdown).toContain('mock-executor/fragile-skill@1.0.0');
  });
});
