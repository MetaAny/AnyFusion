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

async function waitForExecutorCallCount(execute: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (execute.mock.calls.length >= count) {
      return;
    }
    await flushUpdates();
  }
  throw new Error(`expected executor call count >= ${count}, got ${execute.mock.calls.length}`);
}

function createDeferredResult() {
  let resolve!: (value: ExecutorResult) => void;
  const promise = new Promise<ExecutorResult>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App auto-resume after preemption', () => {
  // 暂时跳过：单活跃任务门禁（ADR-0011）当前禁用多任务抢占/排队/自动恢复。
  // 待多任务调度重新启用后取消 skip 并按需修正。
  it.skip('resumes the preempted parked task before a later normal queued task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const firstDeferred = createDeferredResult();
    const urgentDeferred = createDeferredResult();
    const resumedDeferred = createDeferredResult();
    const laterNormalDeferred = createDeferredResult();

    let firstExecuteResolved = false;
    const deferredResults = [firstDeferred, urgentDeferred, resumedDeferred, laterNormalDeferred];
    const attemptSandbox = new FakeAttemptSandbox((_input, attemptIndex) => ({
      body: ['first done', 'urgent done', 'resumed done', 'later done'][attemptIndex],
      wait: deferredResults[attemptIndex].promise.then(result => result.exitCode),
    }));
    attemptSandbox.stop.mockImplementation(async runtimeHandle => {
      if (!firstExecuteResolved) {
        firstExecuteResolved = true;
        firstDeferred.resolve({
          success: false,
          output: '',
          error: 'execution interrupted',
          exitCode: 1,
          durationMs: 200,
          interrupted: true,
        });
      }
      return undefined;
    });

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_auto_resume',
        contextRecaller,
      })
    );

    const typeAndSubmit = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
      await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
      await flushUpdates();
    };

    await typeAndSubmit('主线研究任务');
    await typeAndSubmit('紧急优先处理这个任务');
    await typeAndSubmit('普通排队任务');

    expect(app.lastFrame()).toContain('任务队列前五');
    expect(app.lastFrame()).toContain('[执行中]');
    expect(app.lastFrame()).toContain('[待执行]');
    expect(app.lastFrame()).toContain('优先级');
    expect(app.lastFrame()).toContain('第 1 顺位');

    urgentDeferred.resolve({
      success: true,
      output: 'urgent done',
      exitCode: 0,
      durationMs: 400,
    });
    await waitForExecutorCallCount(attemptSandbox.create, 3);

    expect(taskRepo.findById(attemptSandbox.create.mock.calls[2][0].taskId)?.title).toContain('主线研究任务');
    expect(taskEngine['taskRepo'].findByStatus('running')[0]?.title).toContain('主线研究任务');

    resumedDeferred.resolve({
      success: true,
      output: 'resumed done',
      exitCode: 0,
      durationMs: 500,
    });
    await waitForExecutorCallCount(attemptSandbox.create, 4);

    expect(taskRepo.findById(attemptSandbox.create.mock.calls[3][0].taskId)?.title).toContain('普通排队任务');

    laterNormalDeferred.resolve({
      success: true,
      output: 'later done',
      exitCode: 0,
      durationMs: 300,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });
});
