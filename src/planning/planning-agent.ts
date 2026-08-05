import type { PlannerProposalResult } from './planner-proposal.js';
import type { PlanningAgentPlan, PlanningContext } from './planning-types.js';

export interface PlanningProposalSubmitter {
  submit(plan: PlanningAgentPlan): Promise<PlannerProposalResult>;
}

export interface PlanningAgent {
  /** Run a user-facing turn whose proposal is submitted to MetaClaw in the same Pi ReAct loop. */
  submit(context: PlanningContext, submitter: PlanningProposalSubmitter): Promise<PlannerProposalResult>;

  /** Generate an internally requested proposal through the same tool, validated by MetaClaw before return. */
  plan(context: PlanningContext): Promise<PlanningAgentPlan>;
}
