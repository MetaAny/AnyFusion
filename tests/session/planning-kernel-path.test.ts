import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { ControlKernel } from '../../src/kernel/control-kernel.js';
import type { Config } from '../../src/core/types.js';
import type { PlanningAgentPlan, PlanningContext } from '../../src/planning/planning-types.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';
import { PlanningContextBuilder } from '../../src/planning/planning-context-builder.js';
import {
  createPlannerProposalSubmissionId,
  plannerProposalFingerprint,
} from '../../src/planning/planner-proposal.js';
import { PlannerProposalRepo } from '../../src/storage/planner-proposal-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import type {
  FakeAttemptSandboxResponder,
  FakeAttemptSandboxResponse,
} from '../support/fake-attempt-sandbox.js';
import {
  completionResponseFromSandboxInput,
  FakeAttemptSandbox,
} from '../support/fake-attempt-sandbox.js';
import { planningAgentFromPlanMock } from '../support/planning-agent-plans.js';

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: { max_concurrent_attempts: 4, reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

function plan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
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
      priority: { level: 'normal', reason: 'test priority' },
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
        acceptance: [{ key: 'tests', description: 'List changed files and test evidence.', requiredEvidence: ['test result'] }],
        riskLevel: 'low',
      }],
    },
    source: 'anyfusion-planner',
    ...overrides,
  };
}

function createSession(
  sessionId: string,
  planningPlan: PlanningAgentPlan | ((context: PlanningContext) => PlanningAgentPlan | Promise<PlanningAgentPlan>),
  responder?: (
    ...args: [...Parameters<FakeAttemptSandboxResponder>, Database.Database]
  ) => FakeAttemptSandboxResponse | Promise<FakeAttemptSandboxResponse>,
) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, `/tmp/metaclaw-planning-kernel-path/${sessionId}`);
  const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
  const attemptSandbox = new FakeAttemptSandbox(
    (input, attemptIndex) => responder?.(input, attemptIndex, db) ?? { body: 'done' },
  );
  const session = new MetaclawSession({
    taskEngine,
    memoryEngine,
    orchestration: new OrchestrationEngine(taskEngine),
    attemptSandbox,
    db,
    config: createConfig(),
    sessionId,
    contextRecaller: new ContextRecaller(db),
    planningAgent: planningAgentFromPlanMock(
      typeof planningPlan === 'function'
        ? vi.fn().mockImplementation(planningPlan)
        : vi.fn().mockResolvedValue(planningPlan),
    ),
  });
  session.initialize({ resumeStartupTasks: false });
  return {
    db,
    session,
    taskRepo,
    memoryEngine,
    attemptSandbox,
    kernelDecisionRepo: new KernelDecisionRepo(db),
    sessionId,
  };
}

