import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';

describe('TaskRuntimeService Task Domain facade', () => {
  let service: TaskRuntimeService;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-task-runtime-tests'));
    service = new TaskRuntimeService({ taskEngine, taskRepo });
  });

  it('exposes explicit lifecycle commands without scheduling policy', () => {
    const created = service.createTask({ id: 'task_fixed', title: 'Task', goal: 'Goal' });
    expect(created.id).toBe('task_fixed');
    expect(service.transitionTask(created.id, 'ready').status).toBe('ready');
    expect(service.transitionTask(created.id, 'running').status).toBe('running');
    expect(service.transitionTask(created.id, 'done').status).toBe('done');
  });

  it('blocks and explicitly unblocks a Task', () => {
    const task = service.createTask({ title: 'Task', goal: 'Goal' });
    service.transitionTask(task.id, 'ready');
    service.transitionTask(task.id, 'running');
    expect(service.blockTask(task.id, {
      taskId: task.id, type: 'manual', description: 'capacity', status: 'waiting',
    }).status).toBe('blocked');
    expect(service.unblockTask(task.id).status).toBe('ready');
  });

  it('completes a recovered ready Task through legal lifecycle transitions', () => {
    const task = service.createTask({ title: 'Recovered Task', goal: 'Finish after publication' });
    service.transitionTask(task.id, 'ready');

    expect(service.completeTask(task.id).status).toBe('done');
    expect(service.completeTask(task.id).status).toBe('done');
  });

  it('contains no generic command switch or queue/preemption interface', () => {
    expect('execute' in service).toBe(false);
    expect('preemptCurrentTask' in service).toBe(false);
    expect('getNextSchedulableTask' in service).toBe(false);
  });
});
