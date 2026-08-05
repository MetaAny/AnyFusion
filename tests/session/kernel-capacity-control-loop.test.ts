import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';
import { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';

describe('Kernel capacity control loop', () => {
  it('exhausts authorized candidates, persists wait_for_capacity, and resumes only from a timer event', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-kernel-capacity');
    const available = { value: false };
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'capacity recovered' }));
    attemptSandbox.resolveImage.mockImplementation(async () => {
      if (!available.value) throw new Error('image unavailable');
      return `sha256:${'a'.repeat(64)}`;
    });
    const plan = workGraphPlan({ goal: 'run after capacity recovers', deliveryKind: 'report' });
    const config: Config = {
      version: 1,
      executor: { command: 'codex', timeout: 60_000 },
      orchestration: {
        reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
        blocked_recheck_enabled: true, blocked_recheck_interval: 5,
        max_concurrent_attempts: 4,
      },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    };
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptSandbox,
      db,
      config,
      sessionId: 'session_capacity',
      contextRecaller: new ContextRecaller(db),
      planningAgent: stubPlanningAgent(plan),
    });
    session.initialize({ resumeStartupTasks: false, showDashboard: false });
    db.prepare('DELETE FROM work_units').run();

    await session.submit('run after capacity recovers', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    expect(task.status).toBe('blocked');
    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT action FROM kernel_decisions WHERE task_id = ? ORDER BY rowid`).all(task.id))
      .toEqual(expect.arrayContaining([{ action: 'wait_for_capacity' }]));
    expect(new KernelExecutorStatusProjector(new KernelExecutorStatusRepo(db)).list()
      .find(item => item.agentClassName === 'codex-cli')).toMatchObject({
      classHealth: 'error',
      recentAttempts: [expect.objectContaining({
        failure: expect.objectContaining({ code: 'executor_image_probe_failed' }),
      })],
    });

    available.value = true;
    await session.submit('/executor refresh codex-cli', {
      awaitAsyncWork: true,
    });
    expect(new KernelExecutorStatusRepo(db).list()
      .find(item => item.agentClassName === 'codex-cli')?.classHealth).toBe('healthy');

    const handled = await session.maybeReconcileBlockedTasksOnTimer(Date.now() + 10_000);

    expect(handled).toBe(true);
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT action FROM kernel_decisions WHERE task_id = ? ORDER BY rowid`).all(task.id))
      .toEqual(expect.arrayContaining([{ action: 'probe_capacity' }, { action: 'dispatch_batch' }, { action: 'complete_task' }]));
  });
});