function seedPriorGenerationEvidence(db: Database.Database, taskId: string): void {
  const now = '2026-07-20T00:00:00.000Z';
  new SubtaskRepo(db).upsert({
    id: 'subtask_prior_generation',
    taskId,
    graphRevision: 99,
    generationId: 'generation_prior',
    title: 'Prior generation work',
    goal: 'Prior generation work',
    status: 'done',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    deliveryKind: 'report',
    acceptance: [],
    riskLevel: 'low',
    result: 'must not leak into the current generation',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: 3 },
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  new TaskExecutionEvidenceRepo(db).upsert({
    id: 'evidence_prior_generation',
    taskId,
    kind: 'task_evidence',
    sourceId: 'subtask_prior_generation',
    title: 'Prior generation evidence',
    content: 'must not leak into the current generation',
    createdAt: now,
  });
}

// Behavior-first coverage of the PlanningAgent -> ControlKernel -> Runtime seam.
// Rather than grepping the session source for symbol names, these assert the
// observable side effects the seam is responsible for: a durable proposal
// result, plus the Kernel audit and task/executor outcome for accepted plans.
describe('natural-language planning/kernel path', () => {
  it('submits a native TUI proposal through existing Kernel workflow without invoking the runner', async () => {
    let plannerCalls = 0;
    const harness = createSession('sess_native_tui_handoff', () => {
      plannerCalls += 1;
      return plan();
    });
    const nativePlan = plan({
      id: 'plan_native_tui',
      action: 'direct_reply',
      response: { directReply: '已由 native Planner 提交。' },
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
    });

    const turnId = 'turn_native_tui';
    const result = await harness.session.submitPlannerProposal({
      sessionId: harness.sessionId,
      turnId,
      userInput: '请简短回答',
      submissionId: createPlannerProposalSubmissionId(harness.sessionId, turnId, nativePlan),
      plan: nativePlan,
      runtimeMode: 'interactive',
    });

    expect(result).toMatchObject({
      status: 'accepted', planId: 'plan_native_tui', outcome: 'direct_reply_delivered',
    });
    expect(plannerCalls).toBe(0);
    expect(harness.session.getSnapshot().output.join('\n')).toContain('已由 native Planner 提交。');
    expect(harness.kernelDecisionRepo.listBySession('sess_native_tui_handoff')).toEqual([
      expect.objectContaining({ action: 'deliver_direct_reply', taskId: null }),
    ]);
  });

  it('rejects an invalid native TUI proposal before it reaches Kernel workflow', async () => {
    const harness = createSession('sess_native_tui_invalid', plan());
    const invalid = { ...plan(), schemaVersion: 5 };

    const turnId = 'turn_native_tui_invalid';
    const result = await harness.session.submitPlannerProposal({
      sessionId: harness.sessionId,
      turnId,
      userInput: '创建任务',
      submissionId: createPlannerProposalSubmissionId(harness.sessionId, turnId, invalid),
      plan: invalid,
      runtimeMode: 'interactive',
    });

    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' ? result.issues.join('\n') : '').toContain('schemaVersion');
    expect(harness.kernelDecisionRepo.listBySession('sess_native_tui_invalid')).toHaveLength(0);
  });

  it('normalizes a whitespace taskId before validation and creates one canonical Task identity', async () => {
    const harness = createSession('sess_native_blank_task_id', plan());
    const rawPlan = plan({
      id: 'plan_blank_task_id',
      task: { ...plan().task, taskId: '   ' },
    });
    const turnId = 'turn_blank_task_id';

    const result = await harness.session.submitPlannerProposal({
      sessionId: harness.sessionId,
      turnId,
      userInput: '创建一个工作区文件',
      submissionId: createPlannerProposalSubmissionId(harness.sessionId, turnId, rawPlan),
      plan: rawPlan,
      runtimeMode: 'interactive',
    });

    expect(result).toMatchObject({
      status: 'accepted',
      outcome: 'task_authorized',
      taskId: expect.stringMatching(/^task_/),
    });
    expect(harness.taskRepo.findAll()).toHaveLength(1);
    expect(harness.taskRepo.findAll()[0]?.id).toMatch(/^task_/);
    expect(harness.taskRepo.findById('')).toBeNull();
    expect(harness.taskRepo.findById('   ')).toBeNull();
  });

  it('returns an accepted proposal after Task and Work Graph persistence without waiting for Executor completion', async () => {
    let notifyExecutorStarted!: () => void;
    const executorStarted = new Promise<void>(resolveStarted => {
      notifyExecutorStarted = resolveStarted;
    });
    let finishExecutor: (() => void) | null = null;
    const harness = createSession('sess_native_background_executor', plan(), () => {
      const wait = new Promise<number>(resolve => {
        finishExecutor = () => resolve(0);
      });
      notifyExecutorStarted();
      return { body: 'background executor done', wait };
    });
    const rawPlan = plan({ id: 'plan_background_executor' });
    const turnId = 'turn_background_executor';

    const resultPromise = harness.session.submitPlannerProposal({
      sessionId: harness.sessionId,
      turnId,
      userInput: '创建一个后台执行的任务',
      submissionId: createPlannerProposalSubmissionId(harness.sessionId, turnId, rawPlan),
      plan: rawPlan,
      runtimeMode: 'interactive',
    });
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        finishExecutor?.();
        reject(new Error('proposal submission waited for Executor completion'));
      }, 250);
    });

    try {
      const result = await Promise.race([resultPromise, timeout]);
      expect(result).toMatchObject({
        status: 'accepted', outcome: 'task_authorized', taskId: expect.stringMatching(/^task_/),
      });
      expect(harness.taskRepo.findAll()).toHaveLength(1);
      expect(harness.db.prepare('SELECT COUNT(*) AS count FROM work_graph_revisions').get())
        .toEqual({ count: 1 });
      expect(harness.attemptSandbox.create).not.toHaveBeenCalled();
      await executorStarted;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      finishExecutor?.();
      await harness.session.waitForAsyncWork();
    }
  });

  it('replays the same accepted submission without duplicating Kernel or interaction facts', async () => {
    const harness = createSession('sess_native_idempotent', plan());
    const direct = plan({
      id: 'plan_idempotent',
      action: 'direct_reply',
      response: { directReply: 'idempotent reply' },
      task: {
        binding: 'none', taskId: null, control: 'none', scope: null,
        title: null, goal: null, includeRecentConversationContext: false, priority: null,
      },
      workGraph: null,
    });
    const turnId = 'turn_idempotent';
    const submissionId = createPlannerProposalSubmissionId(harness.sessionId, turnId, direct);
    const submission = {
      sessionId: harness.sessionId, turnId, userInput: 'hello', submissionId, plan: direct,
      runtimeMode: 'interactive' as const,
    };

    const first = await harness.session.submitPlannerProposal(submission);
    const replay = await harness.session.submitPlannerProposal(submission);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: 'accepted', outcome: 'direct_reply_delivered' });
    expect(harness.kernelDecisionRepo.listBySession(harness.sessionId)).toHaveLength(1);
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM interactions').get()).toEqual({ count: 1 });
    expect(harness.session.getSnapshot().output.filter(line => line.includes('> hello'))).toHaveLength(1);
  });

  it('reports an in-flight identical submission without submitting a duplicate Kernel event', async () => {
    const harness = createSession('sess_native_in_flight', plan());
    const rawPlan = plan({ id: 'plan_in_flight' });
    const turnId = 'turn_in_flight';
    const submissionId = createPlannerProposalSubmissionId(harness.sessionId, turnId, rawPlan);
    const proposals = new PlannerProposalRepo(harness.db);
    proposals.ensureTurn(harness.sessionId, turnId, 'create work');
    proposals.reserveSubmission({
      sessionId: harness.sessionId,
      turnId,
      submissionId,
      planFingerprint: plannerProposalFingerprint(rawPlan),
      planId: rawPlan.id,
      eventId: `plan_event_${submissionId}`,
    });

    const result = await harness.session.submitPlannerProposal({
      sessionId: harness.sessionId,
      turnId,
      userInput: 'create work',
      submissionId,
      plan: rawPlan,
      runtimeMode: 'interactive',
    });

    expect(result).toMatchObject({ status: 'transport_uncertain', retryableByReplay: true });
    expect(harness.kernelDecisionRepo.listBySession(harness.sessionId)).toHaveLength(0);
  });

  it('locks an accepted turn against a different submission', async () => {
    const harness = createSession('sess_native_conflict', plan());
    const firstPlan = plan({
      id: 'plan_first', action: 'no_action', response: { directReply: null },
      task: {
        binding: 'none', taskId: null, control: 'none', scope: null,
        title: null, goal: null, includeRecentConversationContext: false, priority: null,
      },
      workGraph: null,
    });
    const revisedPlan = { ...firstPlan, id: 'plan_revised', reason: 'different submission' };
    const turnId = 'turn_conflict';
    const firstSubmissionId = createPlannerProposalSubmissionId(harness.sessionId, turnId, firstPlan);
    const revisedSubmissionId = createPlannerProposalSubmissionId(harness.sessionId, turnId, revisedPlan);

    await expect(harness.session.submitPlannerProposal({
      sessionId: harness.sessionId, turnId, userInput: 'nothing to do',
      submissionId: firstSubmissionId, plan: firstPlan,
    })).resolves.toMatchObject({ status: 'accepted' });
    await expect(harness.session.submitPlannerProposal({
      sessionId: harness.sessionId, turnId, userInput: 'nothing to do',
      submissionId: revisedSubmissionId, plan: revisedPlan,
    })).resolves.toMatchObject({
      status: 'conflict', acceptedSubmissionId: firstSubmissionId,
    });
    expect(harness.kernelDecisionRepo.listBySession(harness.sessionId)).toHaveLength(1);
  });

  it('keeps the turn open after Kernel rejection so a revised proposal can be accepted', async () => {
    const harness = createSession('sess_native_kernel_revision', plan());
    const rejectedPlan = plan({
      id: 'plan_missing_task_status',
      action: 'task_control',
      response: { directReply: null },
      task: {
        binding: 'reference', taskId: 'task_missing', control: 'status_query', scope: 'dashboard',
        title: null, goal: null, includeRecentConversationContext: false, priority: null,
      },
      workGraph: null,
    });
    const acceptedPlan = plan({
      id: 'plan_revision_reply',
      action: 'direct_reply',
      response: { directReply: '目标任务不存在，请先确认任务 ID。' },
      task: {
        binding: 'none', taskId: null, control: 'none', scope: null,
        title: null, goal: null, includeRecentConversationContext: false, priority: null,
      },
      workGraph: null,
    });
    const turnId = 'turn_kernel_revision';

    const rejected = await harness.session.submitPlannerProposal({
      sessionId: harness.sessionId, turnId, userInput: 'resume missing task',
      submissionId: createPlannerProposalSubmissionId(harness.sessionId, turnId, rejectedPlan),
      plan: rejectedPlan,
    });
    const revised = await harness.session.submitPlannerProposal({
      sessionId: harness.sessionId, turnId, userInput: 'resume missing task',
      submissionId: createPlannerProposalSubmissionId(harness.sessionId, turnId, acceptedPlan),
      plan: acceptedPlan,
    });

    expect(rejected).toMatchObject({ status: 'rejected', rejectionType: 'kernel' });
    expect(revised).toMatchObject({ status: 'accepted', outcome: 'direct_reply_delivered' });
    expect(harness.kernelDecisionRepo.listBySession(harness.sessionId).map(item => item.action))
      .toEqual(['reject_request', 'deliver_direct_reply']);
  });

  it('does not inject confirmed global memory into the Planner model input', async () => {
    const harness = createSession('sess_direct_memory', context => plan({
      action: 'direct_reply',
      reason: '确认宿主不注入偏好',
      response: {
        directReply: JSON.stringify(context).includes('我的名字是咸蛋超人')
          ? '宿主注入了偏好。'
          : '偏好需要通过 Planner MCP 查询。',
      },
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
    }));
    harness.memoryEngine.addManual({
      content: '我的名字是咸蛋超人',
      scope: 'global',
      type: 'identity',
    });

    await harness.session.submit('我的名字是什么？', { awaitAsyncWork: true });

    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('偏好需要通过 Planner MCP 查询。');
    expect(output).not.toContain('宿主注入了偏好。');
  });

  it('does not expose an unconfirmed global memory to a direct reply', async () => {
    const harness = createSession('sess_direct_pending_memory', context => plan({
      action: 'direct_reply',
      reason: '回答是否存在未确认记忆',
      response: {
        directReply: JSON.stringify(context).includes('未确认的秘密')
          ? '泄露了未确认记忆。'
          : '没有使用未确认记忆。',
      },
      task: {
        binding: 'none', taskId: null, control: 'none', scope: null,
        title: null, goal: null, includeRecentConversationContext: false, priority: null,
      },
      workGraph: null,
    }));
    const pending = harness.memoryEngine.addManual({
      content: '未确认的秘密',
      scope: 'global',
      type: 'identity',
    });
    harness.memoryEngine.update(pending.id, { status: 'pending' });

    await harness.session.submit('你知道什么？', { awaitAsyncWork: true });

    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('没有使用未确认记忆。');
    expect(output).not.toContain('泄露了未确认记忆。');
  });

  it('lets the PlanningAgent own dialogue memory without replaying persisted history', async () => {
    let turn = 0;
    let nativeThreadMarker: string | null = null;
    const receivedInputs: string[] = [];
    const harness = createSession('sess_direct_history', context => {
      turn += 1;
      receivedInputs.push(context.userInput);
      if (turn === 1 && context.userInput.includes('青鸟')) nativeThreadMarker = '青鸟';
      return plan({
        action: 'direct_reply',
        reason: '延续当前对话',
        response: {
          directReply: turn === 1
            ? '好的，暗号是青鸟。'
            : nativeThreadMarker
              ? `你刚才的暗号是${nativeThreadMarker}。`
              : '我没有找到刚才的暗号。',
        },
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
      });
    });

    await harness.session.submit('请记住，暗号是青鸟。', { awaitAsyncWork: true });
    await harness.session.submit('我刚才说的暗号是什么？', { awaitAsyncWork: true });

    expect(harness.session.getSnapshot().output.join('\n')).toContain('你刚才的暗号是青鸟。');
    expect(receivedInputs).toEqual([
      '请记住，暗号是青鸟。',
      '我刚才说的暗号是什么？',
    ]);
  });

  it('authorizes a durable task, dispatches the executor, and audits the decision', async () => {
    const harness = createSession('sess_durable', plan());

    await harness.session.submit('实现一个普通功能', { awaitAsyncWork: true });

    const [createdTask] = harness.taskRepo.findAll();
    expect(createdTask).toBeDefined();
    expect(harness.attemptSandbox.create).toHaveBeenCalledTimes(1);

    const audits = harness.kernelDecisionRepo.listBySession('sess_durable');
    expect(audits.some(audit => audit.action === 'authorize_task_plan')).toBe(true);
    expect(audits.some(audit => audit.action === 'dispatch_batch')).toBe(true);
    expect(audits.some(audit => audit.action === 'complete_task')).toBe(true);
  });

  it('runs independent frontier items concurrently and publishes them in stable dispatch order', async () => {
    let running = 0;
    let maximumRunning = 0;
    const release = new Map<string, () => void>();
    let notifyBothStarted!: () => void;
    const bothStarted = new Promise<void>(resolve => {
      notifyBothStarted = resolve;
    });
    let notifyOneFinished!: () => void;
    const oneFinished = new Promise<void>(resolve => {
      notifyOneFinished = resolve;
    });
    const harness = createSession('sess_concurrent_frontier', plan({
      workGraph: {
        reason: 'two independent implementation units',
        subtasks: [
          {
            id: 'subtask_a',
            title: 'Implement A',
            goal: 'Implement A',
            dependencies: [],
            contextRefs: [{ kind: 'current_user_input' }],
            requiredCapabilities: ['workspace-engineering'],
            preferredAgentClassList: ['codex-cli'],
            deliveryKind: 'report',
            acceptance: [{
              key: 'a_done',
              description: 'A is complete.',
              requiredEvidence: ['completion result'],
            }],
            riskLevel: 'low',
          },
          {
            id: 'subtask_b',
            title: 'Implement B',
            goal: 'Implement B',
            dependencies: [],
            contextRefs: [{ kind: 'current_user_input' }],
            requiredCapabilities: ['workspace-engineering'],
            preferredAgentClassList: ['codex-cli'],
            deliveryKind: 'report',
            acceptance: [{
              key: 'b_done',
              description: 'B is complete.',
              requiredEvidence: ['completion result'],
            }],
            riskLevel: 'low',
          },
        ],
      },
    }), input => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      const wait = new Promise<number>(resolve => {
        release.set(input.subtaskId, () => {
          running -= 1;
          if (running === 1) notifyOneFinished();
          resolve(0);
        });
        if (release.size === 2) notifyBothStarted();
      });
      return { body: `${input.subtaskId} done`, wait };
    });

    const submission = harness.session.submit('Implement A and B', { awaitAsyncWork: true });
    await Promise.race([
      bothStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(JSON.stringify({
        dispatchItems: harness.db.prepare(`
          SELECT subtask_id, status, batch_order, error_summary
          FROM kernel_dispatch_items ORDER BY batch_order
        `).all(),
        subtasks: harness.db.prepare(`
          SELECT id, status, error FROM subtasks ORDER BY id
        `).all(),
        workUnits: harness.db.prepare(`
          SELECT id, agent_class_name, state, claimed_subtask_id
          FROM work_units ORDER BY id
        `).all(),
        receipts: harness.db.prepare(`
          SELECT subtask_id, terminal_state, error_code, error_detail, failure_json
          FROM executor_attempt_receipts ORDER BY completed_at
        `).all(),
        workUnitEvents: harness.db.prepare(`
          SELECT work_unit_id, subtask_id, event_type, state, message
          FROM work_unit_events ORDER BY created_at
        `).all(),
        resourceWaits: harness.db.prepare(`
          SELECT subtask_id, status FROM resource_waits ORDER BY requested_at
        `).all(),
        output: harness.session.getSnapshot().output,
      }))), 2_000)),
    ]);
    expect(maximumRunning).toBe(2);

    const releaseSubtask = (authoredId: string) => {
      const item = [...release.entries()].find(([runtimeId]) => runtimeId.endsWith(`_${authoredId}`));
      expect(item).toBeDefined();
      item?.[1]();
    };
    releaseSubtask('subtask_b');
    await oneFinished;
    expect(running).toBe(1);
    releaseSubtask('subtask_a');
    await submission;

    expect(harness.taskRepo.findAll()[0]).toMatchObject({ status: 'done' });
    expect((harness.db.prepare(`
      SELECT subtask_id, status, batch_order
      FROM kernel_dispatch_items
      ORDER BY batch_order ASC
    `).all() as Array<{ subtask_id: string; status: string; batch_order: number }>).map(item => ({
      ...item,
      subtask_id: item.subtask_id.endsWith('_subtask_a') ? 'subtask_a' : 'subtask_b',
    }))).toEqual([
      { subtask_id: 'subtask_a', status: 'terminal', batch_order: 0 },
      { subtask_id: 'subtask_b', status: 'terminal', batch_order: 1 },
    ]);
    expect((harness.db.prepare(`
      SELECT subtask_id, status, first_dispatch_order
      FROM workspace_publications
      ORDER BY first_dispatch_order ASC
    `).all() as Array<{ subtask_id: string; status: string; first_dispatch_order: number }>).map(item => ({
      ...item,
      subtask_id: item.subtask_id.endsWith('_subtask_a') ? 'subtask_a' : 'subtask_b',
    }))).toEqual([
      { subtask_id: 'subtask_a', status: 'integrated', first_dispatch_order: 0 },
      { subtask_id: 'subtask_b', status: 'integrated', first_dispatch_order: 1 },
    ]);
    expect((harness.db.prepare(`
      SELECT publication.subtask_id
      FROM workspace_merge_attempts AS merge_attempt
      JOIN workspace_publications AS publication ON publication.id = merge_attempt.publication_id
      ORDER BY merge_attempt.rowid ASC
    `).all() as Array<{ subtask_id: string }>).map(item => ({
      subtask_id: item.subtask_id.endsWith('_subtask_a') ? 'subtask_a' : 'subtask_b',
    }))).toEqual([
      { subtask_id: 'subtask_a' },
      { subtask_id: 'subtask_b' },
    ]);
  });

  it('routes exhausted task failure through one Kernel-authorized replan revision', async () => {
    let plannerCalls = 0;
    let replanRequest = '';
    const contextBuild = vi.spyOn(PlanningContextBuilder.prototype, 'build');
    const harness = createSession('sess_replan', context => {
      plannerCalls += 1;
      if (plannerCalls === 1) return plan();
      replanRequest = context.userInput;
      const taskId = context.userInput.match(/Task id: (\S+)/)?.[1] ?? null;
      return plan({
        id: 'plan_replan',
        task: {
          binding: 'reference', taskId, control: 'none', scope: null, title: 'Implement remaining work',
          goal: 'Implement the remaining work after failure', includeRecentConversationContext: false,
          priority: { level: 'normal', reason: 'automatic replan' },
        },
      });
    }, (input, attemptIndex, db) => {
      if (attemptIndex === 0) {
        seedPriorGenerationEvidence(db, input.taskId);
        return {
          rawOutput: `failed\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
            failure: { kind: 'task_failed', code: 'implementation_failed', summary: 'approach exhausted' },
          })}`,
        };
      }
      return { rawOutput: completionResponseFromSandboxInput(input, 'replanned work done') };
    });

    await harness.session.submit('Implement a feature', { awaitAsyncWork: true });

    const contextBuildCalls = contextBuild.mock.calls.length;
    contextBuild.mockRestore();
    expect(plannerCalls).toBe(2);
    expect(replanRequest).not.toContain('evidence_prior_generation');
    expect(replanRequest).not.toContain('must not leak into the current generation');
    expect(contextBuildCalls).toBe(3);
    expect(harness.attemptSandbox.create).toHaveBeenCalledTimes(2);
    expect(harness.taskRepo.findAll()[0]).toMatchObject({ status: 'done' });
    expect(harness.db.prepare(`
      SELECT revision, status, automatic_replan FROM work_graph_revisions ORDER BY revision
    `).all()).toEqual([
      { revision: 1, status: 'superseded', automatic_replan: 0 },
      { revision: 2, status: 'completed', automatic_replan: 1 },
    ]);
    expect(harness.kernelDecisionRepo.listBySession('sess_replan').map(item => item.action)).toEqual(
      expect.arrayContaining(['request_replan', 'authorize_task_plan', 'complete_task']),
    );
  });

  it('handles a direct reply without creating a task and audits it', async () => {
    const harness = createSession('sess_direct', plan({
      action: 'direct_reply',
      reason: '普通对话',
      response: { directReply: '你好，我是 MetaClaw。' },
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
    }));

    await harness.session.submit('你好呀', { awaitAsyncWork: true });

    expect(harness.taskRepo.findAll()).toHaveLength(0);
    expect(harness.attemptSandbox.create).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot().output.join('\n')).toContain('你好，我是 MetaClaw。');
    const audits = harness.kernelDecisionRepo.listBySession('sess_direct');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('deliver_direct_reply');
    expect(audits[0]!.taskId).toBeNull();
  });

  it('routes direct replies through the same persisted decide() seam', async () => {
    const decideSpy = vi.spyOn(ControlKernel.prototype, 'decide');
    const harness = createSession('sess_shortcircuit', plan({
      action: 'direct_reply',
      reason: '普通对话',
      response: { directReply: '今天是星期四。' },
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
    }));

    await harness.session.submit('今天星期几', { awaitAsyncWork: true });

    expect(decideSpy).toHaveBeenCalledTimes(1);
    expect(harness.attemptSandbox.create).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot().output.join('\n')).toContain('今天是星期四。');
    const audits = harness.kernelDecisionRepo.listBySession('sess_shortcircuit');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('deliver_direct_reply');

    decideSpy.mockRestore();
  });

  it('clarifies a low-confidence state-changing turn without creating or dispatching a task', async () => {
    const harness = createSession('sess_clarify', plan({
      confidence: 0.2,
      reason: '低置信度',
      clarificationQuestion: '请明确是聊天还是创建任务。',
    }));

    await harness.session.submit('这个可能要处理一下', { awaitAsyncWork: true });

    expect(harness.taskRepo.findAll()).toHaveLength(0);
    expect(harness.attemptSandbox.create).not.toHaveBeenCalled();
    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('请明确是聊天还是创建任务。');
    expect(output).not.toContain('统一意图裁决置信度不足');
    expect(output).not.toContain('→ 输入：');
    expect(output).not.toContain('→ 判断：');
    expect(output).not.toContain('confidence=');
    const audits = harness.kernelDecisionRepo.listBySession('sess_clarify');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('request_clarification');
  });

  it('maps proposal validation rejection to a user-safe action while preserving the durable reason', async () => {
    const rejectedPlan = plan();
    rejectedPlan.workGraph!.subtasks[0]!.preferredAgentClassList = ['ghost-executor'] as never;
    const harness = createSession('sess_reject_executor', rejectedPlan);

    await harness.session.submit('交给不存在的执行器', { awaitAsyncWork: true });

    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('当前请求未通过执行校验，请调整请求后重试。');
    expect(output).not.toContain('ControlKernel rejected request');
    expect(output).not.toContain('no available executor agent class');
    expect(harness.kernelDecisionRepo.listBySession('sess_reject_executor')).toHaveLength(0);
    const proposal = harness.db.prepare(`
      SELECT result_json FROM planner_proposal_submissions
      WHERE session_id = ? AND status = 'rejected'
    `).get('sess_reject_executor') as { result_json: string };
    const result = JSON.parse(proposal.result_json) as { issues: string[] };
    expect(result.issues.join('; ')).toContain('preferredAgentClassList');
  });
});
