import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  approvePatchCandidate,
  generateSkillFeedback,
  listPatchCandidates,
  promoteLearningCandidate,
} from '../../src/commands/learning-commands.js';
import { SkillUsageEventRepo } from '../../src/storage/skill-usage-event-repo.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';
import type { CommandContext, ResolvedCommandArgs } from '../../src/commands/catalog.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function context(db: Database.Database): CommandContext {
  return { db } as never as CommandContext;
}

function args(positionals: ResolvedCommandArgs['positionals'] = {}): ResolvedCommandArgs {
  return { positionals, options: {} };
}

describe('learning skill feedback loop', () => {
  it('turns runtime skill feedback into patch candidates and supports approve/promote review', async () => {
    const db = createDb();
    new SkillUsageEventRepo(db).insert({
      id: 'sue_feedback_1',
      taskId: 'task_feedback_1',
      executionId: 'exec_feedback_1',
      executorName: 'codex-cli',
      skillName: 'tdd-implementation',
      skillVersion: '1.0.0',
      eventType: 'skill_suggested_patch',
      message: '以后这个 Skill 要先写失败测试并确认 RED，再实现代码。',
      payload: {
        suggestedPatch: 'Add RED verification before implementation.',
        targetSkill: 'tdd-implementation',
      },
      createdAt: '2026-05-21T01:00:00.000Z',
    });

    const feedback = await generateSkillFeedback(args(), context(db));
    expect(feedback.content).toContain('已生成 Skill Runtime Feedback');

    const candidateRepo = new LearningCandidateRepo(db);
    const candidate = candidateRepo.listPending()[0];
    expect(candidate).toMatchObject({
      kind: 'skill_patch',
      sourceSkillUsageEventId: 'sue_feedback_1',
      sourceTaskId: 'task_feedback_1',
      safetyStatus: 'passed',
    });
    expect(candidate.content).toContain('先写失败测试');

    const duplicateFeedback = await generateSkillFeedback(args(), context(db));
    expect(duplicateFeedback.content).toContain('0 个候选');

    const list = await listPatchCandidates(args(), context(db));
    expect(list.content).toContain('Skill Patch Candidates');
    expect(list.content).toContain(candidate.id);

    const approve = await approvePatchCandidate(args({ candidateId: candidate.id }), context(db));
    expect(approve.content).toContain('已批准 Skill Patch Candidate');

    const promote = await promoteLearningCandidate(args({ candidateId: candidate.id }), context(db));
    expect(promote.content).toContain('不支持 Skill 更新');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate(candidate.id)[0]).toMatchObject({
      action: 'update',
      status: 'unsupported',
    });
  });
});
