import type { PlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import {
  deriveCancellationClosure,
  validateWorkGraph as validateWorkGraphStructure,
} from '../work-graph/index.js';
import type { WorkGraphProposal } from '../work-graph/types.js';
import { contextRefKey } from '../work-graph/index.js';
import type { KernelExecutorStatusProjection } from './executor-status-projection.js';
import { deriveAgentAvailability } from './agent-availability.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import {
  evaluateCapabilityRequest,
  type CapabilityGrant,
  type NormalizedCapabilityRequest,
  type PermissionRule,
  type ResourceClaim,
} from '../resource/index.js';

export type KernelTaskStatus = 'created' | 'ready' | 'running' | 'parked' | 'blocked' | 'done' | 'archived' | 'cancelled';
export type KernelSubtaskStatus = 'ready' | 'running' | 'awaiting_integration' | 'awaiting_decision' | 'blocked' | 'done' | 'cancelled';
export type KernelAttemptKind = 'primary' | 'continuation' | 'fallback' | 'contract_correction' | 'merge_repair';
export type KernelRecoveryMode = 'native_session' | 'recovery_packet' | 'fresh';
export type KernelRecoverySafety = 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent';
export type KernelDispatchItemStatus =
  | 'pending_launch'
  | 'launching'
  | 'running'
  | 'cancelling'
  | 'terminal'
  | 'cancelled'
  | 'uncertain';
export type KernelAttemptPayload =
  | {
      protocol: 'completion-correction-v2';
      completionContract: unknown;
      violations: Array<{ code: string; path: string; message: string }>;
    }
  | {
      protocol: 'metaclaw:merge-repair:v1';
      publicationId: string;
      conflictChainId: string;
      conflictingPaths: string[];
    }
  | null;

export interface KernelEventEnvelope {
  schemaVersion: 5;
  id: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  sessionId: string;
  taskId?: string;
  subtaskId?: string;
  attemptId?: string;
}

export interface KernelPlanProposal {
  id: string;
  schemaVersion: 7;
  action: 'direct_reply' | 'clarification' | 'task_control' | 'plan_work_graph' | 'authorization_resolution' | 'no_action';
  confidence: number;
  reason: string;
  clarificationQuestion: string | null;
  response: { directReply: string | null };
  task: {
    binding: 'new' | 'reference' | 'none';
    taskId: string | null;
    control: 'clear_tasks' | 'status_query' | 'resume_task' | 'recover_blocked' | 'none';
    scope: string | null;
    title: string | null;
    goal: string | null;
    includeRecentConversationContext: boolean;
    priority: { level: 'normal' | 'high' | 'urgent'; reason: string } | null;
  };
  risk: { level: 'low' | 'medium' | 'high'; requiresConfirmation: boolean; reasons: string[] };
  authorizationResolution: { requestId: string; resolution: 'approve' | 'deny' } | null;
  workGraph: WorkGraphProposal | null;
  source: string;
}

export type KernelEvent =
  | (KernelEventEnvelope & {
      type: 'plan_proposed';
      proposal: KernelPlanProposal;
      requestText: string;
      generationId: string;
      proposalSource: 'initial' | 'replan' | 'conflict_replan';
      targetGraphRevision: number;
      availabilityExplanation?: string | null;
    })
  | (KernelEventEnvelope & {
      type: 'executor_recovered';
      agentClassName: string;
      recoveryCheckId: string;
    })
  | (KernelEventEnvelope & { type: 'dispatch_requested'; reason: string })
  | (KernelEventEnvelope & {
      type: 'capacity_signal';
      agentClassName: string;
      available: boolean;
      cycleId: string;
      attemptKind: KernelAttemptKind;
      attemptPayload: KernelAttemptPayload;
    })
  | (KernelEventEnvelope & {
      type: 'execution_outcome';
      terminalKind: 'completed' | 'failed';
      agentClassName: string;
      attemptKind: KernelAttemptKind;
      sourceAttemptId: string | null;
      failure: KernelFailure | null;
    })
  | (KernelEventEnvelope & {
      type: 'handoff_contract_failed';
      workUnitId: string;
      agentClassName: string;
      contract: unknown;
      violations: Array<{ code: string; path: string; message: string }>;
      receiptCount: number;
      responseBytes: number;
    })
  | (KernelEventEnvelope & {
      type: 'timer_tick';
      wakeKind: 'capacity' | 'retry' | 'availability';
      sourceDecisionId: string;
      scheduledFor: string;
      retry: { agentClassName: string; sourceAttemptId: string } | null;
    })
  | (KernelEventEnvelope & {
      type: 'recovery_resolution_requested';
      recoveryItemId: string;
      resolution: 'assume_applied' | 'retry';
    })
  | (KernelEventEnvelope & {
      type: 'permission_requested';
      request: NormalizedCapabilityRequest;
    })
  | (KernelEventEnvelope & {
      type: 'permission_resolution_received';
      requestId: string;
      resolution: 'approve' | 'deny';
      source: 'command' | 'button' | 'planner';
      plannerPlanId: string | null;
    })
  | (KernelEventEnvelope & {
      type: 'partition_conflict_observed';
      claims: ResourceClaim[];
      conflictingLeaseIds: string[];
    })
  | (KernelEventEnvelope & {
      type: 'sandbox_lost';
      containerId: string | null;
      workspaceId: string;
      checkpointId: string | null;
    })
  | (KernelEventEnvelope & {
      type: 'merge_conflict_observed';
      publicationId: string;
      conflictChainId: string;
      agentClassName: string;
      sourceAttemptId: string;
      repairAttemptsUsed: number;
      conflictReplansUsed: number;
      conflictingPaths: string[];
    })
  | (KernelEventEnvelope & {
      type: 'task_cancel_requested';
      reason: string;
    })
  | (KernelEventEnvelope & {
      type: 'subtasks_cancel_requested';
      targetSubtaskIds: string[];
      reason: string;
    })
  | (KernelEventEnvelope & {
      type: 'partial_result_acceptance_requested';
    })
  | (KernelEventEnvelope & {
      type: 'generation_quiescence_observed';
      requestId: string;
      generationId: string;
      sourceRevision: number;
    });

export interface KernelTaskFact {
  id: string;
  status: KernelTaskStatus;
}

export interface KernelSubtaskFact {
  id: string;
  taskId: string;
  status: KernelSubtaskStatus;
  preferredAgentClassList: string[];
}

export interface KernelAttemptFact {
  attemptId: string;
  subtaskId: string;
  agentClassName: string;
  attemptKind: KernelAttemptKind;
  sourceAttemptId: string | null;
  terminalKind: 'completed' | 'failed';
  failure: KernelFailure | null;
  completedAt: string;
}

export interface KernelCancellationSubtaskFact extends KernelSubtaskFact {
  dependencySubtaskIds: string[];
}

export interface KernelDispatchItemFact {
  attemptId: string;
  subtaskId: string;
  status: KernelDispatchItemStatus;
  order: number;
}

