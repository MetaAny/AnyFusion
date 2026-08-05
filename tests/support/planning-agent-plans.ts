import { vi } from 'vitest';
import type { PlanningAgent } from '../../src/planning/planning-agent.js';
import type {
  IntentTaskControl,
  PlanningAgentPlan,
  SubtaskProposal,
  WorkGraphProposal,
} from '../../src/planning/planning-types.js';
import type { ContextRef } from '../../src/work-graph/index.js';

// Test-only builders for PlanningAgentPlan. Full-stack/acceptance tests inject a
// PlanningAgent whose plan() returns one of these, exercising the real
// session -> ControlKernel -> Runtime path with a deterministic plan instead of a
// mocked routing decision.

function basePlan(): PlanningAgentPlan {
  return {
    id: 'plan_test',
    schemaVersion: 7,
    action: 'direct_reply',
    confidence: 0.9,
    reason: 'test plan',
    clarificationQuestion: null,
    response: { directReply: '这是一条测试直接回答' },
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
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: null,
    source: 'anyfusion-planner',
  };
}

export function directReplyPlan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return { ...basePlan(), action: 'direct_reply', reason: '普通对话', ...overrides };
}

export function singleSubtaskWorkGraph(input: {
  goal: string;
  title?: string;
  executor?: string;
  deliveryKind?: SubtaskProposal['deliveryKind'];
  acceptance?: string[];
  riskLevel?: SubtaskProposal['riskLevel'];
  contextRefs?: ContextRef[];
}): WorkGraphProposal {
  const executor = input.executor === 'pi-agent' ? 'pi-agent' : 'codex-cli';
  const deliveryKind = input.deliveryKind ?? 'edit';
  return {
    reason: 'single executor work graph',
    subtasks: [{
      id: 'subtask_execute',
      title: input.title ?? input.goal.slice(0, 50) ?? 'Execute task',
      goal: input.goal,
      dependencies: [],
      contextRefs: input.contextRefs ?? [{ kind: 'current_user_input' }],
      requiredCapabilities: [executor === 'pi-agent' ? 'current-web-research' : 'workspace-engineering'],
      preferredAgentClassList: [executor],
      deliveryKind,
      acceptance: (input.acceptance ?? ['Satisfy the user request and report verification or remaining risk.'])
        .map((description, index) => ({
          key: `criterion_${index + 1}`,
          description,
          requiredEvidence: [],
        })),
      riskLevel: input.riskLevel ?? 'low',
    }],
  };
}

export function workGraphPlan(input: {
  goal: string;
  title?: string;
  executor?: string;
  capabilityClass?: 'conversation' | 'general' | 'code_edit';
  requiresVerification?: boolean;
  canModifyFiles?: boolean;
  matchedBoundary?: string[];
  includeRecentConversationContext?: boolean;
  deliveryKind?: SubtaskProposal['deliveryKind'];
  priority?: PlanningAgentPlan['task']['priority'];
  contextRefs?: ContextRef[];
  overrides?: Partial<PlanningAgentPlan>;
} ): PlanningAgentPlan {
  const executor = input.executor ?? 'codex-cli';
  // Default to a report task. Code/repo tests opt in through code_edit.
  const capabilityClass = input.capabilityClass ?? 'general';
  const deliveryKind = input.deliveryKind ?? (capabilityClass === 'code_edit' ? 'edit' : 'report');
  return {
    ...basePlan(),
    action: 'plan_work_graph',
    reason: 'planner 产出工作图',
    task: {
      ...basePlan().task,
      binding: 'new',
      title: input.title ?? input.goal.slice(0, 50),
      goal: input.goal,
      includeRecentConversationContext: input.includeRecentConversationContext ?? false,
      priority: input.priority ?? { level: 'normal', reason: 'test default priority' },
    },
    workGraph: singleSubtaskWorkGraph({
      goal: input.goal,
      title: input.title,
      executor,
      deliveryKind,
      contextRefs: input.contextRefs,
    }),
    ...input.overrides,
  };
}

export function taskControlPlan(input: {
  control: IntentTaskControl;
  taskId?: string | null;
  scope?: string | null;
  reason?: string;
  overrides?: Partial<PlanningAgentPlan>;
}): PlanningAgentPlan {
  return {
    ...basePlan(),
    action: 'task_control',
    reason: input.reason ?? '任务控制',
    task: {
      ...basePlan().task,
      binding: input.taskId ? 'reference' : 'none',
      taskId: input.taskId ?? null,
      control: input.control,
      scope: input.scope ?? null,
      priority: input.control === 'resume_task' || input.control === 'recover_blocked'
        ? { level: 'normal', reason: 'test resume priority' }
        : null,
    },
    ...input.overrides,
  };
}

export function clarificationPlan(question: string, overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    ...basePlan(),
    action: 'clarification',
    reason: '低置信度',
    confidence: 0.2,
    clarificationQuestion: question,
    ...overrides,
  };
}

// A PlanningAgent stub returning a fixed plan (or a queue of plans, one per turn).
export function stubPlanningAgent(...plans: PlanningAgentPlan[]): PlanningAgent & {
  plan: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
} {
  const plan = vi.fn();
  if (plans.length <= 1) {
    plan.mockResolvedValue(plans[0] ?? directReplyPlan());
  } else {
    for (const value of plans) {
      plan.mockResolvedValueOnce(value);
    }
    plan.mockResolvedValue(plans[plans.length - 1]!);
  }
  return planningAgentFromPlanMock(plan);
}

export function planningAgentFromPlanMock(plan: ReturnType<typeof vi.fn>): PlanningAgent & {
  plan: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn(async (context, submitter) => submitter.submit(await plan(context)));
  return { plan, submit } as PlanningAgent & {
    plan: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
  };
}
