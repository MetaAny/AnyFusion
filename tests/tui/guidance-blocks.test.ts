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

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushUpdates();
    }
  }

  throw lastError;
}

function createDeferredResult() {
  let resolve!: (value: ExecutorResult) => void;
  const promise = new Promise<ExecutorResult>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

async function typeAndSubmit(text: string) {
  for (const char of text) {
    await inputCapture.handler?.(char, {});
    await flushUpdates();
  }

  await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
  await flushUpdates();
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App guidance blocks', () => {
  it('shows a startup guidance block for the current best task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const startupTask = taskEngine.create({ title: '整理 Phoenix 周报', goal: '继续整理 Phoenix 周报' });
    taskRepo.update(startupTask.id, {
      prioritySignals: {
        dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        isReady: true,
        progressRatio: 0.4,
        blocksOthers: false,
        idleHours: 0,
      },
    });
    taskEngine.transition(startupTask.id, 'ready');

    const startupDeferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: 'startup done',
      wait: startupDeferred.promise.then(result => result.exitCode),
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_guidance_startup',
        contextRecaller,
      }),
    );

    await waitFor(() => {
      expect(app.lastFrame()).toContain('当前建议');
      expect(app.lastFrame()).toContain('场景: 启动建议');
      expect(app.lastFrame()).toContain(startupTask.id);
      expect(app.lastFrame()).toContain(startupTask.title);
    });

    app.unmount();
    app.cleanup();
  });

  // 暂时跳过：单活跃任务门禁（ADR-0011）当前禁用多任务排队，无法构造"下一个排队任务"。
  // 待多任务调度重新启用后取消 skip 并按需修正。
  it.skip('shows a completion guidance block that points to the next queued task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const firstDeferred = createDeferredResult();
    const secondDeferred = createDeferredResult();
    const deferredResults = [firstDeferred, secondDeferred];
    const attemptSandbox = new FakeAttemptSandbox((_input, attemptIndex) => ({
      body: ['第一项任务完成', '第二项任务完成'][attemptIndex],
      wait: deferredResults[attemptIndex].promise.then(result => result.exitCode),
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_guidance_completion',
        contextRecaller,
      }),
    );

    await typeAndSubmit('先完成普通执行任务甲');
    await typeAndSubmit('再完成普通执行任务乙');

    firstDeferred.resolve({
      success: true,
      output: '第一项任务完成',
      exitCode: 0,
      durationMs: 500,
    });
    await waitFor(() => {
      const queuedTask = taskEngine.list().find(task => task.title.includes('再完成普通执行任务乙'));
      expect(queuedTask).toBeDefined();
      expect(app.lastFrame()).toContain('当前建议');
      expect(app.lastFrame()).toContain('场景: 完成后建议');
      expect(app.lastFrame()).toContain(queuedTask!.id);
      expect(app.lastFrame()).toContain(queuedTask!.title);
    });

    app.unmount();
    app.cleanup();
  });

  it('shows an unblock guidance block before resuming a blocked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '补齐起诉材料', goal: '继续补齐起诉材料' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const deferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '阻塞解除后已恢复执行',
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
        sessionId: 'sess_guidance_unblock',
        contextRecaller,
      }),
    );

    await typeAndSubmit(`/task resume ${blockedTask.id} /tmp/evidence-v3.pdf`);

    await waitFor(() => {
      expect(app.lastFrame()).toContain('当前建议');
      expect(app.lastFrame()).toContain('resume after capacity block');
      expect(app.lastFrame()).toContain(blockedTask.id);
      expect(app.lastFrame()).toContain(blockedTask.title);
    });

    deferred.resolve({
      success: true,
      output: '阻塞解除后已恢复执行',
      exitCode: 0,
      durationMs: 400,
    });
    await flushUpdates();
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it('shows a continuity-focused guidance block when resuming a preempted parked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({ title: '主线研究任务', goal: '继续推进主线研究任务' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被更高优先级任务抢占：插入紧急任务', {
      done: ['已完成产业链梳理'],
      pending: ['继续整理竞争格局'],
      nextStep: '继续整理竞争格局',
      pauseReason: '被更高优先级任务抢占：插入紧急任务',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '被更高优先级任务抢占：插入紧急任务',
    });

    const deferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '已恢复主线任务',
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
        sessionId: 'sess_guidance_resume_parked',
        contextRecaller,
      }),
    );

    await typeAndSubmit(`/task resume ${parkedTask.id}`);

    await waitFor(() => {
      expect(app.lastFrame()).toContain('当前建议');
      expect(app.lastFrame()).toContain('resume parked task');
      expect(app.lastFrame()).toContain(parkedTask.id);
      expect(app.lastFrame()).toContain('刚被高优任务打断');
    });

    deferred.resolve({
      success: true,
      output: '已恢复主线任务',
      exitCode: 0,
      durationMs: 450,
    });
    await flushUpdates();
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
