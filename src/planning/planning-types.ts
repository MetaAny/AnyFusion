import type {
  PlannerExecutorCatalog,
} from '../executor/builtin-executor-catalog.js';
import type { WorkGraphProposal, WorkGraphSubtask } from '../work-graph/index.js';

export type PlanningAction =
  | 'direct_reply'
  | 'clarification'
  | 'task_control'
  | 'plan_work_graph'
  | 'authorization_resolution'
  | 'no_action';

// Planning vocabulary shared across the PlanningAgent path. These string unions
// used to live in the retired core/intent-orchestrator module; they now have
// their home here on the live planning path.
export type IntentRiskLevel = 'low' | 'medium' | 'high';
export type IntentTaskBinding = 'new' | 'reference' | 'none';
export type IntentTaskControl =
  | 'clear_tasks'
  | 'status_query'
  | 'resume_task'
  | 'recover_blocked'
  | 'none';
export type TaskSemanticPriority = 'normal' | 'high' | 'urgent';

export type SubtaskProposal = WorkGraphSubtask;
export type { WorkGraphProposal };

export interface PlanningAgentPlan {
  id: string;
  schemaVersion: 7;
  action: PlanningAction;
  confidence: number;
  reason: string;
  clarificationQuestion: string | null;
  response: {
    directReply: string | null;
  };
  task: {
    binding: IntentTaskBinding;
    taskId: string | null;
    control: IntentTaskControl;
    scope: string | null;
    title: string | null;
    goal: string | null;
    includeRecentConversationContext: boolean;
    priority: {
      level: TaskSemanticPriority;
      reason: string;
    } | null;
  };
  risk: {
    level: IntentRiskLevel;
    requiresConfirmation: boolean;
    reasons: string[];
  };
  authorizationResolution: {
    requestId: string;
    resolution: 'approve' | 'deny';
  } | null;
  workGraph: WorkGraphProposal | null;
  source: string;
}

export interface PlanningContext {
  userInput: string;
  request: {
    sessionId: string;
    source: string;
  };
  pendingAuthorizationRequest: {
    requestId: string;
    taskId: string;
    capability: string;
    resource: string;
    operation: string;
    reason: string;
  } | null;
  executorCatalog: PlannerExecutorCatalog;
  timeoutMs: number;
}
