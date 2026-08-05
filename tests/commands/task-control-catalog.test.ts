import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';

function createHarness() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  new AgentClassService({ db }).seedDefaults();
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-command-control');
  const abortTask = vi.fn().mockReturnValue(1);
  const cancelTask = vi.fn(async (taskId: string, reason?: string) => {
    taskEngine.cancel(taskId, reason);
    return { taskId, affectedSubtaskIds: [], cleanupAttemptIds: [] };
  });
  const cancelSubtasks = vi.fn(async (taskId: string, subtaskIds: string[]) => ({
    taskId, affectedSubtaskIds: subtaskIds, cleanupAttemptIds: [],
  }));
  const acceptPartialResult = vi.fn(async (taskId: string) => ({
    taskId, affectedSubtaskIds: ['cancelled'], cleanupAttemptIds: [],
  }));
  const context = {
    db,
    taskEngine,
    activeExecutions: { abortTask },
    taskControl: { cancelTask, cancelSubtasks, acceptPartialResult },
  } as any;
  return {
    db, taskRepo, taskEngine, abortTask, cancelTask, cancelSubtasks,
    acceptPartialResult, context, catalog: createDefaultCommandCatalog(),
  };
}

function createRunningTask(taskEngine: TaskEngine, suffix: string) {
  const task = taskEngine.create({ title: `任务 ${suffix}`, goal: `执行 ${suffix}` });
  taskEngine.transition(task.id, 'ready');
  taskEngine.transition(task.id, 'running');
  return task;
}

describe('canonical task control commands', () => {
  it.each([
    ['pause', 'parked', ''],
    ['block', 'blocked', ' 等待材料'],
  ] as const)('persists %s before aborting the active task', async (command, expectedStatus, tail) => {
    const harness = createHarness();
    const task = createRunningTask(harness.taskEngine, command);

    const result = await harness.catalog.execute(`/task ${command} ${task.id}${tail}`, harness.context);

    expect(result.type).toBe('text');
    expect(harness.taskRepo.findById(task.id)?.status).toBe(expectedStatus);
    expect(harness.abortTask).toHaveBeenCalledWith(task.id);
  });

  it('routes Task cancellation through the durable Task control port', async () => {
    const harness = createHarness();
    const task = createRunningTask(harness.taskEngine, 'cancel');

    await harness.catalog.execute(`/task cancel ${task.id}`, harness.context);

    expect(harness.taskRepo.findById(task.id)?.status).toBe('cancelled');
    expect(harness.cancelTask).toHaveBeenCalledWith(task.id);
    expect(harness.abortTask).not.toHaveBeenCalled();
  });

  it('removes the manual complete command from the command surface', async () => {
    const harness = createHarness();
    const task = createRunningTask(harness.taskEngine, 'complete');

    const result = await harness.catalog.execute(`/task complete ${task.id}`, harness.context);

    expect(harness.taskRepo.findById(task.id)?.status).toBe('running');
    expect(result.content).toContain('未知命令');
  });

  it('clears matching tasks and aborts only tasks that were running', async () => {
    const harness = createHarness();
    const running = createRunningTask(harness.taskEngine, 'running');
    const parked = createRunningTask(harness.taskEngine, 'parked');
    harness.taskEngine.park(parked.id);

    await harness.catalog.execute('/task clear all', harness.context);

    expect(harness.taskRepo.findById(running.id)?.status).toBe('cancelled');
    expect(harness.taskRepo.findById(parked.id)?.status).toBe('cancelled');
    expect(harness.cancelTask).toHaveBeenCalledTimes(2);
    expect(harness.cancelTask).toHaveBeenCalledWith(running.id, expect.any(String));
    expect(harness.cancelTask).toHaveBeenCalledWith(parked.id, expect.any(String));
    expect(harness.abortTask).not.toHaveBeenCalled();
  });

  it('accepts operation-first Subtask cancellation and partial acceptance commands', async () => {
    const harness = createHarness();
    const task = createRunningTask(harness.taskEngine, 'subtask-control');

    await harness.catalog.execute(
      `/task subtask-cancel ${task.id} subtask-a subtask-b`,
      harness.context,
    );
    expect(harness.cancelSubtasks).toHaveBeenCalledWith(
      task.id,
      ['subtask-a', 'subtask-b'],
    );

    harness.taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'partial cancellation',
      status: 'waiting',
    });
    await harness.catalog.execute(`/task accept-partial ${task.id}`, harness.context);
    expect(harness.acceptPartialResult).toHaveBeenCalledWith(task.id);
  });

  it('does not normalize target-first task control syntax', async () => {
    const harness = createHarness();
    const task = createRunningTask(harness.taskEngine, 'target-first');
    const result = await harness.catalog.execute(`/task ${task.id} accept-partial`, harness.context);
    expect(result.content).toContain('未知命令');
  });

});
