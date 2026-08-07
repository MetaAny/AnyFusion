import { describe, expect, it } from 'vitest';
import { buildExecutorSkillPackage } from '../../src/executor/skill-package-builder.js';
import type { LearningCandidateRecord } from '../../src/storage/learning-candidate-repo.js';

function candidate(overrides: Partial<LearningCandidateRecord> = {}): LearningCandidateRecord {
  return {
    id: 'lc_skill_pkg_1',
    kind: 'skill',
    status: 'approved',
    title: 'Feishu output chunking debug workflow',
    content: '1. Reproduce truncation.\n2. Inspect Feishu sender chunking.\n3. Run integration tests.',
    sourceSkillUsageEventId: 'sue_1',
    sourceTaskId: 'task_1',
    safetyStatus: 'passed',
    safetyReasons: [],
    reviewNote: null,
    promotedAssetId: null,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('ExecutorSkillPackage builder', () => {
  it('builds a portable skill package only from approved safe skill candidates', () => {
    const pkg = buildExecutorSkillPackage(candidate(), { now: '2026-04-27T10:00:00.000Z' });

    expect(pkg).toMatchObject({
      id: 'pkg_lc_skill_pkg_1',
      candidateId: 'lc_skill_pkg_1',
      name: 'feishu-output-chunking-debug-workflow',
      version: '1.0.0',
      kind: 'skill',
      bodyMarkdown: expect.stringContaining('Feishu output chunking debug workflow'),
      safetyStatus: 'passed',
      createdAt: '2026-04-27T10:00:00.000Z',
    });
    expect(pkg.files).toEqual([]);
  });

  it('blocks pending, rejected, unsafe, or non-skill candidates', () => {
    expect(() => buildExecutorSkillPackage(candidate({ status: 'pending' }))).toThrow(/approved/i);
    expect(() => buildExecutorSkillPackage(candidate({ safetyStatus: 'blocked' }))).toThrow(/safety/i);
    expect(() => buildExecutorSkillPackage(candidate({ kind: 'preference' }))).toThrow(/skill/i);
  });

  it('blocks secret-like content and unsafe supporting file paths', () => {
    expect(() => buildExecutorSkillPackage(candidate({
      content: 'Use api_key=secret-value when calling the service',
    }))).toThrow(/secret/i);

    expect(() => buildExecutorSkillPackage(candidate(), {
      files: [{ path: '../escape.md', content: 'bad' }],
    })).toThrow(/path/i);

    expect(() => buildExecutorSkillPackage(candidate(), {
      files: [{ path: 'references/.env', content: 'TOKEN=***' }],
    })).toThrow(/credential|path|secret/i);

    expect(() => buildExecutorSkillPackage(candidate(), {
      files: [{ path: 'references/guide.md', content: 'token=secret-value' }],
    })).toThrow(/secret/i);
  });
});
