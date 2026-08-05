import { PlannerProcessRunner, type PlannerRunner, type PlannerToolCallTrace } from './planner-process-runner.js';
import type { PlannerProposalPurpose, PlannerProposalResult } from './planner-proposal.js';
import type { PlanningAgent } from './planning-agent.js';
import type { PlanningAgentPlan, PlanningContext } from './planning-types.js';
import { PlanningAgentPlanSchema } from './planning-agent-plan-schema.js';

export interface AnyFusionPlanningAgentDeps {
  runner: PlannerRunner;
  audit?: {
    start(sessionId: string, requestSource: string): { id: string };
    finish(input: {
      id: string;
      status: 'completed' | 'failed';
      attemptCount: number;
      durationMs: number;
      errorSummary?: string | null;
      toolCalls: PlannerToolCallTrace[];
    }): void;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Deep Planner process adapter. Proposal validation/revision happens inside the
 * Pi tool loop; this module never parses assistant text and never owns a repair
 * loop.
 */
export class AnyFusionPlanningAgent implements PlanningAgent {
  constructor(private readonly deps: AnyFusionPlanningAgentDeps) {}

  async submit(context: PlanningContext): Promise<PlannerProposalResult> {
    try {
      return (await this.run(context, 'kernel')).proposalResult;
    } catch (error) {
      return {
        status: 'transport_uncertain',
        turnId: 'unknown',
        submissionId: 'unknown',
        retryableByReplay: true,
        message: `Planner unavailable: ${(error as Error).message}`,
      };
    }
  }

  async plan(context: PlanningContext): Promise<PlanningAgentPlan> {
    const result = await this.run(context, 'validation');
    if (result.proposalResult.status !== 'accepted'
      || result.proposalResult.outcome !== 'proposal_validated') {
      throw new Error(`Planner proposal did not reach validated terminal state: ${result.proposalResult.status}`);
    }
    const parsed = PlanningAgentPlanSchema.safeParse(result.submittedPlan);
    if (!parsed.success) {
      throw new Error('Planner tool completed without a valid PlanningAgentPlan v7 argument');
    }
    return parsed.data as PlanningAgentPlan;
  }

  private async run(context: PlanningContext, purpose: PlannerProposalPurpose) {
    const effectiveContext = {
      ...context,
      timeoutMs: context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_TIMEOUT_MS,
    };
    const auditRun = this.deps.audit?.start(context.request.sessionId, context.request.source);
    const startedAt = Date.now();
    try {
      const result = await this.deps.runner.run(context.userInput, effectiveContext, purpose);
      if (auditRun) this.finishAudit({
        id: auditRun.id,
        status: 'completed',
        attemptCount: result.toolCalls.filter(call => call.toolName === 'submit_planning_proposal').length,
        durationMs: Date.now() - startedAt,
        toolCalls: result.toolCalls,
      });
      return result;
    } catch (error) {
      if (auditRun) this.finishAudit({
        id: auditRun.id,
        status: 'failed',
        attemptCount: 0,
        durationMs: Date.now() - startedAt,
        errorSummary: (error as Error).message,
        toolCalls: [],
      });
      throw error;
    }
  }

  private finishAudit(
    input: Parameters<NonNullable<AnyFusionPlanningAgentDeps['audit']>['finish']>[0],
  ): void {
    try {
      this.deps.audit?.finish(input);
    } catch {
      // Audit persistence is best effort and must not replace the planning result.
    }
  }
}

export function createDefaultPlanningAgent(
  deps: Partial<AnyFusionPlanningAgentDeps> = {},
): AnyFusionPlanningAgent {
  return new AnyFusionPlanningAgent({
    runner: deps.runner ?? new PlannerProcessRunner(),
    audit: deps.audit,
  });
}