export type KernelSnapshot =
  | {
      schemaVersion: 5;
      type: 'plan_admission';
      tasks: KernelTaskFact[];
      runningTaskId: string | null;
      executorCatalog: PlannerExecutorCatalog;
      executorStatuses: KernelExecutorStatusProjection[];
      v5WorkGraphTaskIds: string[];
      eligibleContextRefKeys: string[];
      pendingAuthorizationRequest: { requestId: string; taskId: string } | null;
    }
  | {
      schemaVersion: 5;
      type: 'dispatch';
      task: KernelTaskFact | null;
      runningTaskId: string | null;
      graphState: 'ready' | 'missing' | 'conflict';
      subtasks: KernelSubtaskFact[];
      frontier: string[];
      dispatchItems: KernelDispatchItemFact[];
      maxConcurrentAttempts: number;
      availableSlots: number;
      resourceConflictSubtaskIds: string[];
      capacityProbeAgentClasses: Record<string, string[]>;
      executorStatuses: KernelExecutorStatusProjection[];
      correctionSupportedAgentClasses: string[];
      nativeContinuationAgentClasses: string[];
      attempts: KernelAttemptFact[];
      generationId: string;
      graphRevision: number;
      automaticReplansUsed: number;
      recoverySafety: KernelRecoverySafety;
      automaticRecoveryAllowed: boolean;
      resourceGrantsBySubtask: Record<string, ResourceClaim[]>;
      completionBlockedReasons: string[];
      generationReplanRequest: {
        id: string;
        status: 'pending_quiescence' | 'planning' | 'submitted';
      } | null;
      generationQuiescent: boolean;
    }
  | {
      schemaVersion: 5;
      type: 'task_control';
      task: KernelTaskFact | null;
      generationId: string | null;
      graphRevision: number | null;
      subtasks: KernelCancellationSubtaskFact[];
      completionBlockedReasons: string[];
      partialCancellation: boolean;
    }
  | {
      schemaVersion: 5;
      type: 'timer';
      task: KernelTaskFact | null;
      wakeAuthorized: boolean;
      capacityBlockedAt: string | null;
      recheckAfterMs: number;
      capacityAgentClasses: string[];
      nativeContinuationAgentClasses: string[];
      executorStatuses: KernelExecutorStatusProjection[];
      defaultResourceGrant: ResourceClaim[];
    }
  | {
      schemaVersion: 5;
      type: 'recovery';
      task: KernelTaskFact | null;
      item: {
        id: string;
        kind: 'application' | 'effect';
        status: 'uncertain' | 'failed';
        retrySafe: boolean;
      } | null;
    }
  | {
      schemaVersion: 5;
      type: 'invalid';
      reason: string;
    }
  | {
      schemaVersion: 5;
      type: 'permission';
      request: NormalizedCapabilityRequest | null;
      requestStatus: 'pending' | 'granted' | 'denied' | 'expired' | null;
      rules: PermissionRule[];
      currentGrants: CapabilityGrant[];
      userAuthorizationFingerprints: string[];
      previouslyDeniedFingerprints: string[];
      attemptActive: boolean;
      workspaceId: string | null;
      checkpointId: string | null;
    }
  | {
      schemaVersion: 5;
      type: 'partition';
      conflictConfirmed: boolean;
      workspaceId: string | null;
      checkpointId: string | null;
    }
  | {
      schemaVersion: 5;
      type: 'sandbox_recovery';
      workspaceExists: boolean;
      workspaceId: string | null;
      checkpointId: string | null;
      activeLeaseIds: string[];
    }
  | {
      schemaVersion: 5;
      type: 'availability_recovery';
      task: KernelTaskFact | null;
      activeGenerationId: string | null;
      activeGraphRevision: number | null;
      deferredPlan: Extract<KernelEvent, { type: 'plan_proposed' }> | null;
      executorStatuses: KernelExecutorStatusProjection[];
    };

export type KernelDecisionAction =
  | { type: 'reject_request' }
  | { type: 'request_clarification'; question: string }
  | { type: 'deliver_direct_reply'; response: string }
  | { type: 'no_op' }
  | {
      type: 'authorize_task_plan';
      taskId: string;
      task: KernelPlanProposal['task'];
      workGraph: WorkGraphProposal;
      generationId: string;
      graphRevision: number;
      proposalSource: 'initial' | 'replan' | 'conflict_replan';
    }
  | { type: 'authorize_task_control'; task: KernelPlanProposal['task'] }
  | {
      type: 'dispatch_batch';
      taskId: string;
      items: Array<{
        subtaskId: string;
        agentClassName: string;
        attemptId: string;
        attemptKind: KernelAttemptKind;
        sourceAttemptId: string | null;
        recoveryMode: KernelRecoveryMode;
        defaultResourceGrant: ResourceClaim[];
        order: number;
        attemptPayload: KernelAttemptPayload;
      }>;
    }
  | { type: 'probe_capacity'; taskId: string; subtaskId: string; agentClassName: string }
  | { type: 'wait_for_capacity'; taskId: string; subtaskId: string }
  | {
      type: 'wait_for_retry';
      taskId: string;
      subtaskId: string;
      resumeAt: string;
      agentClassName: string;
      sourceAttemptId: string;
    }
  | { type: 'request_replan'; taskId: string; generationId: string; sourceRevision: number }
  | {
      type: 'queue_generation_replan';
      taskId: string;
      generationId: string;
      sourceRevision: number;
      requestId: string;
    }
  | {
      type: 'defer_task_plan_for_availability';
      taskId: string;
      proposalEvent: Extract<KernelEvent, { type: 'plan_proposed' }>;
      unavailableAgentClassNames: string[];
      explanation: string;
    }
  | {
      type: 'activate_deferred_task_plan';
      taskId: string;
      replanRequestId: string;
      task: KernelPlanProposal['task'];
      workGraph: WorkGraphProposal;
      generationId: string;
      graphRevision: number;
      proposalSource: 'replan';
    }
  | {
      type: 'cancel_task';
      taskId: string;
      generationId: string | null;
    }
  | {
      type: 'cancel_subtasks';
      taskId: string;
      generationId: string;
      graphRevision: number;
      subtaskIds: string[];
      expectedStatuses: Array<{ subtaskId: string; status: KernelSubtaskStatus }>;
    }
  | {
      type: 'accept_partial_result';
      taskId: string;
      generationId: string;
      graphRevision: number;
      completedSubtaskIds: string[];
      cancelledSubtaskIds: string[];
    }
  | {
      type: 'request_merge_replan';
      taskId: string;
      subtaskId: string;
      publicationId: string;
      conflictChainId: string;
    }
  | { type: 'resolve_recovery'; taskId: string; recoveryItemId: string; resolution: 'assume_applied' | 'retry' }
  | { type: 'block_work'; taskId: string; subtaskId: string | null }
  | { type: 'park_for_replan'; taskId: string }
  | { type: 'complete_task'; taskId: string }
  | {
      type: 'record_permission_resolution';
      taskId: string;
      requestId: string;
      resolution: 'approve' | 'deny';
      plannerPlanId: string;
    }
  | {
      type: 'grant_capability';
      requestId: string;
      limits: CapabilityGrant['limits'];
      ruleId: string;
      authorization: { receivedEventId: string; resolution: 'approve'; source: 'command' | 'button' | 'planner'; plannerPlanId: string | null } | null;
    }
  | {
      type: 'deny_capability';
      requestId: string;
      notifyPlanner: false;
      authorization: { receivedEventId: string; resolution: 'deny'; source: 'command' | 'button' | 'planner'; plannerPlanId: string | null } | null;
    }
  | { type: 'escalate_capability'; requestId: string; notifyPlanner: true }
  | { type: 'wait_for_partition'; taskId: string; subtaskId: string; conflictingLeaseIds: string[] }
  | {
      type: 'recover_workspace_attempt';
      taskId: string;
      subtaskId: string;
      workspaceId: string;
      checkpointId: string | null;
      requestId: string | null;
      authorization: { receivedEventId: string; resolution: 'approve'; source: 'command' | 'button' | 'planner'; plannerPlanId: string | null } | null;
    };

