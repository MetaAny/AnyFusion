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
import {
  clarificationPlan,
  directReplyPlan,
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

describe('App input availability', () => {
  it('recalls submitted input history with up and down arrows', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-history');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_input_history',
        contextRecaller,
        planningAgent: stubPlanningAgent(
          directReplyPlan({ reason: 'history navigation test' }),
          directReplyPlan({ reason: 'history navigation test' }),
        ),
      })
    );

    const typeText = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
    };
    const submit = async () => {
      await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
      await flushUpdates();
    };

    await typeText('第一条任务');
    await submit();
    await typeText('第二条任务');
    await submit();
    await typeText('当前草稿');

    await inputCapture.handler?.('', { upArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 第二条任务');

    await inputCapture.handler?.('', { upArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 第一条任务');

    await inputCapture.handler?.('', { downArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 第二条任务');

    await inputCapture.handler?.('', { downArrow: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> 当前草稿');

    app.unmount();
    app.cleanup();
  });

  it('supports multiline terminal editing with spaces, cursor movement, backspace, and forward delete before submit', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-multiline-editor');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_multiline_editor',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'multiline editor test' })),
      })
    );

    const typeText = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
    };

    await typeText('第一行');
    await (inputCapture.handler?.('', { return: true, shift: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(app.lastFrame()).toContain('第一行');

    await typeText('第二  错行');
    await inputCapture.handler?.('', { leftArrow: true });
    await flushUpdates();
    await inputCapture.handler?.('', { leftArrow: true });
    await flushUpdates();
    await inputCapture.handler?.('\u001b[3~', {});
    await flushUpdates();
    await inputCapture.handler?.('', { delete: true });
    await flushUpdates();
    await typeText('补  充');

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(app.lastFrame()).toContain('> 第一行');
    expect(app.lastFrame()).toContain('第二 补  充行');

    app.unmount();
    app.cleanup();
  });

  it('treats the Ink delete key event as normal Backspace in the composer', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-normal-backspace');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_normal_backspace',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'backspace test' })),
      })
    );

    for (const char of 'abc') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await inputCapture.handler?.('', { delete: true });
    await flushUpdates();
    await inputCapture.handler?.('', { delete: true });
    await flushUpdates();
    await inputCapture.handler?.('X', {});
    await flushUpdates();

    expect(app.lastFrame()).toContain('│ > aX');

    app.unmount();
    app.cleanup();
  });

  it('treats a raw LF terminal Enter as submit instead of inserting it into the editor', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-raw-lf-submit');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_raw_lf_submit',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'raw LF submit test' })),
      })
    );

    for (const char of '请生成报告') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await inputCapture.handler?.('\n', {});
    await flushUpdates();

    expect(app.lastFrame()).toContain('> 请生成报告');

    await inputCapture.handler?.('X', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('│ > X');

    app.unmount();
    app.cleanup();
  });

  it('uses arrow keys to choose slash command suggestions before falling back to history recall', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-command-suggestions');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_command_suggestions',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'command suggestion test' })),
      })
    );

    await inputCapture.handler?.('/', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('命令建议 ↑/↓ 选择，Tab 补全，Enter 执行');
    expect(app.lastFrame()).toContain('/task');

    await inputCapture.handler?.('t', {});
    await inputCapture.handler?.('a', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('/task');
    expect(app.lastFrame()).not.toContain('/memory');

    await inputCapture.handler?.('', { tab: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> /task ');
    expect(app.lastFrame()).toContain('dashboard');
    expect(app.lastFrame()).toContain('list');

    app.unmount();
    app.cleanup();
  });

  it('renders nested command groups without a slash and applies the same text with Tab', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-command-group-suggestions');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox();
    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_command_group_suggestions',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'nested command suggestion test' })),
      })
    );
    const typeText = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
    };

    await typeText('/exe');
    expect(app.lastFrame()).toContain('/executor —');

    await inputCapture.handler?.('', { tab: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> /executor ');

    await typeText('sho');
    expect(app.lastFrame()).toContain('show —');
    expect(app.lastFrame()).not.toContain('/show —');

    await inputCapture.handler?.('', { tab: true });
    await flushUpdates();
    expect(app.lastFrame()).toContain('> /executor show ');

    for (let index = 0; index < '/executor show '.length; index += 1) {
      await inputCapture.handler?.('', { backspace: true });
      await flushUpdates();
    }
    await typeText('/learning ');
    expect(app.lastFrame()).toContain('patch —');
    expect(app.lastFrame()).not.toContain('/patch —');

    app.unmount();
    app.cleanup();
  });

  it.skip('keeps the prompt usable and rejects a new top-level task while another task is running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const firstDeferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox((_input, attemptIndex) => attemptIndex === 0
      ? { body: 'first done', wait: firstDeferred.promise.then(result => result.exitCode) }
      : { body: 'queued done' });

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
        planningAgent: stubPlanningAgent(
          workGraphPlan({ goal: '主线任务', matchedBoundary: ['repo_execution'] }),
          workGraphPlan({ goal: '排队任务', matchedBoundary: ['repo_execution'] }),
        ),
      })
    );

    const type = async (char: string) => {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    };

    await type('主');
    await type('线');
    await type('任');
    await type('务');
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    await type('排');
    await type('队');
    await type('任');
    await type('务');

    expect(app.lastFrame()).toContain('> 排队任务');
    expect(app.lastFrame()).toContain('status: running codex-cli');

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();

    expect(app.lastFrame()).toContain('当前已有任务 #');
    expect(app.lastFrame()).toContain('正在运行，请等待完成，或先暂停/取消当前任务。');
    expect(app.lastFrame()).not.toContain('单活跃任务限制');
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(0);

    firstDeferred.resolve({
      success: true,
      output: 'first done',
      exitCode: 0,
      durationMs: 1000,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it('shows a processing composer status while submitted input is still being routed', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-processing-status');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const executorDeferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: 'done',
      wait: executorDeferred.promise.then(result => result.exitCode),
    }));
    let resolvePlan!: (value: ReturnType<typeof workGraphPlan>) => void;
    const pendingPlan = new Promise<ReturnType<typeof workGraphPlan>>(resolve => {
      resolvePlan = resolve;
    });
    const planningAgent = planningAgentFromPlanMock(vi.fn().mockReturnValue(pendingPlan));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_processing_status',
        contextRecaller,
        planningAgent,
      })
    );

    for (const char of '生成一个状态报告') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    const submitPromise = inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    await flushUpdates();

    expect(app.lastFrame()).toContain('status: processing');
    expect(app.lastFrame()).toContain('> 生成一个状态报告');
    expect(app.lastFrame()).toContain('【MetaClaw｜理解用户请求】');
    expect(app.lastFrame()).not.toContain('正在分析目标、上下文与可执行边界');
    expect(app.lastFrame()).toContain('status: processing');

    resolvePlan(workGraphPlan({ goal: '生成一个状态报告', matchedBoundary: ['repo_execution'] }));
    for (let attempt = 0; attempt < 100 && attemptSandbox.create.mock.calls.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await flushUpdates();

    expect(app.lastFrame()).not.toContain('已识别可执行任务');
    expect(app.lastFrame()).not.toContain('执行策略：');
    expect(app.lastFrame()).toContain('【Executor: codex-cli｜派发准备】');
    expect(app.lastFrame()).toContain('→ Executor: codex-cli 将处理该任务');
    expect(app.lastFrame()).toContain('status: running codex-cli');
    expect(app.lastFrame()).toContain('当前任务');
    expect(app.lastFrame()).toContain('#task_plan_event_proposal_');
    expect(app.lastFrame()).toContain('[RUNNING] 生成一个状态报告');

    executorDeferred.resolve({
      success: true,
      output: 'done',
      exitCode: 0,
      durationMs: 100,
    });
    await submitPromise;
    for (let attempt = 0; attempt < 100 && !app.lastFrame().includes('status: idle'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await flushUpdates();
    }
    expect(app.lastFrame()).toContain('status: idle');

    app.unmount();
    app.cleanup();
  });

  it.skip('rejects urgent top-level task intake instead of preempting through the user entrypoint', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const firstDeferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox((_input, attemptIndex) => attemptIndex === 0
      ? { body: 'first done', wait: firstDeferred.promise.then(result => result.exitCode) }
      : { body: 'urgent done' });

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
        planningAgent: stubPlanningAgent(
          workGraphPlan({ goal: '普通任务', matchedBoundary: ['repo_execution'] }),
          workGraphPlan({ goal: '紧急优先处理这个任务', matchedBoundary: ['repo_execution'] }),
        ),
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

    await typeAndSubmit('普通任务');
    const runningTaskId = taskEngine['taskRepo'].findByStatus('running')[0]?.id;

    await typeAndSubmit('紧急优先处理这个任务');

    expect(app.lastFrame()).toContain(`当前已有任务 #${runningTaskId} 正在运行，请等待完成，或先暂停/取消当前任务。`);
    expect(app.lastFrame()).not.toContain('单活跃任务限制');
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(0);

    firstDeferred.resolve({
      success: true,
      output: 'first done',
      exitCode: 0,
      durationMs: 800,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it.skip('keeps busy intent timeout conservative instead of queueing keyword fallback work', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const firstDeferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox((_input, attemptIndex) => attemptIndex === 0
      ? { body: 'first done', wait: firstDeferred.promise.then(result => result.exitCode) }
      : { body: 'queued done' });
    const planningAgent = planningAgentFromPlanMock(
      vi.fn()
        .mockResolvedValueOnce(workGraphPlan({ goal: '主线任务', matchedBoundary: ['repo_execution'] }))
        .mockResolvedValueOnce(clarificationPlan('我不确定你想继续聊天、创建新任务，还是恢复某个已有任务。')),
    );

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_llm_stalled_while_running',
        contextRecaller,
        planningAgent,
      })
    );

    const typeAndSubmit = async (text: string) => {
      for (const char of text) {
        await inputCapture.handler?.(char, {});
        await flushUpdates();
      }
      return inputCapture.handler?.('', { return: true }) ?? Promise.resolve();
    };

    await typeAndSubmit('主线任务');
    await flushUpdates();

    const secondSubmit = typeAndSubmit('排队任务');
    await new Promise(resolve => setTimeout(resolve, 600));
    await flushUpdates();

    expect(app.lastFrame()).toContain('我不确定你想继续聊天、创建新任务，还是恢复某个已有任务。');
    expect(app.lastFrame()).not.toContain('统一意图裁决置信度不足');
    expect(taskEngine['taskRepo'].findByStatus('ready')).toHaveLength(0);

    await secondSubmit;
    firstDeferred.resolve({
      success: true,
      output: 'first done',
      exitCode: 0,
      durationMs: 1000,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  it.skip('shows the routed executor in the composer status while a task is running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-routed-executor-status');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const piDeferred = createDeferredResult();
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: 'Pi Agent done',
      wait: piDeferred.promise.then(result => result.exitCode),
    }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_routed_executor_status',
        contextRecaller,
        planningAgent: stubPlanningAgent(
          workGraphPlan({ goal: '请调研这个方案并进行自动化分析，输出报告', executor: 'codex-cli', matchedBoundary: ['repo_execution'] }),
        ),
      })
    );

    for (const char of '请调研这个方案并进行自动化分析，输出报告') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    expect(app.lastFrame()).toContain('status: running codex-cli');
    expect(app.lastFrame()).not.toContain('status: running pi-agent');
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);

    piDeferred.resolve({
      success: true,
      output: 'Pi Agent done',
      exitCode: 0,
      durationMs: 100,
    });
    await flushUpdates();

    app.unmount();
    app.cleanup();
  });

  // Regression: a real terminal delivers Enter as char='\r' alongside
  // key.return. The early raw-submit branch used to fire first and submit the
  // raw "/", yielding "未知命令: /undefined". Enter must not autocomplete or
  // submit an incomplete command; the editor remains available for Tab completion.
  it('keeps an incomplete slash command on a real \\r Enter', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-enter-completes');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_enter_completes',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'enter completion test' })),
      })
    );

    await inputCapture.handler?.('/', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('命令建议 ↑/↓ 选择，Tab 补全，Enter 执行');

    await inputCapture.handler?.('\r', { return: true });
    await flushUpdates();

    expect(app.lastFrame()).toContain('> /');
    expect(app.lastFrame()).not.toContain('> /task ');
    expect(app.lastFrame()).not.toContain('未知命令');
    expect(app.lastFrame()).not.toContain('/undefined');
    expect(attemptSandbox.create).not.toHaveBeenCalled();

    app.unmount();
    app.cleanup();
  });

  it('executes a valid slash command on Enter even when the editor cursor is in the middle', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-middle-cursor-submit');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox();
    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_middle_cursor_submit',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'unused' })),
      })
    );

    const task = taskEngine.create({ title: 'middle cursor task', goal: 'verify full command submission' });
    const resource = 'evidence.md';
    const command = `/task attach ${task.id} ${resource}`;
    for (const char of command) {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    for (let index = 0; index < resource.length + 1; index += 1) {
      await inputCapture.handler?.('', { leftArrow: true });
      await flushUpdates();
    }

    await inputCapture.handler?.('', { return: true });
    await flushUpdates();

    expect(taskRepo.findById(task.id)?.resources).toContain(resource);

    app.unmount();
    app.cleanup();
  });

  it('completes a slash command on Tab when a suggestion list is visible', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-tab-completes');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_tab_completes',
        contextRecaller,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: 'tab completion test' })),
      })
    );

    // A typo remains non-executable, but its nearest valid command is offered as
    // a Tab replacement.
    await inputCapture.handler?.('/', {});
    await inputCapture.handler?.('t', {});
    await inputCapture.handler?.('a', {});
    await inputCapture.handler?.('k', {});
    await inputCapture.handler?.('s', {});
    await flushUpdates();
    expect(app.lastFrame()).toContain('/task');

    await inputCapture.handler?.('\t', { tab: true });
    await flushUpdates();

    expect(app.lastFrame()).toContain('> /task ');
    expect(app.lastFrame()).not.toContain('未知命令');
    expect(attemptSandbox.create).not.toHaveBeenCalled();

    app.unmount();
    app.cleanup();
  });
});
