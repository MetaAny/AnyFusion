import { randomUUID } from 'node:crypto';
import type { AttemptSandboxPort } from './attempt-sandbox.js';
import type { CapabilityResourceResolverPort } from './capability-resource-resolver.js';
import {
  capabilityRequestFingerprint,
  type CapabilityRequestInput,
  type CapabilityUseInput,
  type CapabilityUseResult,
  type NormalizedCapabilityRequest,
  type PermissionRequestRecord,
  type PermissionRepositoryPort,
  type PermissionRule,
} from '../resource/index.js';
import {
  ControlKernel,
  type KernelDecision,
  type KernelEvent,
  type KernelSnapshot,
} from '../kernel/control-kernel.js';
import { DurableKernelWorkflow, type KernelWorkflowStore } from '../kernel/kernel-workflow.js';

export interface PermissionAttemptContext {
  sessionId: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  agentClassName: string;
  permissionProfileId: NormalizedCapabilityRequest['permissionProfileId'];
  containerId: string;
  workspaceId: string;
  checkpointId: string | null;
}

export interface PermissionWorkflowHooks {
  checkpoint(reason: 'permission_suspended'): Promise<string | null>;
  onEscalation(request: NormalizedCapabilityRequest, reason: string): Promise<void>;
  onRecoveryAuthorized(input: { request: NormalizedCapabilityRequest | null; workspaceId: string; checkpointId: string | null }): Promise<void>;
}

export const PERMISSION_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function permissionRequestExpiresAt(createdAt: string): string | null {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return new Date(createdAtMs + PERMISSION_REQUEST_MAX_AGE_MS).toISOString();
}

export function isPermissionRequestActive(createdAt: string, now: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - createdAtMs;
  return ageMs >= 0 && ageMs <= PERMISSION_REQUEST_MAX_AGE_MS;
}

export class PermissionWorkflowService {
  constructor(private readonly deps: {
    context: PermissionAttemptContext;
    repository: PermissionRepositoryPort;
    resolver: CapabilityResourceResolverPort;
    sandbox: AttemptSandboxPort;
    workflowStore: KernelWorkflowStore;
    kernel?: ControlKernel;
    rules: PermissionRule[];
    hooks: PermissionWorkflowHooks;
    clock?: { now(): string };
  }) {}

  async request(input: CapabilityRequestInput): Promise<{
    requestId: string;
    grantId: string | null;
    status: string;
    reason: string | null;
  }> {
    const now = this.now();
    const ordinal = this.deps.repository.countDistinctForAttempt(this.deps.context.attemptId) + 1;
    const request: NormalizedCapabilityRequest = {
      ...input,
      id: `permission_request_${randomUUID()}`,
      fingerprint: '',
      taskId: this.deps.context.taskId,
      generationId: this.deps.context.generationId,
      subtaskId: this.deps.context.subtaskId,
      attemptId: this.deps.context.attemptId,
      agentClassName: this.deps.context.agentClassName,
      permissionProfileId: this.deps.context.permissionProfileId,
      partition: this.deps.resolver.resolve(input),
      distinctRequestOrdinal: ordinal,
    };
    request.fingerprint = capabilityRequestFingerprint(request);
    const record = this.deps.repository.createRequest(request, now);
    if (record.status !== 'pending') return this.requestResult(record);
    await this.deps.sandbox.pause(this.deps.context.containerId);
    try {
      const checkpointId = await this.deps.hooks.checkpoint('permission_suspended');
      this.deps.context.checkpointId = checkpointId;
    } catch (error) {
      await this.resumeIfPresent().catch(() => undefined);
      throw error;
    }
    const event: Extract<KernelEvent, { type: 'permission_requested' }> = {
      schemaVersion: 5,
      type: 'permission_requested',
      id: `permission_event_${record.request.id}`,
      correlationId: record.request.id,
      causationId: null,
      occurredAt: now,
      sessionId: this.deps.context.sessionId,
      taskId: record.request.taskId,
      subtaskId: record.request.subtaskId,
      attemptId: record.request.attemptId,
      request: record.request,
    };
    const result = await this.workflow().submit(event);
    const latest = this.deps.repository.findRequest(record.request.id);
    if (latest) return this.requestResult(latest);
    return {
      requestId: record.request.id,
      grantId: null,
      status: result.pendingRecovery > 0 ? 'uncertain' : 'pending',
      reason: null,
    };
  }

  use(input: CapabilityUseInput): CapabilityUseResult {
    const bytes = Buffer.byteLength(input.payload, 'utf8');
    const grant = this.deps.repository.consumeGrant(
      input.grantId,
      this.deps.context.attemptId,
      bytes,
      this.now(),
    );
    if (!grant) {
      return {
        status: 'denied',
        grantId: input.grantId,
        reason: 'grant is expired, exhausted, revoked, or belongs to another attempt',
      };
    }
    return {
      status: 'consumed',
      grantId: grant.id,
      callsUsed: grant.callsUsed,
      bytesUsed: grant.bytesUsed,
      remainingCalls: grant.limits.maxCalls - grant.callsUsed,
      remainingBytes: grant.limits.maxBytes - grant.bytesUsed,
      expiresAt: grant.limits.expiresAt,
    };
  }

