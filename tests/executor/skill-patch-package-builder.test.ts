import { describe, expect, it } from 'vitest';
import { buildExecutorSkillPackage } from '../../src/executor/skill-package-builder.js';
import type { LearningCandidateRecord } from '../../src/storage/learning-candidate-repo.js';

function candidate(overrides: Partial<LearningCandidateRecord> = {}): LearningCandidateRecord {
  return {
    id: 'lc_patch_1',
    kind: 'skill_patch',
    status: 'approved',
    title: 'Patch systematic-debugging missing RED confirmation step',
    content: 'Add a Pitfalls note: always confirm RED failure before modifying production code.',
    sourceSkillUsageEventId: 'sue_patch_1',
    sourceTaskId: 'task_e4',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: 'systematic-debugging',
    createdAt: '2026-04-27T02:00:00.000Z',
    updatedAt: '2026-04-27T02:00:00.000Z',
    ...overrides,
  };
}

describe('Executor skill package builder patch packages', () => {
  it('builds skill_patch packages for approved safe patch candidates targeting an existing skill', () => {
    const pkg = buildExecutorSkillPackage(candidate(), { now: '2026-04-27T02:10:00.000Z' });

    expect(pkg).toMatchObject({
      id: 'pkg_lc_patch_1',
      candidateId: 'lc_patch_1',
      kind: 'skill_patch',
      name: 'systematic-debugging',
      version: '1.0.1',
      safetyStatus: 'passed',
      createdAt: '2026-04-27T02:10:00.000Z',
    });
    expect(pkg.bodyMarkdown).toContain('Patch systematic-debugging');
    expect(pkg.bodyMarkdown).toContain('confirm RED failure');
  });

  it('blocks skill_patch candidates without a promotedAssetId target', () => {
    expect(() => buildExecutorSkillPackage(candidate({ promotedAssetId: null }))).toThrow(/target/i);
  });

  it('blocks non patchable candidate kinds from update packages', () => {
    expect(() => buildExecutorSkillPackage(candidate({ kind: 'antipattern' }))).toThrow(/skill/i);
    expect(() => buildExecutorSkillPackage(candidate({ kind: 'verification_recipe' }))).toThrow(/skill/i);
  });
});
