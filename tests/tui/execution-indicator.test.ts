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
import type { Config, ExecutorResult } from '../../src/core/types.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import {
  planningAgentFromPlanMock,
  stubPlanningAgent,
  workGraphPlan,
} from '../support/planning-agent-plans.js';
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

async function waitForFrame(app: ReturnType<typeof render>, expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame = app.lastFrame();
    if (frame?.includes(expected)) {
      return frame;
    }
    await flushUpdates();
  }
  return app.lastFrame();
}

function createDeferredResult() {
  let resolve!: (value: ExecutorResult) => void;
  const promise = new Promise<ExecutorResult>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function createDeferredPlan() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<PlanningAgentPlan>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App execution indicator', () => {
  it('animates only while the Planner call is active and clears after Planner failure', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const deferred = createDeferredPlan();

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox: new FakeAttemptSandbox(),
        db,
        config: createConfig(),
        sessionId: 'sess_planner_indicator',
        contextRecaller,
        planningAgent: planningAgentFromPlanMock(vi.fn(() => deferred.promise)),
      })
    );

    for (const char of '分析请求') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();

    const firstFrame = await waitForFrame(app, 'Planner: 思考中.');
    expect(firstFrame).toContain('status: processing');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(app.frames.some(frame => frame.includes('Planner: 思考中..'))).toBe(true);

    deferred.reject(new Error('planner crashed'));
    await submitPromise;
    await flushUpdates();

    expect(app.lastFrame()).toContain('错误: planner crashed');
    expect(app.lastFrame()).not.toContain('Planner: 思考中');
    expect(app.lastFrame()).toContain('status: idle');

    app.unmount();
    app.cleanup();
  });

  it('does not render the completion frame with a lingering running count', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const deferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '执行完成',
      wait: deferred.promise.then(result => result.exitCode),
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_test',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({ goal: '执行任务' })),
      })
    );

    const type = async (char: string) => {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    };

    await type('执');
    await type('行');
    await type('任');
    await type('务');

    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    await flushUpdates();

    for (let attempt = 0; attempt < 100 && attemptSandbox.create.mock.calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(attemptSandbox.create).toHaveBeenCalled();
    expect(app.frames.some(frame => frame.includes('当前执行 1 | 待执行 0 | 已挂起 0 | 阻塞 0'))).toBe(true);

    deferred.resolve({
      success: true,
      output: '执行完成',
      exitCode: 0,
      durationMs: 1200,
    });

    await submitPromise;
    for (let attempt = 0; attempt < 100 && !app.lastFrame().includes('completed 1 Subtask(s)'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }

    expect(
      app.frames.some(frame => frame.includes('completed 1 Subtask(s)') && frame.includes('当前执行 1 |'))
    ).toBe(false);
    expect(app.lastFrame()).toContain('completed 1 Subtask(s)');
    expect(app.lastFrame()).toContain('当前执行 0 | 待执行 0 | 已挂起 0 | 阻塞 0');
    expect(app.lastFrame()).toContain('status: idle');

    app.unmount();
    app.cleanup();
  });

  it('shows parked task count in the runtime summary', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({ title: '待恢复任务', goal: '继续调研' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被高优任务抢占', {
      done: ['已完成一半'],
      pending: ['继续剩余部分'],
      nextStep: '继续调研剩余部分',
      pauseReason: '被高优任务抢占',
    });
    taskRepo.update(parkedTask.id, {
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });

    const attemptSandbox = new FakeAttemptSandbox();

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_parked_summary',
        contextRecaller,
        planningAgent: stubPlanningAgent(),
      })
    );

    const frame = await waitForFrame(app, '当前执行 0 | 待执行 0 | 已挂起 1 | 阻塞 0');

    expect(frame).toContain('当前执行 0 | 待执行 0 | 已挂起 1 | 阻塞 0');
    expect(frame).toContain('最近事件 0');

    app.unmount();
    app.cleanup();
  });

  it.skip('shows the last scheduler event in the runtime summary', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const deferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '执行完成',
      wait: deferred.promise.then(result => result.exitCode),
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_last_event',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({ goal: '执行任务' })),
      })
    );

    await inputCapture.handler?.('执', {});
    await flushUpdates();
    await inputCapture.handler?.('行', {});
    await flushUpdates();
    await inputCapture.handler?.('任', {});
    await flushUpdates();
    await inputCapture.handler?.('务', {});
    await flushUpdates();
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(app.lastFrame()).toContain('最近事件 开始执行任务 #');

    deferred.resolve({
      success: true,
      output: '执行完成',
      exitCode: 0,
      durationMs: 200,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