export interface KernelDecision {
  schemaVersion: 5;
  id: string;
  eventId: string;
  action: KernelDecisionAction;
  reason: string;
}

const STATE_CHANGE_ACTIONS = new Set<KernelPlanProposal['action']>(['task_control', 'plan_work_graph']);
const MAX_CORRECTION_INPUT_BYTES = 128 * 1024;

/** Pure strategic interpreter for every Phase 3 control-plane event. */
export class ControlKernel {
  decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision {
    if (!snapshotMatches(event, snapshot)) {
      return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'event and snapshot do not match');
    }
    switch (event.type) {
      case 'plan_proposed':
        return this.decidePlan(event, snapshot as Extract<KernelSnapshot, { type: 'plan_admission' }>);
      case 'executor_recovered':
        return this.decideAvailabilityRecovery(
          event,
          snapshot as Extract<KernelSnapshot, { type: 'availability_recovery' }>,
        );
      case 'dispatch_requested':
        return this.decideDispatch(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'capacity_signal':
        return this.decideCapacity(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'execution_outcome':
        return this.decideOutcome(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'handoff_contract_failed':
        return this.decideContractFailure(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'timer_tick':
        return this.decideTimer(event, snapshot as Extract<KernelSnapshot, { type: 'timer' }>);
      case 'recovery_resolution_requested':
        return this.decideRecovery(event, snapshot as Extract<KernelSnapshot, { type: 'recovery' }>);
      case 'permission_requested':
      case 'permission_resolution_received':
        return this.decidePermission(event, snapshot as Extract<KernelSnapshot, { type: 'permission' }>);
      case 'partition_conflict_observed':
        return this.decidePartitionConflict(event, snapshot as Extract<KernelSnapshot, { type: 'partition' }>);
      case 'sandbox_lost':
        return this.decideSandboxRecovery(event, snapshot as Extract<KernelSnapshot, { type: 'sandbox_recovery' }>);
      case 'merge_conflict_observed':
        return this.decideMergeConflict(event, snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>);
      case 'task_cancel_requested':
      case 'subtasks_cancel_requested':
      case 'partial_result_acceptance_requested':
        return this.decideTaskControl(
          event,
          snapshot as Extract<KernelSnapshot, { type: 'task_control' }>,
        );
      case 'generation_quiescence_observed':
        return this.decideGenerationQuiescence(
          event,
          snapshot as Extract<KernelSnapshot, { type: 'dispatch' }>,
        );
    }
  }

  private decidePlan(
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
    snapshot: Extract<KernelSnapshot, { type: 'plan_admission' }>,
  ): KernelDecision {
    const proposal = event.proposal;
    const validation = validatePlanningAgentPlan(
      proposal as PlanningAgentPlan,
      snapshot.executorCatalog,
      snapshot.pendingAuthorizationRequest,
    );
    if (!validation.valid) return decision(event, { type: 'reject_request' }, `invalid PlanningAgentPlan: ${validation.errors.join('; ')}`);
    if (isStateChanging(proposal) && proposal.risk.requiresConfirmation) {
      return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? '该操作存在较高风险，请明确确认是否继续执行。' }, 'risk confirmation required');
    }
    if (STATE_CHANGE_ACTIONS.has(proposal.action) && proposal.confidence < 0.45) {
      return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? 'Please clarify the requested task change.' }, 'low confidence state-changing plan');
    }
    if (proposal.action === 'direct_reply') {
      return decision(event, { type: 'deliver_direct_reply', response: proposal.response.directReply ?? '' }, 'direct reply authorized');
    }
    if (proposal.action === 'clarification') {
      return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? 'Please clarify your request.' }, proposal.reason);
    }
    if (proposal.action === 'no_action') return decision(event, { type: 'no_op' }, 'no runtime action required');
    if (proposal.action === 'authorization_resolution') {
      const resolution = proposal.authorizationResolution;
      if (!resolution || !snapshot.pendingAuthorizationRequest || resolution.requestId !== snapshot.pendingAuthorizationRequest.requestId) {
        return decision(event, { type: 'reject_request' }, 'authorization resolution does not match the pending request');
      }
      return decision(event, {
        type: 'record_permission_resolution',
        taskId: snapshot.pendingAuthorizationRequest.taskId,
        requestId: resolution.requestId,
        resolution: resolution.resolution,
        plannerPlanId: proposal.id,
      }, 'Planner interpretation of exact authorization response accepted');
    }
    if (proposal.task.taskId !== null && !snapshot.tasks.some(task => task.id === proposal.task.taskId)) {
      return decision(event, { type: 'reject_request' }, `task not found: ${proposal.task.taskId}`);
    }
    if (proposal.action === 'task_control') {
      if ((proposal.task.control === 'resume_task' || proposal.task.control === 'recover_blocked') && !proposal.task.taskId) {
        return decision(event, { type: 'request_clarification', question: proposal.clarificationQuestion ?? 'Which task should be resumed?' }, 'resume requires an explicit task');
      }
      if (snapshot.runningTaskId && proposal.task.taskId !== snapshot.runningTaskId && !['status_query', 'clear_tasks'].includes(proposal.task.control)) {
        return decision(event, { type: 'reject_request' }, `single-active Task constraint: ${snapshot.runningTaskId}`);
      }
      return decision(event, { type: 'authorize_task_control', task: proposal.task }, 'task control authorized');
    }
    if (!proposal.workGraph) return decision(event, { type: 'reject_request' }, 'work graph is required');
    if (!event.generationId || !Number.isSafeInteger(event.targetGraphRevision) || event.targetGraphRevision < 1) {
      return decision(event, { type: 'reject_request' }, 'invalid graph generation or revision');
    }
    if (event.proposalSource === 'initial' && event.targetGraphRevision !== 1) {
      return decision(event, { type: 'reject_request' }, 'initial plan must authorize graph revision 1');
    }
    if (event.proposalSource !== 'initial' && (!proposal.task.taskId || event.targetGraphRevision < 2)) {
      return decision(event, { type: 'reject_request' }, 'replan must target an existing Task and a later revision');
    }
    if (snapshot.runningTaskId && proposal.task.taskId !== snapshot.runningTaskId) {
      return decision(event, { type: 'reject_request' }, `single-active Task constraint: ${snapshot.runningTaskId}`);
    }
    if (event.proposalSource === 'initial' && proposal.task.taskId && snapshot.v5WorkGraphTaskIds.includes(proposal.task.taskId)) {
      return decision(event, { type: 'reject_request' }, `task ${proposal.task.taskId} already has an active v5 work graph`);
    }
    const eligible = new Set(snapshot.eligibleContextRefKeys);
    const invalidRefs = proposal.workGraph.subtasks.flatMap(subtask => subtask.contextRefs
      .map(contextRefKey)
      .filter(key => !eligible.has(key)));
    if (invalidRefs.length > 0) {
      return decision(event, { type: 'request_clarification', question: 'The proposed context references are not available for this task.' }, `unqualified context refs: ${invalidRefs.join(', ')}`);
    }
    const unavailable = unavailableAgentClasses(snapshot.executorStatuses, event.occurredAt);
    const workGraph = {
      ...proposal.workGraph,
      subtasks: proposal.workGraph.subtasks.map(subtask => ({
        ...subtask,
        preferredAgentClassList: subtask.preferredAgentClassList.filter(name => !unavailable.has(name)),
      })),
    } satisfies WorkGraphProposal;
    if (workGraph.subtasks.some(subtask => subtask.preferredAgentClassList.length === 0)) {
      if (event.proposalSource === 'replan' && proposal.task.taskId) {
        const unavailableAgentClassNames = [...new Set(
          proposal.workGraph.subtasks.flatMap(subtask =>
            subtask.preferredAgentClassList.filter(name => unavailable.has(name))
          ),
        )];
        return decision(event, {
          type: 'defer_task_plan_for_availability',
          taskId: proposal.task.taskId,
          proposalEvent: event,
          unavailableAgentClassNames,
          explanation: event.availabilityExplanation
            ?? 'The revised plan is waiting because every eligible Executor for at least one Subtask is unavailable.',
        }, 'latest replan proposal deferred until Executor availability recovers');
      }
      return decision(event, { type: 'reject_request' }, 'no healthy canonical AgentClass remains');
    }
    const violations = validateWorkGraphStructure(workGraph);
    if (violations.length > 0) {
      return decision(event, { type: 'reject_request' }, violations.map(item => `${item.code}: ${item.message}`).join('; '));
    }
    return decision(event, {
      type: 'authorize_task_plan',
      taskId: proposal.task.taskId ?? deterministicTaskId(event.id),
      task: proposal.task,
      workGraph,
      generationId: event.generationId,
      graphRevision: event.targetGraphRevision,
      proposalSource: event.proposalSource,
    }, 'work graph authorized');
  }

  private decideDispatch(event: KernelEvent, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    if (!event.taskId || !snapshot.task || snapshot.task.id !== event.taskId) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'dispatch task is missing or stale');
    if (snapshot.graphState !== 'ready') {
      return decision(event, { type: 'park_for_replan', taskId: event.taskId }, `work graph is ${snapshot.graphState}; replanning is required`);
    }
    if (snapshot.runningTaskId && snapshot.runningTaskId !== event.taskId) {
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId ?? null }, `single-active Task constraint: ${snapshot.runningTaskId}`);
    }
    const subtasks = selectDispatchableSubtasks(snapshot);
    if (subtasks.length === 0) {
      if (snapshot.generationReplanRequest?.status === 'pending_quiescence') {
        return snapshot.generationQuiescent
          ? decision(event, {
              type: 'request_replan',
              taskId: event.taskId,
              generationId: snapshot.generationId,
              sourceRevision: snapshot.graphRevision,
            }, 'generation is quiescent; the coalesced automatic replan may start')
          : decision(event, { type: 'no_op' }, 'generation replan is waiting for quiescence');
      }
      if (snapshot.subtasks.length > 0 && snapshot.subtasks.every(item => item.status === 'done')) {
        return snapshot.completionBlockedReasons.length === 0
          ? decision(event, { type: 'complete_task', taskId: event.taskId }, 'all Subtasks completed and runtime residue is clear')
          : decision(event, { type: 'no_op' }, `Task completion is waiting for: ${snapshot.completionBlockedReasons.join(', ')}`);
      }
      if (snapshot.dispatchItems.some(item => isPendingOrActiveDispatch(item.status))
        || snapshot.subtasks.some(item => item.status === 'running' || item.status === 'awaiting_integration')) {
        return decision(event, { type: 'no_op' }, 'work is already executing or awaiting publication');
      }
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'no runnable Subtask while work remains');
    }
    const items = dispatchBatchItems(event, snapshot, subtasks);
    if (items.length === 0) {
      return decision(event, {
        type: 'wait_for_capacity', taskId: event.taskId, subtaskId: subtasks[0]!.id,
      }, 'all runnable Subtasks lack an available authorized AgentClass');
    }
    return decision(event, { type: 'dispatch_batch', taskId: event.taskId, items }, 'dispatch batch authorized');
  }

  private decideAvailabilityRecovery(
    event: Extract<KernelEvent, { type: 'executor_recovered' }>,
    snapshot: Extract<KernelSnapshot, { type: 'availability_recovery' }>,
  ): KernelDecision {
    const deferred = snapshot.deferredPlan;
    if (
      !event.taskId
      || !snapshot.task
      || snapshot.task.id !== event.taskId
      || snapshot.task.status !== 'blocked'
      || !deferred
      || deferred.taskId !== event.taskId
      || deferred.proposalSource !== 'replan'
      || deferred.targetGraphRevision !== (snapshot.activeGraphRevision ?? 0) + 1
      || deferred.generationId !== snapshot.activeGenerationId
      || !deferred.proposal.workGraph
    ) {
      return decision(event, { type: 'no_op' }, 'deferred availability proposal is missing, stale, or cancelled');
    }
    const unavailable = unavailableAgentClasses(snapshot.executorStatuses, event.occurredAt);
    const workGraph = {
      ...deferred.proposal.workGraph,
      subtasks: deferred.proposal.workGraph.subtasks.map(subtask => ({
        ...subtask,
        preferredAgentClassList: subtask.preferredAgentClassList.filter(name => !unavailable.has(name)),
      })),
    } satisfies WorkGraphProposal;
    if (workGraph.subtasks.some(subtask => subtask.preferredAgentClassList.length === 0)) {
      return decision(event, { type: 'no_op' }, 'recovered Executor does not make the deferred frontier executable');
    }
    const violations = validateWorkGraphStructure(workGraph);
    if (violations.length > 0) {
      return decision(event, { type: 'no_op' }, 'deferred availability proposal no longer validates');
    }
    return decision(event, {
      type: 'activate_deferred_task_plan',
      taskId: event.taskId,
      replanRequestId: event.correlationId,
      task: deferred.proposal.task,
      workGraph,
      generationId: deferred.generationId,
      graphRevision: deferred.targetGraphRevision,
      proposalSource: deferred.proposalSource,
    }, 'deferred availability proposal is executable again');
  }

  private decideCapacity(event: Extract<KernelEvent, { type: 'capacity_signal' }>, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    const subtask = snapshot.subtasks.find(item => item.id === event.subtaskId) ?? selectDispatchableSubtasks(snapshot)[0];
    if (!event.taskId || !subtask) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'capacity signal has no ready work');
    if (event.attemptKind === 'contract_correction') {
      return event.available
        ? decision(event, singleDispatchBatch(
            event, event.taskId, subtask.id, event.agentClassName, 'contract_correction',
            event.attemptId ?? null, 'fresh', resourceGrantForSubtask(snapshot, subtask.id),
            event.attemptPayload,
          ), 'response-only correction capacity confirmed')
        : decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: subtask.id }, 'response-only correction capacity unavailable');
    }
    if (event.available) {
      return decision(event, singleDispatchBatch(
        event, event.taskId, subtask.id, event.agentClassName, 'primary',
        null, 'fresh', resourceGrantForSubtask(snapshot, subtask.id),
        null,
      ), 'capacity confirmed');
    }
    const attempted = new Set([
      ...(snapshot.capacityProbeAgentClasses[subtask.id] ?? []),
      event.agentClassName,
    ]);
    const agentClassName = nextUsableAgentClass(subtask, snapshot, event.occurredAt, attempted);
    return agentClassName
      ? decision(event, { type: 'probe_capacity', taskId: event.taskId, subtaskId: subtask.id, agentClassName }, 'try next authorized AgentClass')
      : decision(event, { type: 'wait_for_capacity', taskId: event.taskId, subtaskId: subtask.id }, 'authorized AgentClass capacity exhausted');
  }

  private decideOutcome(event: Extract<KernelEvent, { type: 'execution_outcome' }>, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    if (!event.taskId) return decision(event, { type: 'block_work', taskId: '', subtaskId: event.subtaskId ?? null }, 'outcome has no Task');
    if (event.terminalKind === 'failed') {
      return this.decideFailure(event, snapshot);
    }
    return this.decideDispatch(event, snapshot);
  }

  private decideFailure(
    event: Extract<KernelEvent, { type: 'execution_outcome' }>,
    snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  ): KernelDecision {
    const taskId = event.taskId!;
    const subtask = snapshot.subtasks.find(item => item.id === event.subtaskId);
    const failure = event.failure;
    if (!subtask || !event.attemptId || !failure) {
      return decision(event, { type: 'block_work', taskId, subtaskId: event.subtaskId ?? null }, 'failure facts are incomplete');
    }
    if (event.attemptKind === 'contract_correction') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'response-only correction failed and cannot enter ordinary recovery');
    }
    if (failure.code === 'startup_orphaned_work') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'startup orphaned work requires explicit recovery');
    }
    if (snapshot.task?.status === 'cancelled' || subtask.status === 'cancelled') {
      return decision(event, { type: 'no_op' }, 'cancellation fence makes the late attempt outcome stale');
    }
    if (!snapshot.automaticRecoveryAllowed || snapshot.recoverySafety === 'external_non_idempotent') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, 'automatic recovery cannot prove external effect safety');
    }
    if (failure.kind === 'permission' || failure.kind === 'unknown' || failure.kind === 'stale' || failure.kind === 'cancelled') {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, `${failure.kind} requires explicit recovery`);
    }
    const retryable = ['network', 'timeout', 'infrastructure', 'heartbeat_lost'].includes(failure.kind);
    const isPreferred = subtask.preferredAgentClassList[0] === event.agentClassName;
    const classAttempts = snapshot.attempts.filter(attempt =>
      attempt.subtaskId === subtask.id
      &&
      attempt.agentClassName === event.agentClassName && attempt.attemptKind !== 'contract_correction'
    ).length;
    if (retryable && isPreferred && classAttempts <= 1) {
      const delayMs = failure.kind === 'network' ? 5_000 : 30_000;
      return decision(event, {
        type: 'wait_for_retry',
        taskId,
        subtaskId: subtask.id,
        resumeAt: addMilliseconds(event.occurredAt, delayMs),
        agentClassName: event.agentClassName,
        sourceAttemptId: event.attemptId,
      }, `preferred AgentClass continuation delayed after ${failure.kind}`);
    }
    if (!retryable && ![
      'authentication', 'configuration', 'adapter', 'capability_mismatch', 'task_failed', 'quality_failed',
    ].includes(failure.kind)) {
      return decision(event, { type: 'block_work', taskId, subtaskId: subtask.id }, `${failure.kind} has no safe recovery policy`);
    }
    return this.fallbackOrReplan(event, snapshot, subtask);
  }

  private fallbackOrReplan(
    event: Extract<KernelEvent, { type: 'execution_outcome' }>,
    snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
    subtask: KernelSubtaskFact,
  ): KernelDecision {
    const attempted = new Set(snapshot.attempts
      .filter(attempt => attempt.subtaskId === subtask.id && attempt.attemptKind !== 'contract_correction')
      .map(attempt => attempt.agentClassName));
    const agentClassName = nextUsableAgentClass(subtask, snapshot, event.occurredAt, attempted);
    if (agentClassName) {
      return decision(event, singleDispatchBatch(
        event, event.taskId!, subtask.id, agentClassName, 'fallback',
        event.attemptId!, 'recovery_packet', resourceGrantForSubtask(snapshot, subtask.id),
        null,
      ), 'next authorized fallback AgentClass selected');
    }
    return snapshot.automaticReplansUsed < 1
      ? decision(event, {
          type: 'queue_generation_replan',
          taskId: event.taskId!,
          generationId: snapshot.generationId,
          sourceRevision: snapshot.graphRevision,
          requestId: generationReplanRequestId(
            event.taskId!,
            snapshot.generationId,
            snapshot.graphRevision,
          ),
        }, 'authorized candidates exhausted; one coalesced automatic replan is allowed')
      : decision(event, { type: 'park_for_replan', taskId: event.taskId! }, 'automatic replan budget exhausted');
  }

  private decideTaskControl(
    event: Extract<KernelEvent, {
      type: 'task_cancel_requested' | 'subtasks_cancel_requested' | 'partial_result_acceptance_requested';
    }>,
    snapshot: Extract<KernelSnapshot, { type: 'task_control' }>,
  ): KernelDecision {
    if (!event.taskId || !snapshot.task || snapshot.task.id !== event.taskId) {
      return decision(event, { type: 'reject_request' }, 'Task control target is missing or stale');
    }
    if (event.type === 'task_cancel_requested') {
      if (['done', 'archived', 'cancelled'].includes(snapshot.task.status)) {
        return decision(event, { type: 'reject_request' }, `Task is already ${snapshot.task.status}`);
      }
      return decision(event, {
        type: 'cancel_task',
        taskId: event.taskId,
        generationId: snapshot.generationId,
      }, 'durable Task cancellation fence authorized');
    }
    if (!snapshot.generationId || snapshot.graphRevision === null) {
      return decision(event, { type: 'reject_request' }, 'active Work Graph generation is missing');
    }
    if (event.type === 'subtasks_cancel_requested') {
      const closure = deriveCancellationClosure(
        {
          subtasks: snapshot.subtasks.map(subtask => ({
            id: subtask.id,
            dependencies: subtask.dependencySubtaskIds.map(fromSubtaskId => ({
              fromSubtaskId,
            })),
          })),
        },
        snapshot.subtasks.map(subtask => ({
          subtaskId: subtask.id,
          status: subtask.status,
        })),
        event.targetSubtaskIds,
      );
      if (!closure.ok) {
        return decision(
          event,
          { type: 'reject_request' },
          `Subtask cancellation rejected (${closure.reason}): ${closure.subtaskIds.join(', ')}`,
        );
      }
      const selected = new Set(closure.subtaskIds);
      return decision(event, {
        type: 'cancel_subtasks',
        taskId: event.taskId,
        generationId: snapshot.generationId,
        graphRevision: snapshot.graphRevision,
        subtaskIds: closure.subtaskIds,
        expectedStatuses: snapshot.subtasks
          .filter(subtask => selected.has(subtask.id))
          .map(subtask => ({ subtaskId: subtask.id, status: subtask.status }))
          .sort((left, right) => left.subtaskId.localeCompare(right.subtaskId)),
      }, 'atomic downstream Subtask cancellation closure authorized');
    }
    const completedSubtaskIds = snapshot.subtasks
      .filter(subtask => subtask.status === 'done')
      .map(subtask => subtask.id)
      .sort();
    const cancelledSubtaskIds = snapshot.subtasks
      .filter(subtask => subtask.status === 'cancelled')
      .map(subtask => subtask.id)
      .sort();
    if (
      snapshot.task.status !== 'blocked'
      || !snapshot.partialCancellation
      || completedSubtaskIds.length === 0
      || snapshot.subtasks.some(subtask => !['done', 'cancelled'].includes(subtask.status))
      || snapshot.completionBlockedReasons.length > 0
    ) {
      return decision(event, { type: 'reject_request' }, 'partial result is not ready for explicit acceptance');
    }
    return decision(event, {
      type: 'accept_partial_result',
      taskId: event.taskId,
      generationId: snapshot.generationId,
      graphRevision: snapshot.graphRevision,
      completedSubtaskIds,
      cancelledSubtaskIds,
    }, 'explicit partial result acceptance authorized');
  }

  private decideGenerationQuiescence(
    event: Extract<KernelEvent, { type: 'generation_quiescence_observed' }>,
    snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  ): KernelDecision {
    const request = snapshot.generationReplanRequest;
    if (
      !event.taskId
      || !request
      || request.id !== event.requestId
      || request.status !== 'pending_quiescence'
      || event.generationId !== snapshot.generationId
      || event.sourceRevision !== snapshot.graphRevision
      || !snapshot.generationQuiescent
    ) {
      return decision(event, { type: 'no_op' }, 'generation quiescence observation is stale or incomplete');
    }
    return decision(event, {
      type: 'request_replan',
      taskId: event.taskId,
      generationId: event.generationId,
      sourceRevision: event.sourceRevision,
    }, 'generation quiescence token accepted');
  }

  private decideContractFailure(event: Extract<KernelEvent, { type: 'handoff_contract_failed' }>, snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>): KernelDecision {
    if (!event.taskId || !event.subtaskId) return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'contract failure identity is incomplete');
    if (event.receiptCount !== 1 || event.responseBytes > MAX_CORRECTION_INPUT_BYTES || !snapshot.correctionSupportedAgentClasses.includes(event.agentClassName)) {
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: event.subtaskId }, 'response-only correction is unavailable or already exhausted');
    }
    return decision(event, singleDispatchBatch(
      event, event.taskId, event.subtaskId, event.agentClassName, 'contract_correction',
      event.attemptId ?? null, 'fresh', resourceGrantForSubtask(snapshot, event.subtaskId),
      {
        protocol: 'completion-correction-v2',
        completionContract: event.contract,
        violations: event.violations,
      },
    ), 'one response-only contract correction authorized');
  }

  private decideTimer(event: Extract<KernelEvent, { type: 'timer_tick' }>, snapshot: Extract<KernelSnapshot, { type: 'timer' }>): KernelDecision {
    if (
      !event.taskId
      || !snapshot.task
      || snapshot.task.id !== event.taskId
      || snapshot.task.status !== 'blocked'
      || !snapshot.wakeAuthorized
    ) {
      return decision(event, { type: 'no_op' }, 'timer wake is stale or no longer authorized by Task state');
    }
    if (event.wakeKind === 'retry') {
      if (!event.taskId || !event.subtaskId || !event.retry || Date.parse(event.occurredAt) < Date.parse(event.scheduledFor)) {
        return decision(event, { type: 'no_op' }, 'retry wake is incomplete or early');
      }
      return decision(event, singleDispatchBatch(
        event,
        event.taskId,
        event.subtaskId,
        event.retry.agentClassName,
        'continuation',
        event.retry.sourceAttemptId,
        snapshot.nativeContinuationAgentClasses.includes(event.retry.agentClassName)
          ? 'native_session'
          : 'recovery_packet',
        snapshot.defaultResourceGrant,
        null,
      ), 'preferred AgentClass continuation wake authorized');
    }
    if (event.wakeKind !== 'capacity') return decision(event, { type: 'no_op' }, 'availability wake has no eligible work');
    if (!event.taskId || !event.subtaskId || !snapshot.capacityBlockedAt) return decision(event, { type: 'no_op' }, 'no capacity block is eligible');
    const elapsed = Date.parse(event.occurredAt) - Date.parse(snapshot.capacityBlockedAt);
    if (!Number.isFinite(elapsed) || elapsed < snapshot.recheckAfterMs) return decision(event, { type: 'no_op' }, 'capacity recheck interval has not elapsed');
    const unavailable = unavailableAgentClasses(snapshot.executorStatuses, event.occurredAt);
    const candidate = snapshot.capacityAgentClasses.find(name => !unavailable.has(name));
    return candidate
      ? decision(event, { type: 'probe_capacity', taskId: event.taskId, subtaskId: event.subtaskId, agentClassName: candidate }, 'capacity timer recheck authorized')
      : decision(event, { type: 'no_op' }, 'no healthy AgentClass is eligible for capacity probe');
  }

  private decideRecovery(
    event: Extract<KernelEvent, { type: 'recovery_resolution_requested' }>,
    snapshot: Extract<KernelSnapshot, { type: 'recovery' }>,
  ): KernelDecision {
    if (!event.taskId || !snapshot.task || snapshot.task.id !== event.taskId || !snapshot.item) {
      return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: null }, 'recovery item is missing or stale');
    }
    if (snapshot.item.id !== event.recoveryItemId) {
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'recovery item identity mismatch');
    }
    if (event.resolution === 'retry' && !snapshot.item.retrySafe) {
      return decision(event, { type: 'block_work', taskId: event.taskId, subtaskId: null }, 'recovery retry cannot prove idempotency');
    }
    return decision(event, {
      type: 'resolve_recovery',
      taskId: event.taskId,
      recoveryItemId: event.recoveryItemId,
      resolution: event.resolution,
    }, `manual recovery ${event.resolution} authorized`);
  }

  private decidePermission(
    event: Extract<KernelEvent, { type: 'permission_requested' | 'permission_resolution_received' }>,
    snapshot: Extract<KernelSnapshot, { type: 'permission' }>,
  ): KernelDecision {
    const request = snapshot.request;
    if (!request || request.taskId !== event.taskId || request.subtaskId !== event.subtaskId) {
      return decision(event, { type: 'deny_capability', requestId: request?.id ?? '', notifyPlanner: false, authorization: null }, 'permission request identity mismatch');
    }
    if (event.type === 'permission_resolution_received' && event.requestId !== request.id) {
      return decision(event, { type: 'deny_capability', requestId: event.requestId, notifyPlanner: false, authorization: null }, 'permission resolution request ID mismatch');
    }
    if (snapshot.requestStatus !== 'pending') {
      const existing = snapshot.currentGrants.find(grant => grant.requestId === request.id);
      if (existing && snapshot.requestStatus === 'granted') {
        return decision(event, {
          type: 'grant_capability',
          requestId: request.id,
          limits: existing.limits,
          ruleId: 'existing_grant',
          authorization: null,
        }, 'duplicate request returns the existing grant');
      }
      return decision(event, { type: 'deny_capability', requestId: request.id, notifyPlanner: false, authorization: null }, `permission request is ${snapshot.requestStatus ?? 'missing'}`);
    }
    if (event.type === 'permission_resolution_received' && event.resolution === 'deny') {
      return decision(event, {
        type: 'deny_capability',
        requestId: request.id,
        notifyPlanner: false,
        authorization: {
          receivedEventId: event.id,
          resolution: 'deny',
          source: event.source,
          plannerPlanId: event.plannerPlanId,
        },
      }, 'user denied the exact capability request');
    }
    if (event.type === 'permission_resolution_received' && !snapshot.attemptActive) {
      if (!snapshot.workspaceId) {
        return decision(event, { type: 'deny_capability', requestId: request.id, notifyPlanner: false, authorization: null }, 'approved request has no recoverable workspace');
      }
      return decision(event, {
        type: 'recover_workspace_attempt',
        taskId: request.taskId,
        subtaskId: request.subtaskId,
        workspaceId: snapshot.workspaceId,
        checkpointId: snapshot.checkpointId,
        requestId: request.id,
        authorization: {
          receivedEventId: event.id,
          resolution: 'approve',
          source: event.source,
          plannerPlanId: event.plannerPlanId,
        },
      }, 'user authorization recorded; a fresh recovery attempt must receive a new bounded grant');
    }
    const authorizationFingerprints = event.type === 'permission_resolution_received'
      ? [...new Set([...snapshot.userAuthorizationFingerprints, request.fingerprint])]
      : snapshot.userAuthorizationFingerprints;
    const result = evaluateCapabilityRequest({
      request,
      rules: snapshot.rules,
      now: event.occurredAt,
      previouslyDeniedFingerprints: snapshot.previouslyDeniedFingerprints,
      userAuthorizationFingerprints: authorizationFingerprints,
    });
    if (result.type === 'grant_capability') {
      return decision(event, {
        type: 'grant_capability',
        requestId: request.id,
        limits: result.limits,
        ruleId: result.ruleId,
        authorization: event.type === 'permission_resolution_received' ? {
          receivedEventId: event.id,
          resolution: 'approve',
          source: event.source,
          plannerPlanId: event.plannerPlanId,
        } : null,
      }, result.reason);
    }
    if (result.type === 'escalate_capability') {
      return decision(event, { type: 'escalate_capability', requestId: request.id, notifyPlanner: true }, result.reason);
    }
    return decision(event, { type: 'deny_capability', requestId: request.id, notifyPlanner: false, authorization: null }, result.reason);
  }

  private decidePartitionConflict(
    event: Extract<KernelEvent, { type: 'partition_conflict_observed' }>,
    snapshot: Extract<KernelSnapshot, { type: 'partition' }>,
  ): KernelDecision {
    if (!event.taskId || !event.subtaskId || !snapshot.conflictConfirmed || event.conflictingLeaseIds.length === 0) {
      return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'partition conflict facts are incomplete');
    }
    return decision(event, {
      type: 'wait_for_partition',
      taskId: event.taskId,
      subtaskId: event.subtaskId,
      conflictingLeaseIds: [...new Set(event.conflictingLeaseIds)].sort(),
    }, 'conflicting resource lease requires Kernel wait');
  }

  private decideSandboxRecovery(
    event: Extract<KernelEvent, { type: 'sandbox_lost' }>,
    snapshot: Extract<KernelSnapshot, { type: 'sandbox_recovery' }>,
  ): KernelDecision {
    if (!event.taskId || !event.subtaskId || !snapshot.workspaceExists || snapshot.workspaceId !== event.workspaceId) {
      return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null }, 'sandbox loss has no recoverable workspace');
    }
    return decision(event, {
      type: 'recover_workspace_attempt',
      taskId: event.taskId,
      subtaskId: event.subtaskId,
      workspaceId: event.workspaceId,
      checkpointId: snapshot.checkpointId,
      requestId: null,
      authorization: null,
    }, 'lost sandbox will be replaced by a fresh attempt using the persistent workspace');
  }

  private decideMergeConflict(
    event: Extract<KernelEvent, { type: 'merge_conflict_observed' }>,
    snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  ): KernelDecision {
    if (!event.taskId || !event.subtaskId || event.conflictingPaths.length === 0) {
      return decision(event, {
        type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null,
      }, 'merge conflict facts are incomplete');
    }
    if (event.repairAttemptsUsed < 3) {
      if (snapshot.availableSlots <= 0) {
        return decision(event, {
          type: 'wait_for_capacity', taskId: event.taskId, subtaskId: event.subtaskId,
        }, 'merge repair is waiting for an attempt slot');
      }
      return decision(event, singleDispatchBatch(
        event,
        event.taskId,
        event.subtaskId,
        event.agentClassName,
        'merge_repair',
        event.sourceAttemptId,
        snapshot.nativeContinuationAgentClasses.includes(event.agentClassName)
          ? 'native_session'
          : 'recovery_packet',
        resourceGrantForSubtask(snapshot, event.subtaskId),
        {
          protocol: 'metaclaw:merge-repair:v1',
          publicationId: event.publicationId,
          conflictChainId: event.conflictChainId,
          conflictingPaths: [...event.conflictingPaths].sort(),
        },
      ), `merge repair ${event.repairAttemptsUsed + 1} of 3 authorized`);
    }
    if (event.conflictReplansUsed < 1) {
      return decision(event, {
        type: 'request_merge_replan',
        taskId: event.taskId,
        subtaskId: event.subtaskId,
        publicationId: event.publicationId,
        conflictChainId: event.conflictChainId,
      }, 'three merge repairs failed; one conflict replan is authorized');
    }
    return decision(event, {
      type: 'park_for_replan', taskId: event.taskId,
    }, 'merge repair and conflict replan budgets are exhausted');
  }
}

