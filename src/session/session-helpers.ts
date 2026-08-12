// Shared structural session helpers for execution requests, inline resources,
// and editor submission.
import type { ExecutionMode, TaskRecoveryTrigger } from '../core/types.js';
import type { WorkGraphProposal } from '../work-graph/types.js';
import type { WorkGraphAuthorization } from '../execution/work-graph-runtime-service.js';
export { planTaskExecution, type TaskExecutionPlan as ExecutionPlan } from '../task/task-execution-planner.js';
export {
  extractInlineResourceMatches,
  stripInlineResourceMatches,
  type InlineResourceMatch,
} from '../intent/inline-resource-normalizer.js';

export type QueuedExecutionRequest = {
  userPrompt: string;
  contextTaskId: string;
  executionMode: ExecutionMode;
  authorizedWorkGraph?: WorkGraphProposal | null;
  workGraphAuthorization?: WorkGraphAuthorization | null;
  kernelDecisionId?: string | null;
  origin?: 'user' | 'system';
  schedulingReason?: string;
  newlyProvidedResources?: string[];
  recoveryTrigger?: TaskRecoveryTrigger;
  includeRecentConversationContext?: boolean;
};

export function prepareEditorSubmission(editor: { text: string; cursor: number }): {
  userInput: string;
  nextEditor: { text: string; cursor: number };
} {
  return {
    userInput: editor.text.trim(),
    nextEditor: { text: '', cursor: 0 },
  };
}

