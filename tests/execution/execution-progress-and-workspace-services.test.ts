import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutionProgressService } from '../../src/execution/execution-progress-service.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('execution progress and workspace services', () => {
  it('ignores ordinary progress while preserving repeated skill events as verifier evidence', () => {
    const db = createDb();
    const service = new ExecutionProgressService(db);
    const tracker = service.createTracker({
      taskId: 'task_1',
      executionId: 'exec_1',
    });
    const executor = { name: 'codex-cli' } as ExecutorAdapter;

    tracker.onProgress({ kind: 'log', text: 'internal tool call' }, executor);

    tracker.onProgress({
      kind: 'skill',
      text: 'RED 测试已创建',
      skillEvent: {
        eventType: 'skill_progress',
        skillName: 'test-driven-development',
        skillVersion: '1.0.0',
        message: 'RED 测试已创建',
        payload: { phase: 'red' },
      },
    }, executor);
    tracker.onProgress({
      kind: 'skill',
      text: 'RED 测试已创建',
      skillEvent: {
        eventType: 'skill_progress',
        skillName: 'test-driven-development',
        skillVersion: '1.0.0',
        message: 'RED 测试已创建',
        payload: { phase: 'red' },
      },
    }, executor);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM executor_skill_usage_events WHERE execution_id = ?
    `).get('exec_1')).toEqual({ count: 0 });
    expect(tracker.evidenceText).toHaveLength(2);
    expect(tracker.evidenceText[0]).toContain('skill_event=skill_progress');
  });

  it('creates persistent workspace targets outside MetaclawSession', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-workspace-targets-'));
    try {
      const store = new WorkspaceStore(root);
      const identity = { taskId: 'task', generationId: 'generation', subtaskId: 'subtask' };
      const first = await store.ensureWorkspace(identity, 'directory');
      const second = await store.ensureWorkspace(identity, 'directory');
      expect(second.rootPath).toBe(first.rootPath);
      expect(existsSync(first.filesPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