function decision(event: KernelEvent, action: KernelDecisionAction, reason: string): KernelDecision {
  return { schemaVersion: 5, id: `decision_${event.id}`, eventId: event.id, action, reason };
}

function snapshotMatches(event: KernelEvent, snapshot: KernelSnapshot): boolean {
  if (event.type === 'plan_proposed') return snapshot.type === 'plan_admission';
  if (event.type === 'executor_recovered') return snapshot.type === 'availability_recovery';
  if (event.type === 'timer_tick') return snapshot.type === 'timer';
  if (event.type === 'recovery_resolution_requested') return snapshot.type === 'recovery';
  if (event.type === 'permission_requested' || event.type === 'permission_resolution_received') return snapshot.type === 'permission';
  if (event.type === 'partition_conflict_observed') return snapshot.type === 'partition';
  if (event.type === 'sandbox_lost') return snapshot.type === 'sandbox_recovery';
  if (
    event.type === 'task_cancel_requested'
    || event.type === 'subtasks_cancel_requested'
    || event.type === 'partial_result_acceptance_requested'
  ) return snapshot.type === 'task_control';
  return snapshot.type === 'dispatch';
}

function isStateChanging(proposal: KernelPlanProposal): boolean {
  return proposal.action === 'plan_work_graph' || (proposal.action === 'task_control' && proposal.task.control !== 'status_query');
}

