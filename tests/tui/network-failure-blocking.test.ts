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
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
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

async function waitUntil(assertion: () => boolean, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for expected TUI state');
    }
    await flushUpdates();
  }
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App recoverable infrastructure failure waiting', () => {
  it('moves a task into a Kernel-authorized retry wait after network failure', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      exitCode: 1,
      rawOutput: '执行器网络连接失败，请检查网络或代理配置',
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_network_block',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({ goal: '调研 agent memory 框架' })),
      }),
    );

    for (const char of '调研 agent memory 框架') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await waitUntil(() => taskRepo.findByStatus('blocked').length > 0);
    await waitUntil(() => app.lastFrame()?.includes('Execution blocked: retry scheduled for') ?? false);

    const blockedTask = taskRepo.findByStatus('blocked')[0];
    expect(blockedTask).toBeTruthy();
    expect(blockedTask.dependencies[0]).toMatchObject({ type: 'kernel_retry', status: 'waiting' });
    expect(blockedTask.dependencies[0]?.description).toContain('retry scheduled for');
    expect(app.lastFrame()).toContain('Execution blocked: retry scheduled for');

    app.unmount();
    app.cleanup();
  });

  it('moves a task into a Kernel-authorized retry wait after executor inactivity', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      exitCode: 1,
      rawOutput: 'executor idle timeout',
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_idle_timeout_block',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({ goal: '生成 HTML 幻灯片' })),
      }),
    );

    for (const char of '生成 HTML 幻灯片') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await waitUntil(() => taskRepo.findByStatus('blocked').length > 0);
    await waitUntil(() => app.lastFrame()?.includes('Execution blocked: retry scheduled for') ?? false);

    const blockedTask = taskRepo.findByStatus('blocked')[0];
    expect(blockedTask).toBeTruthy();
    expect(blockedTask.dependencies[0]).toMatchObject({ type: 'kernel_retry', status: 'waiting' });
    expect(blockedTask.dependencies[0]?.description).toContain('retry scheduled for');
    expect(app.lastFrame()).toContain('Execution blocked: retry scheduled for');

    app.unmount();
    app.cleanup();
  });
});
