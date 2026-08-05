import { describe, expect, it, vi } from 'vitest';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import { AnyFusionPlanningAgent } from '../../src/planning/anyfusion-planning-agent.js';
import type { PlannerProposalResult } from '../../src/planning/planner-proposal.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    userInput: '实现一个功能',
    request: { sessionId: 'session_test', source: 'test' },
    pendingAuthorizationRequest: null,
    executorCatalog: getPlannerExecutorCatalog(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

const VALID_PLAN = {
  id: 'plan_1',
  schemaVersion: 7,
  action: 'plan_work_graph',
  confidence: 0.9,
  reason: '需要执行',
  clarificationQuestion: null,
  response: { directReply: null },
  task: {
    binding: 'new', taskId: null, control: 'none', scope: null,
    title: '重构', goal: '重构并测试', includeRecentConversationContext: false,
    priority: { level: 'high', reason: '用户要求优先完成' },
  },
  risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
  authorizationResolution: null,
  workGraph: {
    reason: '单步执行',
    subtasks: [{
      id: 'impl', title: '实现', goal: '实现并测试', dependencies: [],
      contextRefs: [{ kind: 'current_user_input' }],
      requiredCapabilities: ['workspace-engineering'],
      preferredAgentClassList: ['codex-cli'], deliveryKind: 'edit',
      acceptance: [{ key: 'tests_pass', description: '测试通过', requiredEvidence: ['test result'] }],
      riskLevel: 'medium',
    }],
  },
  source: 'anyfusion-planner',
} as const;

function accepted(outcome = 'proposal_validated'): Extract<PlannerProposalResult, { status: 'accepted' }> {
  return {
    status: 'accepted', turnId: 'turn-1', submissionId: 'submission-1', planId: 'plan_1',
    outcome: outcome as never, displayText: 'accepted', taskId: null, kernel: null,
  };
}

function runner(result = accepted()) {
  return {
    run: vi.fn(async () => ({
      proposalResult: result,
      submittedPlan: VALID_PLAN,
      toolCalls: [{
        sequence: 1, toolName: 'submit_planning_proposal', status: 'completed' as const,
        argumentsSummary: {}, resultSummary: {},
      }],
      threadId: null,
      durationMs: 1,
    })),
  };
}

describe('AnyFusionPlanningAgent native proposal tool adapter', () => {
  it('sends only the current input and returns a MetaClaw-validated tool argument for internal planning', async () => {
    const plannerRunner = runner();
    const agent = new AnyFusionPlanningAgent({ runner: plannerRunner });

    const result = await agent.plan(context());

    expect(result).toMatchObject({ id: 'plan_1', schemaVersion: 7, action: 'plan_work_graph' });
    expect(plannerRunner.run).toHaveBeenCalledWith('实现一个功能', expect.any(Object), 'validation');
    expect(plannerRunner.run).toHaveBeenCalledTimes(1);
  });

  it('returns the authoritative Kernel result for user-facing RPC turns without resubmission', async () => {
    const kernelAccepted = accepted('direct_reply_delivered');
    const plannerRunner = runner(kernelAccepted);
    const agent = new AnyFusionPlanningAgent({ runner: plannerRunner });

    await expect(agent.submit(context())).resolves.toEqual(kernelAccepted);
    expect(plannerRunner.run).toHaveBeenCalledWith('实现一个功能', expect.any(Object), 'kernel');
    expect(plannerRunner.run).toHaveBeenCalledTimes(1);
  });

  it('does not add an outer repair loop when the structured runner fails', async () => {
    const plannerRunner = { run: vi.fn(async () => { throw new Error('agent ended after rejection'); }) };
    const agent = new AnyFusionPlanningAgent({ runner: plannerRunner as never });

    await expect(agent.plan(context())).rejects.toThrow('agent ended after rejection');
    expect(plannerRunner.run).toHaveBeenCalledTimes(1);
    await expect(agent.submit(context())).resolves.toMatchObject({
      status: 'transport_uncertain', retryableByReplay: true,
    });
    expect(plannerRunner.run).toHaveBeenCalledTimes(2);
  });

  it('keeps audit failure best-effort and counts native proposal tool calls', async () => {
    const audit = {
      start: vi.fn(() => ({ id: 'planner_run_test' })),
      finish: vi.fn(() => { throw new Error('database is locked'); }),
    };
    const agent = new AnyFusionPlanningAgent({ runner: runner(), audit });

    await expect(agent.plan(context())).resolves.toMatchObject({ id: 'plan_1' });
    expect(audit.finish).toHaveBeenCalledWith(expect.objectContaining({
      id: 'planner_run_test', status: 'completed', attemptCount: 1,
    }));
  });
});
