import { describe, expect, it, vi } from 'vitest';
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
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import {
  completionResponseFromSandboxInput,
  FakeAttemptSandbox,
} from '../support/fake-attempt-sandbox.js';
import { planningAgentFromPlanMock } from '../support/planning-agent-plans.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
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

// A valid plan_work_graph plan routed at a single available executor. Overrides
// let each test reshape the action/execution/work graph while keeping the seam
// (an injected PlanningAgent returning a PlanningAgentPlan directly) identical.
function workGraphPlan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    id: 'plan_test',
    schemaVersion: 7,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'planner 直接产出工作图',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: '普通功能',
      goal: '实现一个普通功能',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'test work graph priority' },
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: {
      reason: 'single executor work graph',
      subtasks: [{
        id: 'subtask_execute',
        title: '实现一个普通功能',
        goal: '实现一个普通功能',
        dependencies: [],
        contextRefs: [{ kind: 'current_user_input' }],
        requiredCapabilities: ['workspace-engineering'],
        preferredAgentClassList: ['codex-cli'],
        deliveryKind: 'edit',
        acceptance: [{ key: 'tests', description: 'List changed files and provide test evidence.', requiredEvidence: ['test result'] }],
        riskLevel: 'low',
      }],
    },
    source: 'anyfusion-planner',
    ...overrides,
  };
}

describe('MetaclawSession planning-agent routing', () => {
  it('routes natural language through the injected PlanningAgent without touching legacy intent methods', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-planning-agent-route');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: 'done' }));
    const planningAgent = planningAgentFromPlanMock(vi.fn().mockResolvedValue(workGraphPlan()));

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_planning_agent_route',
      contextRecaller,
      planningAgent,
    });
    session.initialize({ resumeStartupTasks: false });

    await session.submit('实现一个普通功能', { awaitAsyncWork: true });

    expect(planningAgent.plan).toHaveBeenCalledTimes(1);
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().output.join('\n')).toContain('completed 1 Subtask(s)');
  });

  it('surfaces a clarification plan without creating or executing a task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-planning-agent-clarify');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox();
    const planningAgent = planningAgentFromPlanMock(vi.fn().mockResolvedValue(workGraphPlan({
        action: 'clarification',
        confidence: 0.2,
        reason: '低置信度',
        clarificationQuestion: '请明确是聊天还是创建任务。',
        task: {
          binding: 'none',
          taskId: null,
          control: 'none',
          scope: null,
          title: null,
          goal: null,
          includeRecentConversationContext: false,
          priority: null,
        },
        workGraph: null,
      })));

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_planning_agent_clarify',
      contextRecaller,
      planningAgent,
    });
    session.initialize({ resumeStartupTasks: false });

    await session.submit('这个可能要处理一下', { awaitAsyncWork: true });

    expect(planningAgent.plan).toHaveBeenCalledTimes(1);
    expect(taskRepo.findAll()).toHaveLength(0);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(session.getSnapshot().output.join('\n')).toContain('请明确是聊天还是创建任务。');
  });

  it('does not apply removed text heuristics when structured acceptance evidence is present', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-planning-agent-verifier');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(input => ({
      rawOutput: completionResponseFromSandboxInput(input, '已修改代码并完成实现。')
        .replace('tests were not run: deterministic fake sandbox', 'implementation completed'),
    }));
    const planningAgent = planningAgentFromPlanMock(vi.fn().mockResolvedValue(workGraphPlan({
        reason: '修改仓库代码',
        task: {
          binding: 'new',
          taskId: null,
          control: 'none',
          scope: null,
          title: '修改仓库代码',
          goal: '修改仓库代码实现一个功能',
          includeRecentConversationContext: false,
          priority: { level: 'normal', reason: 'test work graph priority' },
        },
      })));

    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_planning_agent_verifier',
      contextRecaller,
      planningAgent,
    });
    session.initialize({ resumeStartupTasks: false });

    await session.submit('修改仓库代码实现一个功能', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    expect(task.status).toBe('done');
    expect(task.dependencies).toEqual([]);
    expect(db.prepare('SELECT status, result FROM subtasks WHERE task_id = ?').get(task.id)).toEqual({
      status: 'done',
      result: '已修改代码并完成实现。',
    });
    expect(db.prepare('SELECT terminal_state, error_code FROM executor_attempt_receipts').get()).toEqual({
      terminal_state: 'completed',
      error_code: null,
    });
    expect(db.prepare(`
      SELECT state, claimed_task_id, claimed_subtask_id, claimed_attempt_id
      FROM work_units WHERE agent_class_kind = 'executor'
    `).get()).toEqual({
      state: 'idle',
      claimed_task_id: null,
      claimed_subtask_id: null,
      claimed_attempt_id: null,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM task_events
      WHERE task_id = ? AND event_type = 'phase2_execution_blocked'
    `).get(task.id)).toEqual({ count: 0 });
    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('completed 1 Subtask(s)');
    expect(output).not.toContain('response-only correction is unavailable or already exhausted');
  });
});
