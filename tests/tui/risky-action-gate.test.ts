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

async function submitLine(line: string) {
  for (const char of line) {
    await inputCapture.handler?.(char, {});
    await flushUpdates();
  }
  await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
  await flushUpdates();
  await flushUpdates();
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App risky action gate', () => {
  it('blocks a risky state-changing plan until the planner observes confirmation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已发送给客户' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_risky_gate',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({
          goal: '直接把邮件发给客户',
          overrides: {
            risk: { level: 'high', requiresConfirmation: true, reasons: ['external send'] },
          },
        })),
      }),
    );

    await submitLine('直接把邮件发给客户');

    await flushUpdates();
    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('该操作存在较高风险，请明确确认是否继续执行。');
    expect(app.lastFrame()).not.toContain('risk confirmation required');

    app.unmount();
    app.cleanup();
  });

  it('lets the planner produce a new safe plan after explicit confirmation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已发送给客户' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_risky_confirm',
        contextRecaller,
        planningAgent: stubPlanningAgent(
          workGraphPlan({
            goal: '直接把邮件发给客户',
            overrides: {
              risk: { level: 'high', requiresConfirmation: true, reasons: ['external send'] },
            },
          }),
          workGraphPlan({ goal: '用户已确认发送邮件' }),
        ),
      }),
    );

    await submitLine('直接把邮件发给客户');
    await submitLine('确认执行');
    for (let attempt = 0; attempt < 100 && attemptSandbox.create.mock.calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }
    for (let attempt = 0; attempt < 100 && !app.lastFrame().includes('已发送给客户'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }

    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain('已发送给客户');

    app.unmount();
    app.cleanup();
  });
});
