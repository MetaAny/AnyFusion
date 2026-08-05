import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PlanningAgentPlanOutputSchema,
  PlanningAgentPlanSchema,
} from '../../src/planning/planning-agent-plan-schema.js';

function outputPlan() {
  return {
    id: 'plan_1',
    schemaVersion: 7,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'work is required',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: 'Implement change',
      goal: 'Implement and test the requested change',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'normal scheduling' },
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: {
      reason: 'single implementation delivery',
      subtasks: [{
        id: 'impl',
        title: 'Implement',
        goal: 'Implement and test',
        dependencies: [],
        contextRefs: [{ kind: 'current_user_input' }],
        requiredCapabilities: ['workspace-engineering'],
        preferredAgentClassList: ['codex-cli'],
        deliveryKind: 'edit',
        acceptance: [{ key: 'tests_pass', description: 'tests pass', requiredEvidence: ['test result'] }],
        riskLevel: 'low',
      }],
    },
    source: 'anyfusion-planner',
  };
}

describe('PlanningAgent plan schemas', () => {
  it('generates a Responses API compatible structured-output schema without oneOf', () => {
    const schema = z.toJSONSchema(PlanningAgentPlanOutputSchema, {
      target: 'draft-7',
      unrepresentable: 'any',
    });

    expect(JSON.stringify(schema)).not.toContain('"oneOf"');
  });

  it('strictly rejects missing nested fields instead of applying semantic defaults', () => {
    const valid = outputPlan();
    const parsed = PlanningAgentPlanSchema.safeParse({
      ...valid,
      task: {
        ...valid.task,
        priority: { level: 'normal' },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects empty or whitespace-only plan IDs instead of relying on generated defaults', () => {
    const valid = outputPlan();

    expect(PlanningAgentPlanSchema.safeParse({ ...valid, id: '' }).success).toBe(false);
    expect(PlanningAgentPlanSchema.safeParse({ ...valid, id: '   ' }).success).toBe(false);
  });

  it('rejects v2/v3 and removed execution-routing fields', () => {
    const valid = outputPlan();
    expect(PlanningAgentPlanSchema.safeParse({
      ...valid,
      schemaVersion: 2,
      execution: { mode: 'single_executor', selectedExecutor: 'codex-cli' },
    }).success).toBe(false);
    expect(PlanningAgentPlanSchema.safeParse({ ...valid, schemaVersion: 3 }).success).toBe(false);

    expect(PlanningAgentPlanSchema.safeParse({
      ...valid,
      workGraph: {
        ...valid.workGraph,
        subtasks: [{ ...valid.workGraph.subtasks[0], dependsOn: [] }],
      },
    }).success).toBe(false);

    const subtask = valid.workGraph.subtasks[0];
    expect(PlanningAgentPlanSchema.safeParse({
      ...valid,
      workGraph: {
        ...valid.workGraph,
        subtasks: [{
          ...subtask,
          requiredAgentClassKind: 'executor',
          candidateAgentClasses: ['codex-cli'],
        }],
      },
    }).success).toBe(false);
  });

  it('rejects an empty work graph at the structured-output boundary', () => {
    const valid = outputPlan();
    const parsed = PlanningAgentPlanOutputSchema.safeParse({
      ...valid,
      workGraph: { ...valid.workGraph, subtasks: [] },
    });

    expect(parsed.success).toBe(false);
  });

  it('requires null workGraph for non-work-graph actions', () => {
    const valid = outputPlan();
    expect(PlanningAgentPlanSchema.safeParse({
      ...valid,
      action: 'direct_reply',
    }).success).toBe(false);
  });
});
