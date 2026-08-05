import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/app.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import { stubPlanningAgent, taskControlPlan } from '../support/planning-agent-plans.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';

const inputCapture = vi.hoisted(() => ({
  handler: undefined as undefined | ((input: string, key: Record<string, boolean>) => Promise<void> | void),
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => Promise<void> | void) => {
      inputCapture.handler = handler;
    },
  };
});

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

function flushUpdates() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 100) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }
  }

  throw lastError;
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App persisted v4 resume integration', () => {
  it('passes the persisted task-scoped execution context when resuming a parked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({ title: '行业分析', goal: '完成分析摘要' });
    seedPersistedWorkGraph(db, parkedTask.id, parkedTask.title);
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被高优任务抢占', {
      done: ['报告 A 已完成'],
      pending: ['报告 B 待分析'],
      nextStep: '继续分析报告 B',
      pauseReason: '被高优任务抢占',
    });
    taskRepo.update(parkedTask.id, { lastInterruptionReason: '被任务 #task_high 抢占' });

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '恢复完成' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_resume',
        contextRecaller,
        planningAgent: stubPlanningAgent(
          taskControlPlan({ control: 'resume_task', taskId: parkedTask.id }),
        ),
      })
    );

    for (const char of '继续刚才的行业分析') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    await waitFor(() => {
      expect(attemptSandbox.create).toHaveBeenCalled();
      const executionCall = attemptSandbox.create.mock.calls
        .find(call => call[0].taskId === parkedTask.id);
      const prompt = executionCall?.[0].args.at(-1);
      expect(prompt).toContain('Background goal: 完成分析摘要');
      expect(prompt).not.toContain('报告 A 已完成');
    });

    app.unmount();
    app.cleanup();
  });
});