  async resolve(input: {
    requestId: string;
    resolution: 'approve' | 'deny';
    source: 'command' | 'button' | 'planner';
    plannerPlanId?: string | null;
  }): Promise<void> {
    const record = this.deps.repository.findRequest(input.requestId);
    if (!record || record.request.taskId !== this.deps.context.taskId || !['pending', 'escalated'].includes(record.status)) {
      throw new Error('permission request is missing, stale, or belongs to another Task');
    }
    if (!isPermissionRequestActive(record.createdAt, this.now())) {
      throw new Error('permission request has expired and must be reissued precisely');
    }
    await this.workflow().submit({
      schemaVersion: 5,
      type: 'permission_resolution_received',
      id: `permission_resolution_${input.requestId}_${input.resolution}`,
      correlationId: input.requestId,
      causationId: null,
      occurredAt: this.now(),
      sessionId: this.deps.context.sessionId,
      taskId: record.request.taskId,
      subtaskId: record.request.subtaskId,
      attemptId: record.request.attemptId,
      requestId: input.requestId,
      resolution: input.resolution,
      source: input.source,
      plannerPlanId: input.plannerPlanId ?? null,
    });
  }

  private workflow(): DurableKernelWorkflow {
    return new DurableKernelWorkflow({
      kernel: this.deps.kernel ?? new ControlKernel(),
      buildSnapshot: event => this.buildSnapshot(event),
      store: this.deps.workflowStore,
      clock: { now: () => this.now() },
      runtime: { apply: decision => this.apply(decision) },
      acceptedEventTypes: ['permission_requested', 'permission_resolution_received'],
      acceptedActions: ['grant_capability', 'deny_capability', 'escalate_capability', 'recover_workspace_attempt'],
      taskId: this.deps.context.taskId,
    });
  }

  private buildSnapshot(event: KernelEvent): KernelSnapshot {
    const requestId = event.type === 'permission_requested'
      ? event.request.id
      : event.type === 'permission_resolution_received' ? event.requestId : '';
    const record = this.deps.repository.findRequest(requestId);
    return {
      schemaVersion: 5,
      type: 'permission',
      request: record?.request ?? null,
      requestStatus: record?.status === 'escalated' ? 'pending' : record?.status ?? null,
      rules: this.deps.rules,
      currentGrants: record ? this.deps.repository.listGrants(record.request.attemptId) : [],
      userAuthorizationFingerprints: record ? this.deps.repository.listApprovedFingerprints(record.request.taskId) : [],
      previouslyDeniedFingerprints: record ? this.deps.repository.listDeniedFingerprints(record.request.attemptId) : [],
      attemptActive: false,
      workspaceId: this.deps.context.workspaceId,
      checkpointId: this.deps.context.checkpointId,
    };
  }

  private async apply(decision: KernelDecision): Promise<KernelEvent | null> {
    const action = decision.action;
    if (
      action.type !== 'grant_capability'
      && action.type !== 'deny_capability'
      && action.type !== 'escalate_capability'
      && action.type !== 'recover_workspace_attempt'
    ) {
      throw new Error(`permission workflow cannot apply ${action.type}`);
    }
    if (action.type === 'recover_workspace_attempt') {
      const record = action.requestId ? this.deps.repository.findRequest(action.requestId) : null;
      if (record && action.authorization) {
        this.deps.repository.recordAuthorization(record.request, action.authorization, this.now());
      }
      await this.deps.hooks.onRecoveryAuthorized({
        request: record?.request ?? null,
        workspaceId: action.workspaceId,
        checkpointId: action.checkpointId,
      });
      return null;
    }
    const record = this.deps.repository.findRequest(action.requestId);
    if (!record) throw new Error(`permission request not found: ${action.requestId}`);
    if (action.type === 'grant_capability') {
      this.deps.repository.grant({
        decisionId: decision.id,
        request: record.request,
        limits: action.limits,
        grantedAt: this.now(),
        authorization: action.authorization ?? undefined,
      });
      await this.resumeIfPresent();
      return null;
    }
    if (action.type === 'deny_capability') {
      this.deps.repository.deny({
        decisionId: decision.id,
        request: record.request,
        reason: decision.reason,
        deniedAt: this.now(),
        authorization: action.authorization ?? undefined,
      });
      await this.resumeIfPresent();
      return null;
    }
    this.deps.repository.escalate(record.request.id, decision.id, decision.reason, this.now());
    await this.deps.hooks.onEscalation(record.request, decision.reason);
    return null;
  }

  private async resumeIfPresent(): Promise<void> {
    const sandbox = await this.deps.sandbox.inspect(this.deps.context.containerId);
    if (sandbox?.status === 'paused') await this.deps.sandbox.resume(this.deps.context.containerId);
  }

  private requestResult(record: PermissionRequestRecord): {
    requestId: string;
    grantId: string | null;
    status: string;
    reason: string | null;
  } {
    const grant = record.status === 'granted'
      ? this.deps.repository.listGrants(record.request.attemptId)
        .find(item => item.requestId === record.request.id) ?? null
      : null;
    return {
      requestId: record.request.id,
      grantId: grant?.id ?? null,
      status: record.status,
      reason: record.decisionReason,
    };
  }

  private now(): string {
    return this.deps.clock?.now() ?? new Date().toISOString();
  }
}
