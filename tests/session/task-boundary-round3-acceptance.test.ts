import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import {
  stubPlanningAgent,
  planningAgentFromPlanMock,
  directReplyPlan,
  workGraphPlan,
  taskControlPlan,
} from '../support/planning-agent-plans.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';

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

describe('Round 3 task boundary acceptance', () => {
  it('pins planning-agent as the active executor while delivering a direct reply, then restores state', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-direct-reply-runtime-state');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox();
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_direct_reply_runtime_state',
      contextRecaller,
      planningAgent: stubPlanningAgent(directReplyPlan({
        reason: '普通问答',
        response: { directReply: '最终回答' },
      })),
    });

    session.initialize();

    // QC's direct_reply is produced synchronously by the planner, so the
    // "executor still answering" window is only observable via a snapshot
    // subscriber: when the reply line is appended, runtimeState must already
    // pin planning-agent as the active executor.
    let observedDuringReply: { runningExecutorName: string | null; lastEvent: string | null } | null = null;
    const unsubscribe = session.subscribe(snapshot => {
      if (snapshot.output.includes('最终回答') && !observedDuringReply) {
        observedDuringReply = {
          runningExecutorName: snapshot.runtimeState.runningExecutorName,
          lastEvent: snapshot.runtimeState.lastEvent,
        };
      }
    });

    await session.submit('怎么还没有给我结果呀', { awaitAsyncWork: true });
    unsubscribe();

    // No durable task is created, and the writable executor is never invoked.
    expect(taskRepo.findAll()).toHaveLength(0);
    expect(attemptSandbox.create).not.toHaveBeenCalled();

    // While the reply was being delivered, the planner was surfaced as active.
    expect(observedDuringReply).toEqual(expect.objectContaining({
      runningExecutorName: 'planning-agent',
      lastEvent: '普通对话由 planning-agent 生成回答',
    }));

    // After the turn, the pinned executor name is restored to null.
    expect(session.getSnapshot().runtimeState.runningExecutorName).toBeNull();
    expect(session.getSnapshot().output.join('\n')).toContain('最终回答');
  });

  it('turns conversation-derived follow-up work into a new task without implicitly inheriting conversation history', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    let parkedTaskId = '';

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '三点结论：1. 强模型减少脚手架；2. 任务状态仍需系统层管理；3. 调度和恢复最难被替代。',
    }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_round3_boundary',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        directReplyPlan({ reason: '普通讨论' }),
        workGraphPlan({
          goal: '把刚才那段分析整理成三点结论',
          includeRecentConversationContext: true,
          matchedBoundary: ['conversation_follow_up'],
          overrides: { reason: '按当前对话创建跟进任务' },
        }),
      ),
    });

    session.initialize();

    const parkedTask = taskEngine.create({
      title: '旧的 memory 调研任务',
      goal: '继续完善 memory 方向的开源项目对比',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户手动暂停', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '用户手动暂停',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '用户手动暂停',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });
    parkedTaskId = parkedTask.id;

    await session.submit('未来随着基座模型的能力越来越强，是否还需要 harness', { awaitAsyncWork: true });
    await session.submit('把刚才那段分析整理成三点结论', { awaitAsyncWork: true });

    // Turn 1 is a direct_reply (planner answers, no executor). Turn 2 is the
    // executable follow-up, so exactly one executor dispatch happens — for the
    // new follow-up task, not the old parked one.
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    const secondCall = attemptSandbox.create.mock.calls[0]![0];
    const secondPrompt = secondCall.args.at(-1) ?? '';
    expect(secondCall.taskId).not.toBe(parkedTaskId);
    expect(secondPrompt).toContain('把刚才那段分析整理成三点结论');
    expect(secondPrompt).not.toContain('未来随着基座模型');
    expect(taskRepo.findById(parkedTaskId)?.status).toBe('parked');

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).not.toContain(`关联到任务 #${parkedTaskId}`);
    expect(snapshot).toContain('【Executor: codex-cli｜派发准备】');
    expect(snapshot).not.toContain('按当前对话创建跟进任务');
  });

  it('handles natural language clearing of blocked tasks without creating a new task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_clear_blocked_tasks',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'clear_tasks', scope: 'blocked' }),
      ),
    });

    session.initialize();

    const blockedTask = taskEngine.create({ title: '被阻塞任务', goal: '等待补材料' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待材料',
      status: 'waiting',
    });

    const readyTask = taskEngine.create({ title: '待执行任务', goal: '继续排队' });
    taskEngine.transition(readyTask.id, 'ready');

    await session.submit('清空阻塞的任务', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('已清空阻塞任务：取消 1 个任务');
    expect(snapshot).toContain(blockedTask.id);
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(readyTask.id)?.status).toBe('ready');
    expect(taskRepo.findAll()).toHaveLength(2);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('answers blocked-task status queries from MetaClaw state without calling the executor', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_query_blocked_tasks',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'status_query', scope: 'blocked' }),
      ),
    });

    session.initialize();

    const blockedTask = taskEngine.create({ title: '飞书客户端接入', goal: '修复飞书链路' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '执行器网络连接失败，请检查网络或代理配置',
      status: 'waiting',
    });

    await session.submit('当前有没有被阻塞的任务？', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前有 1 个阻塞任务');
    expect(snapshot).toContain(`#${blockedTask.id} [BLOCKED] 飞书客户端接入`);
    expect(snapshot).toContain('执行器网络连接失败，请检查网络或代理配置');
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('blocked');
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('answers no blocked tasks from MetaClaw state without creating a task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_query_no_blocked_tasks',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'status_query', scope: 'blocked' }),
      ),
    });

    session.initialize();

    await session.submit('检查一下有没有 blocked 任务', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前没有阻塞任务。');
    expect(taskRepo.findAll()).toHaveLength(0);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('answers current running task queries from MetaClaw state without creating a task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_query_running_task',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'status_query', scope: 'running' }),
      ),
    });

    session.initialize();

    const runningTask = taskEngine.create({ title: '正在生成报告', goal: '生成报告' });
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');

    await session.submit('你当前正在执行什么任务？', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前有 1 个正在执行的任务');
    expect(snapshot).toContain(`#${runningTask.id} [RUNNING] 正在生成报告`);
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('answers completion checks from MetaClaw state when no task is running', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_query_completion_no_running',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'status_query', scope: 'running' }),
      ),
    });

    session.initialize();

    const doneTask = taskEngine.create({ title: '刚才的任务', goal: '刚才的任务' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    taskRepo.update(doneTask.id, { summary: '已经完成并生成最终结果' });
    taskEngine.transition(doneTask.id, 'done');

    await session.submit('这个任务执行完成了吗？我现在还没有收到结果', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前没有正在执行的任务。');
    expect(snapshot).toContain(`最近完成：#${doneTask.id} 刚才的任务`);
    expect(snapshot).toContain('摘要：已经完成并生成最终结果');
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('routes semantic scheduler-state questions to MetaClaw without requiring keyword coverage', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_semantic_scheduler_state',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'status_query', scope: 'running' }),
      ),
    });

    session.initialize();

    await session.submit('我这边一直没等到，你那边到底还在忙吗？', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('当前没有正在执行的任务。');
    expect(taskRepo.findAll()).toHaveLength(0);
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('keeps deliverable-content checks on the Executor side even when task words appear', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '检查完成：文档内容完整。' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_deliverable_check_executor',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '检查这个任务生成的 Markdown 文档内容是否完整' }),
      ),
    });

    session.initialize();

    await session.submit('检查这个任务生成的 Markdown 文档内容是否完整', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('【Executor: codex-cli｜派发准备】');
    expect(snapshot).toContain('检查完成：文档内容完整。');
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
  });

  it('keeps continuation/generation work on the Executor side instead of treating it as status', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已继续生成预览版。' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_generation_executor',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '继续把这个任务的预览版生成出来' }),
      ),
    });

    session.initialize();

    await session.submit('继续把这个任务的预览版生成出来', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('已继续生成预览版。');
    expect(taskRepo.findAll()).toHaveLength(1);
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
  });

  it('handles natural language clearing of all manageable tasks and aborts running work', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '不应执行' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_clear_all_tasks',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'clear_tasks', scope: 'all' }),
      ),
    });

    session.initialize();

    const runningTask = taskEngine.create({ title: '执行中的任务', goal: '执行中' });
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');

    const parkedTask = taskEngine.create({ title: '挂起任务', goal: '挂起中' });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: [],
      pending: ['继续'],
      nextStep: '继续',
      pauseReason: '用户暂停',
    });

    const doneTask = taskEngine.create({ title: '已完成任务', goal: '已完成' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    taskEngine.transition(doneTask.id, 'done');

    await session.submit('清空所有任务', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('已清空所有未完成任务：取消 2 个任务');
    expect(snapshot).toContain('已中止当前执行器');
    expect(taskRepo.findById(runningTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(parkedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(doneTask.id)?.status).toBe('done');
    expect(attemptSandbox.stop).not.toHaveBeenCalled();
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('resumes an explicitly requested parked task instead of creating a new task when intent is misclassified', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '挂起任务已恢复' }));
    let parkedTaskId = '';
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_resume_parked_without_new_task',
      contextRecaller,
      planningAgent: planningAgentFromPlanMock(
        vi.fn(async () => taskControlPlan({ control: 'resume_task', taskId: parkedTaskId })),
      ),
    });

    session.initialize();

    const parkedTask = taskEngine.create({ title: 'Pi Agent 调研任务', goal: '继续调研 Pi Agent 能力' });
    seedPersistedWorkGraph(db, parkedTask.id, parkedTask.title);
    parkedTaskId = parkedTask.id;
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户暂停', {
      done: ['已经完成初步资料整理'],
      pending: ['补齐 npm 和 GitHub 信息'],
      nextStep: '继续搜索资料',
      pauseReason: '用户暂停',
    });

    const beforeCount = taskRepo.findAll().length;
    await session.submit(`重启挂起任务 ${parkedTask.id}`, { awaitAsyncWork: true });

    expect(taskRepo.findAll()).toHaveLength(beforeCount);
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(attemptSandbox.create.mock.calls[0]![0].taskId).toBe(parkedTask.id);
    expect(session.getSnapshot().output.join('\n')).toContain('resume parked task');
  });

  it('unblocks and resumes an explicitly requested blocked task instead of creating a new task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '阻塞任务已恢复' }));
    let blockedTaskId = '';
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_resume_blocked_without_new_task',
      contextRecaller,
      planningAgent: planningAgentFromPlanMock(
        vi.fn(async () => taskControlPlan({ control: 'recover_blocked', taskId: blockedTaskId })),
      ),
    });

    session.initialize();

    const blockedTask = taskEngine.create({ title: '飞书云文档调研', goal: '继续调研飞书云文档能力' });
    seedPersistedWorkGraph(db, blockedTask.id, blockedTask.title);
    blockedTaskId = blockedTask.id;
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '执行器权限受限，请确认已授予所需目录访问权限后重试',
      status: 'waiting',
    });

    const beforeCount = taskRepo.findAll().length;
    await session.submit(`执行阻塞任务 ${blockedTask.id}`, { awaitAsyncWork: true });

    expect(taskRepo.findAll()).toHaveLength(beforeCount);
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);
    expect(attemptSandbox.create.mock.calls[0]![0].taskId).toBe(blockedTask.id);
    expect(session.getSnapshot().output.join('\n')).toContain('resume after capacity block');
  });
});