function unavailableAgentClasses(statuses: KernelExecutorStatusProjection[], occurredAt: string): Set<string> {
  return new Set(statuses
    .filter(status => ['permanently_unavailable', 'temporarily_unavailable'].includes(
      deriveAgentAvailability(status, occurredAt),
    ))
    .map(status => status.agentClassName));
}

function selectDispatchableSubtasks(
  snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
): KernelSubtaskFact[] {
  const activeSubtaskIds = new Set(snapshot.dispatchItems
    .filter(item => isPendingOrActiveDispatch(item.status))
    .map(item => item.subtaskId));
  const conflictingSubtaskIds = new Set(snapshot.resourceConflictSubtaskIds);
  const slotCount = Math.max(0, Math.min(snapshot.availableSlots, snapshot.maxConcurrentAttempts));
  return snapshot.frontier
    .map(id => snapshot.subtasks.find(item => item.id === id && item.status === 'ready'))
    .filter((subtask): subtask is KernelSubtaskFact => Boolean(
      subtask
      && !activeSubtaskIds.has(subtask.id)
      && !conflictingSubtaskIds.has(subtask.id),
    ))
    .slice(0, slotCount);
}

function nextUsableAgentClass(
  subtask: KernelSubtaskFact,
  snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  occurredAt: string,
  attemptedAgentClasses: ReadonlySet<string> = new Set(),
): string | null {
  const unavailable = unavailableAgentClasses(snapshot.executorStatuses, occurredAt);
  return subtask.preferredAgentClassList.find(name =>
    !attemptedAgentClasses.has(name) && !unavailable.has(name)
  ) ?? null;
}

