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

describe('App unblock scheduling', () => {
  it('dispatches an unblocked task with its persisted v4 execution context when idle', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '起诉书草稿', goal: '补齐起诉材料' });
    seedPersistedWorkGraph(db, blockedTask.id, blockedTask.title);
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已恢复处理' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_unblock',
        contextRecaller,
      })
    );

    const command = `/task unblock ${blockedTask.id}`;
    for (const char of command) {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    await waitFor(() => {
      expect(attemptSandbox.create).toHaveBeenCalled();
      const executionCall = attemptSandbox.create.mock.calls
        .find(call => call[0].taskId === blockedTask.id);
      expect(executionCall?.[0].subtaskId).toContain(blockedTask.id);
    });

    app.unmount();
    app.cleanup();
  });

  it('persists newly provided resources without injecting undeclared resources into context', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '起诉书草稿', goal: '补齐起诉材料' });
    seedPersistedWorkGraph(db, blockedTask.id, blockedTask.title);
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已恢复处理' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_unblock_resources',
        contextRecaller,
      })
    );

    const command = `/task unblock ${blockedTask.id} /tmp/evidence-v3.pdf`;
    for (const char of command) {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    let executionPrompt: string | null = null;
    await waitFor(() => {
      expect(attemptSandbox.create).toHaveBeenCalled();
      const executionCall = attemptSandbox.create.mock.calls
        .find(call => call[0].taskId === blockedTask.id);
      expect(executionCall?.[0].args.at(-1)).toBeTruthy();
      executionPrompt = executionCall![0].args.at(-1)!;
    });
    if (!executionPrompt) {
      throw new Error('expected a task execution call with a rendered SubtaskExecutionContext');
    }
    expect(executionPrompt).not.toContain('/tmp/evidence-v3.pdf');
    expect(taskEngine['taskRepo'].findById(blockedTask.id)?.resources).toContain('/tmp/evidence-v3.pdf');

    app.unmount();
    app.cleanup();
  });
});
