import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { CommandReadServices } from '../../src/commands/command-read-services.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';

function createHarness() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  new AgentClassService({ db }).seedDefaults();
  const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/metaclaw-command-read-tests');
  const runtimeInspector = {
    inspectExecutorRegistration: vi.fn(() => ({
      configured: true,
      bindingSource: 'sandbox' as const,
      adapterName: 'codex-cli',
    })),
  };
  const context = {
    db,
    taskEngine,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
    orchestration: new OrchestrationEngine(taskEngine),
    activeExecutions: { abortTask: vi.fn() },
    readServices: new CommandReadServices(db, runtimeInspector),
    currentTaskId: null,
    config: {
      version: 1,
      executor: { command: 'codex', timeout: 60, max_duration: 120 },
      orchestration: { max_concurrent_attempts: 4, reminder_enabled: true, reminder_throttle: 60, top_k_preferences: 5 },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    },
  } as any;
  return { db, taskEngine, runtimeInspector, context };
}

describe('command fact queries', () => {
  it('requires task ids and removes the hypothetical route command', async () => {
    const { context } = createHarness();
    const catalog = createDefaultCommandCatalog();

    expect((await catalog.execute('/task history', context)).content).toContain('taskId');
    expect((await catalog.execute('/executor feedback', context)).content).toContain('taskId');
    expect((await catalog.execute('/executor route explain this task', context)).content).toContain('未知命令');
    expect(catalog.listActions()).not.toContain('/executor route');
  });

  it('merges persisted task history and limits it to the latest twenty records', async () => {
    const { db, taskEngine, context } = createHarness();
    const task = taskEngine.create({ title: '历史测试', goal: '验证任务历史' });
    for (let index = 0; index < 21; index += 1) {
      db.prepare(`
        INSERT INTO interactions (
          id, task_id, session_id, user_input, system_output, executor_used, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `interaction-${index}`,
        task.id,
        'session-history',
        `用户输入 ${index}`,
        `系统回复 ${index}`,
        'codex-cli',
        `2026-07-14T10:${String(index).padStart(2, '0')}:00.000Z`,
      );
    }
    new TaskEventRepo(db).insert({
      id: 'task-event-latest',
      taskId: task.id,
      subtaskId: null,
      eventType: 'dispatch_stopped',
      message: '最新任务事件',
      payload: {},
      createdAt: '2026-07-14T11:00:00.000Z',
    });

    const result = await createDefaultCommandCatalog().execute(`/task history ${task.id}`, context);

    expect(result.content).toContain('仅展示最近 20 条记录');
    expect(result.content).toContain('最新任务事件');
    expect(result.content).toContain('用户输入 20');
    expect(result.content).not.toContain('用户输入 0\n');
  });

  it('shows static AgentClass facts and only active WorkUnits without probing the executor', async () => {
    const { db, context, runtimeInspector } = createHarness();
    const workUnits = new WorkUnitRepo(db);
    const now = '2026-07-14T10:00:00.000Z';
    workUnits.upsert({
      id: 'wu-running', agentClassName: 'codex-cli', agentClassKind: 'executor', state: 'running',
      claimedTaskId: null, claimedSubtaskId: null, heartbeatAt: now, leaseExpiresAt: now,
      createdAt: now, updatedAt: now,
    });
    workUnits.upsert({
      id: 'wu-idle', agentClassName: 'codex-cli', agentClassKind: 'executor', state: 'idle',
      claimedTaskId: null, claimedSubtaskId: null, heartbeatAt: now, leaseExpiresAt: null,
      createdAt: now, updatedAt: now,
    });

    const result = await createDefaultCommandCatalog().execute('/executor show codex-cli', context);

    expect(result.content).toContain('Executor AgentClass：codex-cli');
    expect(result.content).toContain('配置状态: 已配置');
    expect(result.content).toContain('runtime binding: sandbox');
    expect(result.content).toContain('wu-running');
    expect(result.content).not.toContain('wu-idle');
    expect(runtimeInspector.inspectExecutorRegistration).toHaveBeenCalledWith('codex-cli');
  });

  it('shows AgentClass facts and skill usage in the executor profile', async () => {
    const { db, context } = createHarness();
    db.prepare(`
      INSERT INTO skill_effect_summaries (
        id, executor_name, skill_name, skill_version, used_count, success_count, failure_count,
        patch_candidate_count, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('summary-1', 'codex-cli', 'review', '1.0.0', 4, 3, 1, 0,
      '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z');

    const result = await createDefaultCommandCatalog().execute('/profile executor codex-cli', context);
    expect(result.content).toContain('domains:');
    expect(result.content).toContain('capabilities:');
    expect(result.content).toContain('strengths:');
    expect(result.content).toContain('primary use cases:');
    expect(result.content).toContain('execution image:');
    expect(result.content).toContain('permission profile:');
    expect(result.content).toContain('review@1.0.0 used=4 success=3 failure=1 patch=0');

    const missing = await createDefaultCommandCatalog().execute('/profile executor missing', context);
    expect(missing.content).toContain('Executor不存在: missing');
  });

  it('groups persisted planner, kernel, WorkUnit, and executor facts by task', async () => {
    const { db, taskEngine, context } = createHarness();
    const task = taskEngine.create({ title: '反馈测试', goal: '验证路由反馈' });
    const proposedPlan = {
      action: 'plan_work_graph',
      reason: 'Planner selected coding executors',
      workGraph: {
        subtasks: [{
          id: 'subtask-1', agentClassHint: 'codex-cli', candidateAgentClasses: ['codex-cli', 'claude-code'],
        }],
      },
    };
    const approvedPlan = {
      ...proposedPlan,
      workGraph: {
        subtasks: [{ id: 'subtask-1', agentClassHint: 'codex-cli', candidateAgentClasses: ['codex-cli'] }],
      },
    };
    db.prepare(`
      INSERT INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, causation_id,
        session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
        decision_json, action, reason, created_at
      ) VALUES (?, 5, ?, 'plan_proposed', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      'decision-1', 'event-1', 'request-1', 'session-feedback', task.id,
      JSON.stringify({ schemaVersion: 5, type: 'plan_proposed', id: 'event-1', correlationId: 'request-1', causationId: null, occurredAt: '2026-07-14T10:00:00.000Z', sessionId: 'session-feedback', taskId: task.id, proposal: proposedPlan }),
      JSON.stringify({ schemaVersion: 5, type: 'plan_admission' }),
      JSON.stringify({ schemaVersion: 5, id: 'decision-1', eventId: 'event-1', action: { type: 'authorize_task_plan', taskId: task.id, task: {}, workGraph: approvedPlan.workGraph }, reason: 'approved' }),
      'authorize_task_plan', 'approved', '2026-07-14T10:00:00.000Z',
    );
    const workUnitRepo = new WorkUnitRepo(db);
    workUnitRepo.upsert({
      id: 'work-unit-1', agentClassName: 'codex-cli', agentClassKind: 'executor', state: 'claimed',
      claimedTaskId: task.id, claimedSubtaskId: 'subtask-1', heartbeatAt: '2026-07-14T10:01:00.000Z',
      leaseExpiresAt: '2026-07-14T10:02:00.000Z', createdAt: '2026-07-14T10:01:00.000Z',
      updatedAt: '2026-07-14T10:01:00.000Z',
    });
    workUnitRepo.insertEvent({
      id: 'work-event-1', workUnitId: 'work-unit-1', taskId: task.id, subtaskId: 'subtask-1',
      eventType: 'claimed', state: 'claimed', message: 'claimed', payload: {},
      createdAt: '2026-07-14T10:01:00.000Z',
    });
    new TaskEventRepo(db).insert({
      id: 'task-event-1', taskId: task.id, subtaskId: 'subtask-1', eventType: 'subtask_done',
      message: 'executor completed', payload: {}, createdAt: '2026-07-14T10:02:00.000Z',
    });

    const result = await createDefaultCommandCatalog().execute(`/executor feedback ${task.id}`, context);

    expect(result.content).toContain('1. Planner 提议');
    expect(result.content).toContain('claude-code');
    expect(result.content).toContain('2. ControlKernel 决策');
    expect(result.content).toContain('outcome=issued');
    expect(result.content).toContain('3. WorkUnit 过程');
    expect(result.content).toContain('claimed');
    expect(result.content).toContain('4. Executor 结果');
    expect(result.content).toContain('executor completed');
  });
});
