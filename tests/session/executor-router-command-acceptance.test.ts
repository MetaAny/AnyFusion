import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import type { PlanningAgent } from '../../src/planning/planning-agent.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: { max_concurrent_attempts: 4, reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

function createSession(input: {
  db: Database.Database;
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  attemptSandbox: FakeAttemptSandbox;
  sessionId: string;
  planningAgent?: PlanningAgent;
}) {
  return new MetaclawSession({
    taskEngine: input.taskEngine,
    memoryEngine: input.memoryEngine,
    orchestration: new OrchestrationEngine(input.taskEngine),
    attemptSandbox: input.attemptSandbox,
    db: input.db,
    config: createConfig(),
    sessionId: input.sessionId,
    contextRecaller: new ContextRecaller(input.db),
    planningAgent: input.planningAgent,
  });
}

describe('planner-first executor command acceptance', () => {
  it('guides users through executor AgentClass registration and persists runtime binding', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-wizard');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const attemptSandbox = new FakeAttemptSandbox();
    const session = createSession({ db, taskEngine, memoryEngine, attemptSandbox, sessionId: 'sess_agent_class_register_wizard' });

    session.initialize();
    await session.submit('/executor register wizard');
    await session.submit('research-bot');
    await session.submit('registry.example/research-bot:1.0.0');
    await session.submit(`sha256:${'a'.repeat(64)}`);
    await session.submit('restricted-custom');
    await session.submit('manual');
    await session.submit('research-bot');
    await session.submit('run --prompt {prompt}');
    await session.submit('research-bot --version');
    await session.submit('research,reporting');
    await session.submit('research,report_generation');
    await session.submit('y');

    const row = db.prepare(`
      SELECT name, kind, domains_json, capabilities_json, runtime_command, runtime_args_json,
             runtime_check_command
      FROM agent_classes WHERE name = ?
    `).get('research-bot') as {
      name: string;
      kind: string;
      domains_json: string;
      capabilities_json: string;
      runtime_command: string;
      runtime_args_json: string;
      runtime_check_command: string;
    };

    expect(row).toEqual(expect.objectContaining({
      name: 'research-bot',
      kind: 'executor',
      runtime_command: 'research-bot',
      runtime_check_command: 'research-bot --version',
    }));
    expect(JSON.parse(row.runtime_args_json)).toEqual(['run', '--prompt', '{prompt}']);
    expect(JSON.parse(row.domains_json)).toEqual(['research', 'reporting']);
    expect(JSON.parse(row.capabilities_json)).toEqual(['research', 'report_generation']);

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('Executor AgentClass registration wizard started');
    expect(output).toContain('Registered Executor AgentClass: research-bot');
    expect(output).toContain('This executor class can now back executor work units');
  });

  it('supports one-line AgentClass registration with quoted runtime args', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-executor-oneline');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const attemptSandbox = new FakeAttemptSandbox();
    const session = createSession({ db, taskEngine, memoryEngine, attemptSandbox, sessionId: 'sess_agent_class_register_oneline' });

    session.initialize();
    await session.submit(`/executor register research-bot --image registry.example/research-bot:1.0.0 --image-id sha256:${'a'.repeat(64)} --permission-profile restricted-custom --command research-bot --args "run --prompt {prompt}" --check "research-bot --version" --domains research --capabilities report_generation`);

    const row = db.prepare('SELECT runtime_args_json, runtime_check_command FROM agent_classes WHERE name = ?').get('research-bot') as {
      runtime_args_json: string;
      runtime_check_command: string;
    };

    expect(JSON.parse(row.runtime_args_json)).toEqual(['run', '--prompt', '{prompt}']);
    expect(row.runtime_check_command).toBe('research-bot --version');
  });

  it('persists planner subtasks and work unit claims before execution', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-planner-exec');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'code task done' }));
    const session = createSession({
      db,
      taskEngine,
      memoryEngine,
      attemptSandbox,
      sessionId: 'sess_planner_exec',
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '请实现一个 TypeScript 单元测试并修复代码', capabilityClass: 'code_edit' }),
      ),
    });

    session.initialize();
    await session.submit('请实现一个 TypeScript 单元测试并修复代码', { awaitAsyncWork: true });

    const agentClasses = db.prepare('SELECT name FROM agent_classes ORDER BY name ASC').all() as Array<{ name: string }>;
    expect(agentClasses.map(row => row.name)).toEqual(expect.arrayContaining(['codex-cli', 'planner']));

    const subtasks = db.prepare('SELECT status, delivery_kind FROM subtasks ORDER BY created_at ASC').all() as Array<{
      status: string;
      delivery_kind: string;
    }>;
    expect(subtasks).toEqual([expect.objectContaining({ status: 'done', delivery_kind: 'edit' })]);

    const workUnitEvents = db.prepare('SELECT event_type FROM work_unit_events ORDER BY created_at ASC').all() as Array<{ event_type: string }>;
    expect(workUnitEvents.map(row => row.event_type)).toEqual(expect.arrayContaining(['claimed', 'running', 'released']));
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
  });

  it('provisions the planner-selected executor class on demand without choosing peers', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-fixed-executor');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'default executor completed research' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration: new OrchestrationEngine(taskEngine),
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_fixed_executor',
      contextRecaller: new ContextRecaller(db),
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '请调研这个方案并进行自动化分析，输出报告', executor: 'codex-cli' }),
      ),
    });

    session.initialize();
    await session.submit('请调研这个方案并进行自动化分析，输出报告', { awaitAsyncWork: true });

    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(attemptSandbox.create.mock.calls[0]![0].command).toBe('codex');
    expect(db.prepare(`
      SELECT agent_class_name, state FROM work_units
      WHERE agent_class_kind = 'executor'
      ORDER BY created_at DESC LIMIT 1
    `).get()).toEqual({
      agent_class_name: 'codex-cli',
      state: 'idle',
    });
  });

  it('announces the executor that actually claims the approved preferred AgentClass', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-actual-executor-output');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'fallback completed' }));
    const planned = workGraphPlan({ goal: '执行带受控路由的任务' });

    const session = createSession({
      db,
      taskEngine,
      memoryEngine,
      attemptSandbox,
      sessionId: 'sess_actual_executor_output',
      planningAgent: stubPlanningAgent(planned),
    });
    session.initialize();
    await session.submit('执行带候选回退的任务', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('【Executor: codex-cli｜派发准备】\n→ Executor: codex-cli 将处理该任务');
    expect(output).not.toContain('【Executor: pi-agent｜派发准备】');
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(attemptSandbox.create.mock.calls[0]![0].command).toBe('codex');
  });

  it('blocks failed executor subtasks for planner recovery instead of platform fallback', async () => {
    const db = createDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-no-platform-fallback');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: 'executor returned an unclassified failure',
      exitCode: 1,
    }));
    const session = createSession({
      db,
      taskEngine,
      memoryEngine,
      attemptSandbox,
      sessionId: 'sess_no_platform_fallback',
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '请实现一个 TypeScript 单元测试并修复代码', capabilityClass: 'code_edit' }),
      ),
    });

    session.initialize();
    await session.submit('请实现一个 TypeScript 单元测试并修复代码', { awaitAsyncWork: true });

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('Execution blocked: unknown requires explicit recovery');
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(taskRepo.findByStatus('blocked')).toHaveLength(1);
    expect(db.prepare('SELECT status FROM subtasks ORDER BY created_at DESC LIMIT 1').get()).toEqual({ status: 'blocked' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM executor_route_events').get()).toEqual({ count: 0 });
  });
});
