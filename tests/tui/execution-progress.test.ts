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

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App execution progress', () => {
  it('hides executor progress and shows the final result exactly once', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    memoryEngine.addManual({
      content: 'Phoenix 项目材料统一使用 Phoenix 术语体系',
      scope: 'project',
      type: 'domain',
      subject: 'Phoenix',
    });
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '调研完成' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_execution_progress',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({ goal: '整理 Phoenix 项目周报' })),
      }),
    );

    for (const char of '整理 Phoenix 项目周报') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    for (let attempt = 0; attempt < 100 && !app.lastFrame().includes('[DONE]'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }

    expect(app.lastFrame()).toContain('【Executor: codex-cli｜派发准备】');
    expect(app.lastFrame()).toContain('→ Executor: codex-cli 将处理该任务');
    expect(app.lastFrame()).toContain('当前任务');
    expect(app.lastFrame()).toContain('#task_plan_event_proposal_');
    expect(app.lastFrame()).toContain('[DONE] 整理 Phoenix 项目周报');
    expect(app.lastFrame()).not.toContain('已启动 codex-cli 执行器');
    expect(app.lastFrame()).not.toContain('正在检索市场份额数据');
    expect(app.lastFrame()).not.toContain('正在回忆任务 #');
    expect(app.lastFrame()).not.toContain('已召回 ');
    expect(app.lastFrame()).not.toContain('正在构建任务 #');
    expect(app.lastFrame()).not.toContain('执行上下文已准备完成');
    expect(app.lastFrame()).not.toContain('已识别可执行任务');
    expect(app.lastFrame()).not.toContain('执行策略：');
    expect(app.lastFrame()).not.toContain('已创建：');
    expect(app.lastFrame()).not.toContain('执行准备：');
    expect(app.lastFrame()).not.toContain('PlanningAgent:');
    expect(app.lastFrame()).not.toContain('ControlKernel:');
    expect(app.lastFrame()).not.toContain('Runtime:');
    expect(app.lastFrame()).not.toContain('[Planner: dispatch]');
    expect(app.lastFrame()).not.toContain('Work Unit ');
    expect(app.lastFrame()).toContain('【Executor: codex-cli｜最终结果｜#');
    expect(app.lastFrame()?.match(/【Executor: codex-cli｜最终结果｜#/g)).toHaveLength(1);
    expect(app.lastFrame()).not.toContain('  · 已注入');
    expect(app.lastFrame()).not.toContain('confidence=');
    expect(app.lastFrame()).not.toContain('命中原因');

    app.unmount();
    app.cleanup();
  });

  it('animates executor activity without committing it to session output and clears it at completion', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '调研完成',
      wait: new Promise<number>(resolve => setTimeout(() => resolve(0), 900)),
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_execution_waiting_hint',
        contextRecaller,
        planningAgent: stubPlanningAgent(workGraphPlan({ goal: '整理 Phoenix 项目周报' })),
      }),
    );

    for (const char of '整理 Phoenix 项目周报') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 400));
    await flushUpdates();

    const firstAnimationFrame = app.lastFrame() ?? '';
    expect(firstAnimationFrame).toMatch(/Executor: codex-cli 执行中\.{1,3}/);
    expect(app.lastFrame()).toContain('当前任务');
    expect(app.lastFrame()).toContain('#task_plan_event_proposal_');
    expect(app.lastFrame()).toContain('[RUNNING] 整理 Phoenix 项目周报');

    await new Promise(resolve => setTimeout(resolve, 400));
    await flushUpdates();
    expect(app.lastFrame()).toMatch(/Executor: codex-cli 执行中\.{1,3}/);
    expect(app.lastFrame()).not.toBe(firstAnimationFrame);

    await submitPromise;
    for (let attempt = 0; attempt < 100 && app.lastFrame().includes('Executor: codex-cli 执行中'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }

    expect(app.lastFrame()).not.toContain('Executor: codex-cli 执行中');

    app.unmount();
    app.cleanup();
  });
});
