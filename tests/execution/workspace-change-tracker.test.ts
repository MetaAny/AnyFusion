import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  captureWorkspaceState,
  deriveGitCommitDelta,
  deriveWorkspaceDelta,
} from '../../src/execution/workspace-change-tracker.js';

describe('workspace change tracker', () => {
  it('does not attribute unchanged user dirty files to an attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-workspace-delta-'));
    try {
      spawnSync('git', ['init'], { cwd: root });
      writeFileSync(join(root, 'user-dirty.txt'), 'user change');
      const before = captureWorkspaceState(root);
      writeFileSync(join(root, 'attempt.txt'), 'attempt change');
      const delta = deriveWorkspaceDelta(before, captureWorkspaceState(root));

      expect(delta).toMatchObject({
        changed: [expect.objectContaining({ path: 'attempt.txt', beforeHash: null })],
      });
      expect(JSON.stringify(delta)).not.toContain('user-dirty.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives changes from clean committed states', () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-workspace-commit-delta-'));
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: root });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
      spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
      writeFileSync(join(root, 'changed.txt'), 'before\n');
      writeFileSync(join(root, 'deleted.txt'), 'deleted\n');
      spawnSync('git', ['add', '-A'], { cwd: root });
      spawnSync('git', ['commit', '-m', 'before'], { cwd: root });
      const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(root, 'changed.txt'), 'after\n');
      rmSync(join(root, 'deleted.txt'));
      writeFileSync(join(root, 'created.txt'), 'created\n');
      spawnSync('git', ['add', '-A'], { cwd: root });
      spawnSync('git', ['commit', '-m', 'after'], { cwd: root });
      const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

      const delta = deriveGitCommitDelta(root, before, after);

      expect(delta.changed.map(entry => entry.path)).toEqual([
        'changed.txt',
        'created.txt',
        'deleted.txt',
      ]);
      expect(delta.changed.find(entry => entry.path === 'created.txt')).toMatchObject({ beforeHash: null });
      expect(delta.changed.find(entry => entry.path === 'deleted.txt')).toMatchObject({ afterHash: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
