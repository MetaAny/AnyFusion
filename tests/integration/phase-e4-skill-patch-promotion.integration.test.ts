import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillUsageCandidateBuilder } from '../../src/learning/skill-usage-candidate-builder.js';
import { promoteLearningCandidate } from '../../src/commands/learning-commands.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';
import type { SkillUsageEventRecord } from '../../src/storage/skill-usage-event-repo.js';
import type { CommandContext, ResolvedCommandArgs } from '../../src/commands/catalog.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function createPatchEvent(overrides: Partial<SkillUsageEventRecord> = {}): SkillUsageEventRecord {
  return {
    id: 'skill_evt_e4_integration',
    taskId: 'task_e4_integration',
    executionId: 'exec_e4_integration',
    executorName: 'sandboxed',
    skillName: 'systematic-debugging',
    skillVersion: '1.0.0',
    eventType: 'skill_suggested_patch',
    message: 'Add explicit RED verification before implementation.',
    payload: {
      proposedPatch: '- Always run targeted failing test before production code',
      reason: 'Executor skipped RED confirmation once',
    },
    createdAt: '2026-04-27T03:00:00.000Z',
    ...overrides,
  };
}

function createContext(db: Database.Database): CommandContext {
  return {
    db,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
  } as never as CommandContext;
}

function args(candidateId: string): ResolvedCommandArgs {
  return { positionals: { candidateId }, options: {} };
}

describe('Phase E4 skill patch promotion integration', () => {
  it('builds a skill_patch package from reviewed safe usage feedback and records an unsupported update audit', async () => {
    const db = createDb();
    const candidate = new SkillUsageCandidateBuilder().build(createPatchEvent());
    const candidateRepo = new LearningCandidateRepo(db);
    candidateRepo.insert(candidate);
    candidateRepo.updateReview(candidate.id, {
      status: 'approved',
      reviewNote: 'version:1.0.2',
      promotedAssetId: candidate.promotedAssetId,
      updatedAt: '2026-04-27T03:01:00.000Z',
    });

    const result = await promoteLearningCandidate(args(candidate.id), createContext(db));

    expect(result.content).toContain('不支持 Skill 更新');
    expect(candidateRepo.findById(candidate.id)?.status).toBe('approved');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate(candidate.id)[0]).toMatchObject({
      action: 'update',
      status: 'unsupported',
      executorName: 'sandboxed',
      packageId: `pkg_${candidate.id}`,
    });
  });

  it('blocks unsafe skill_patch content before building a package', async () => {
    const db = createDb();
    const candidate = new SkillUsageCandidateBuilder().build(createPatchEvent({
      message: 'Add token handling step',
      payload: { proposedPatch: 'token=sk-1234567890abcdef1234567890abcdef' },
    }));
    const candidateRepo = new LearningCandidateRepo(db);
    candidateRepo.insert(candidate);
    candidateRepo.updateReview(candidate.id, {
      status: 'approved',
      reviewNote: null,
      updatedAt: '2026-04-27T03:01:00.000Z',
    });

    const result = await promoteLearningCandidate(args(candidate.id), createContext(db));

    expect(result.content).toContain('不能 promotion');
    expect(candidateRepo.findById(candidate.id)?.status).toBe('approved');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate(candidate.id)[0]).toMatchObject({
      action: 'update',
      status: 'blocked',
    });
  });
});