function resourceGrantForSubtask(
  snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  subtaskId: string,
): ResourceClaim[] {
  return snapshot.resourceGrantsBySubtask[subtaskId] ?? [];
}

function dispatchBatchItems(
  event: KernelEvent,
  snapshot: Extract<KernelSnapshot, { type: 'dispatch' }>,
  subtasks: readonly KernelSubtaskFact[],
): Extract<KernelDecisionAction, { type: 'dispatch_batch' }>['items'] {
  const firstOrder = snapshot.dispatchItems.reduce((maximum, item) => Math.max(maximum, item.order), -1) + 1;
  return subtasks.flatMap((subtask, index) => {
    const agentClassName = nextUsableAgentClass(subtask, snapshot, event.occurredAt);
    if (!agentClassName) return [];
    return [{
      subtaskId: subtask.id,
      agentClassName,
      attemptId: deterministicAttemptId(event.id, subtask.id, agentClassName, 'primary'),
      attemptKind: 'primary' as const,
      sourceAttemptId: null,
      recoveryMode: 'fresh' as const,
      defaultResourceGrant: resourceGrantForSubtask(snapshot, subtask.id),
      order: firstOrder + index,
      attemptPayload: null,
    }];
  });
}

function singleDispatchBatch(
  event: KernelEvent,
  taskId: string,
  subtaskId: string,
  agentClassName: string,
  attemptKind: KernelAttemptKind,
  sourceAttemptId: string | null,
  recoveryMode: KernelRecoveryMode,
  defaultResourceGrant: ResourceClaim[],
  attemptPayload: KernelAttemptPayload,
): Extract<KernelDecisionAction, { type: 'dispatch_batch' }> {
  return {
    type: 'dispatch_batch',
    taskId,
    items: [{
      subtaskId,
      agentClassName,
      attemptId: deterministicAttemptId(event.id, subtaskId, agentClassName, attemptKind),
      attemptKind,
      sourceAttemptId,
      recoveryMode,
      defaultResourceGrant,
      order: 0,
      attemptPayload,
    }],
  };
}

function isPendingOrActiveDispatch(status: KernelDispatchItemStatus): boolean {
  return status === 'pending_launch'
    || status === 'launching'
    || status === 'running'
    || status === 'cancelling';
}

function deterministicAttemptId(eventId: string, subtaskId: string, agentClassName: string, kind: string): string {
  return `attempt_${[eventId, subtaskId, agentClassName, kind].map(value => value.replace(/[^a-zA-Z0-9_-]/g, '_')).join('_')}`;
}

function deterministicTaskId(eventId: string): string {
  return `task_${eventId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function generationReplanRequestId(
  taskId: string,
  generationId: string,
  sourceRevision: number,
): string {
  return `generation_replan_${[taskId, generationId, String(sourceRevision)]
    .map(value => value.replace(/[^a-zA-Z0-9_-]/g, '_'))
    .join('_')}`;
}

function addMilliseconds(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + milliseconds).toISOString()
    : value;
}
