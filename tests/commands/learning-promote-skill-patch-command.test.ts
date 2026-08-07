import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { promoteLearningCandidate } from '../../src/commands/learning-commands.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo } from '../../src/storage/executor-skill-install-event-repo.js';
import type { CommandContext, ResolvedCommandArgs } from '../../src/commands/catalog.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertPatchCandidate(repo: LearningCandidateRepo, overrides: Partial<Parameters<LearningCandidateRepo['insert']>[0]> = {}) {
  repo.insert({
    id: 'lc_patch_promote_1',
    kind: 'skill_patch',
    status: 'approved',
    title: 'Patch systematic-debugging RED confirmation step',
    content: 'Add guidance to confirm RED before production edits.',
    sourceSkillUsageEventId: null,
    sourceTaskId: 'task_e4',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: 'systematic-debugging',
    createdAt: '2026-04-27T02:00:00.000Z',
    updatedAt: '2026-04-27T02:00:00.000Z',
    ...overrides,
  });
}

function commandContext(db: Database.Database): CommandContext {
  return {
    db,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
  } as never as CommandContext;
}

function args(candidateId: string): ResolvedCommandArgs {
  return { positionals: { candidateId }, options: {} };
}

describe('learning promote skill_patch UX', () => {
  it('records an unsupported update audit for approved safe skill_patch candidates', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertPatchCandidate(repo);

    const result = await promoteLearningCandidate(args('lc_patch_promote_1'), commandContext(db));

    expect(result.content).toContain('不支持 Skill 更新');
    expect(repo.findById('lc_patch_promote_1')?.status).toBe('approved');
    const audits = new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_patch_promote_1');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: 'unsupported',
      action: 'update',
      executorName: 'sandboxed',
      packageId: 'pkg_lc_patch_promote_1',
    });
  });

  it('blocks skill_patch candidates that are still pending review', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertPatchCandidate(repo, { status: 'pending' });

    const result = await promoteLearningCandidate(args('lc_patch_promote_1'), commandContext(db));

    expect(result.content).toContain('不能 promotion');
    expect(new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_patch_promote_1')[0]).toMatchObject({
      status: 'blocked',
      action: 'update',
    });
  });
});
