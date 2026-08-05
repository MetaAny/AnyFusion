import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import type { Task } from '../../src/core/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('SubtaskRepo', () => {
  it('preserves existing error when updateStatus is called without an error change', () => {
    const db = createDb();
    const now = '2026-07-02T00:00:00.000Z';
    const task: Task = {
      id: 'task_1',
      title: 'Task',
      goal: 'Do work',
      status: 'running',
      summary: '',
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    new TaskRepo(db).insert(task);
    const repo = new SubtaskRepo(db);
    repo.upsert({
      id: 'subtask_1',
      taskId: 'task_1',
      title: 'Subtask',
      goal: 'Do work',
      status: 'blocked',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      preferredAgentClassList: ['codex-cli'],
      deliveryKind: 'report',
      acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
      riskLevel: 'medium',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: 'executor timeout',
      createdAt: now,
      updatedAt: now,
    });

    repo.updateStatus('subtask_1', 'running');

    expect(repo.findById('subtask_1')).toMatchObject({
      status: 'running',
      error: 'executor timeout',
    });

    repo.updateStatus('subtask_1', 'ready', { error: null });
    expect(repo.findById('subtask_1')).toMatchObject({
      status: 'ready',
      error: null,
    });
  });
});
