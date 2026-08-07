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

function insertCandidate(repo: LearningCandidateRepo, overrides: Partial<Parameters<LearningCandidateRepo['insert']>[0]> = {}) {
  repo.insert({
    id: 'lc_promote_1',
    kind: 'skill',
    status: 'approved',
    title: 'Reusable MetaClaw verification workflow',
    content: 'Run targeted tests, lint, build, and full regression before delivery.',
    sourceSkillUsageEventId: null,
    sourceTaskId: 'task_1',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: null,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
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

describe('learning promote UX', () => {
  it('records an unsupported install audit for approved safe skill candidates', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertCandidate(repo);

    const result = await promoteLearningCandidate(args('lc_promote_1'), commandContext(db));

    expect(result.content).toContain('不支持 Skill 安装');
    expect(repo.findById('lc_promote_1')?.status).toBe('approved');
    const audits = new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_promote_1');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: 'unsupported',
      action: 'install',
      executorName: 'sandboxed',
      packageId: 'pkg_lc_promote_1',
    });
  });

  it('blocks rejected, pending, or unsafe candidates before building a skill package', async () => {
    const db = createTestDb();
    const repo = new LearningCandidateRepo(db);
    insertCandidate(repo, { status: 'pending' });

    const result = await promoteLearningCandidate(args('lc_promote_1'), commandContext(db));

    expect(result.content).toContain('不能 promotion');
    const audits = new ExecutorSkillInstallEventRepo(db).listByCandidate('lc_promote_1');
    expect(audits[0]).toMatchObject({ status: 'blocked', packageId: null });
  });
});
