import type {
  BuiltinExecutorName,
  RoutingCapabilityId,
} from '../executor/builtin-executor-catalog.js';

export type WorkGraphItemType = 'text' | 'artifact';

export interface WorkGraphRequiredItem {
  key: string;
  type: WorkGraphItemType;
  description: string;
}

export interface WorkGraphDependency {
  fromSubtaskId: string;
  requiredItems: WorkGraphRequiredItem[];
}

export type ContextRef =
  | { kind: 'current_user_input' }
  | { kind: 'interaction'; interactionId: string; side: 'user' | 'assistant' }
  | { kind: 'task_resource'; locator: string }
  | { kind: 'task_evidence'; evidenceId: string }
  | { kind: 'preference'; preferenceId: string };

export interface WorkGraphAcceptanceCriterion {
  key: string;
  description: string;
  requiredEvidence: string[];
}

export interface WorkGraphSubtask {
  id: string;
  title: string;
  goal: string;
  dependencies: WorkGraphDependency[];
  contextRefs: ContextRef[];
  requiredCapabilities: RoutingCapabilityId[];
  preferredAgentClassList: BuiltinExecutorName[];
  deliveryKind: 'edit' | 'report';
  acceptance: WorkGraphAcceptanceCriterion[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface WorkGraphProposal {
  reason: string;
  subtasks: WorkGraphSubtask[];
}
