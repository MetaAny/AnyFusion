import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { buildLearningWeeklyReview } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { TaskMemoryCardRepo } from '../../src/storage/task-memory-card-repo.js';
import { SkillEffectSummaryRepo } from '../../src/storage/skill-effect-summary-repo.js';
import type { CommandContext } from '../../src/commands/catalog.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function commandContext(db: Database.Database): CommandContext {
  return {
    db,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
  } as never as CommandContext;
}

function seedWeeklyReviewData(db: Database.Database): void {
  new LearningCandidateRepo(db).insert({
    id: 'lc_weekly_skill',
    kind: 'skill',
    status: 'pending',
    title: '建议沉淀 Skill：weekly-release-checklist',
    content: 'Candidate',
    sourceSkillUsageEventId: null,
    sourceTaskId: 'task_1',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: null,
    createdAt: '2026-04-24T00:00:00Z',
    updatedAt: '2026-04-24T00:00:00Z',
  });

  new TaskMemoryCardRepo(db).insert({
    id: 'tmc_weekly_1',
    taskId: 'task_1',
    title: '完成 E6 Skill 治理闭环',
    goal: '让 MetaClaw 生成可审核治理候选',
    summary: '已完成 governance candidates。',
    keyDecisions: ['promote 才执行有副作用动作'],
    changedFiles: [],
    verificationCommands: ['npm test'],
    pitfalls: [],
    artifacts: [],
    outcome: 'success',
    sourceCandidateId: null,
    createdAt: '2026-04-24T00:00:00Z',
    updatedAt: '2026-04-24T00:00:00Z',
  });

  const summaryRepo = new SkillEffectSummaryRepo(db);
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
}

describe('learning E7 weekly self-review', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a weekly learning report with actionable review commands', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));

    const db = createTestDb();
    seedWeeklyReviewData(db);

    const result = await buildLearningWeeklyReview({ positionals: {}, options: {} }, commandContext(db));

    expect(result.content).toContain('MetaClaw 学习周报');
    expect(result.content).toContain('## 待审核学习候选');
    expect(result.content).toContain('/learning approve lc_weekly_skill');
    expect(result.content).toContain('## 最近任务记忆卡');
    expect(result.content).toContain('完成 E6 Skill 治理闭环');
    expect(result.content).toContain('## Skill 治理建议');
    expect(result.content).toContain('fragile-skill');
    expect(result.type === 'text' ? result.payload : undefined).toMatchObject({
      weeklyReview: { pendingCandidateCount: 1, taskMemoryCardCount: 1, governanceRecommendationCount: 1 },
    });
  });
});
