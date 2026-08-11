import { describe, expect, it, vi } from 'vitest';
import type { KernelDecisionApplicationRecord, KernelWorkflowStore } from '../../src/kernel/kernel-workflow.js';
import type { KernelEvent } from '../../src/kernel/control-kernel.js';
import { PermissionWorkflowService } from '../../src/execution/permission-workflow-service.js';
import type { NormalizedCapabilityRequest, PermissionRequestRecord } from '../../src/resource/index.js';

describe('PermissionWorkflowService', () => {
  it('pauses the sandbox before checkpointing a permission suspension', async () => {
    const order: string[] = [];
    let normalized: NormalizedCapabilityRequest | null = null;
    let status: PermissionRequestRecord['status'] = 'pending';
    const repository = {
      countDistinctForAttempt: vi.fn().mockReturnValue(0),
      createRequest: vi.fn().mockImplementation((request: NormalizedCapabilityRequest, createdAt: string) => {
        normalized = request;
        return record(request, status, createdAt);
      }),
      findRequest: vi.fn().mockImplementation(() => normalized ? record(normalized, status, '2026-07-23T00:00:00.000Z') : null),
      listGrants: vi.fn().mockReturnValue([]),
      listApprovedFingerprints: vi.fn().mockReturnValue([]),
      listDeniedFingerprints: vi.fn().mockReturnValue([]),
      deny: vi.fn().mockImplementation(() => { status = 'denied'; order.push('deny'); }),
    };
    const service = new PermissionWorkflowService({
      context: context(),
      repository,
      resolver: { resolve: vi.fn().mockReturnValue({ kind: 'logical', namespace: 'test', key: 'resource' }) },
      sandbox: {
        pause: vi.fn().mockImplementation(async () => { order.push('pause'); }),
        inspect: vi.fn().mockResolvedValue({ status: 'paused' }),
        resume: vi.fn().mockImplementation(async () => { order.push('resume'); }),
      },
      workflowStore: inMemoryWorkflowStore(),
      kernel: {
        decide: vi.fn().mockImplementation((event: KernelEvent) => ({
          schemaVersion: 1,
          id: 'decision_deny',
          eventId: event.id,
          reason: 'test denial',
          createdAt: event.occurredAt,
          action: { type: 'deny_capability', requestId: normalized!.id, ruleId: null, authorization: null },
        })),
      },
      rules: [],
      hooks: {
        checkpoint: vi.fn().mockImplementation(async () => { order.push('checkpoint'); return 'checkpoint_1'; }),
        onEscalation: vi.fn(),
        onRecoveryAuthorized: vi.fn(),
      },
      clock: { now: () => '2026-07-23T00:00:00.000Z' },
    } as never);

    await service.request({
      capability: 'logical_resource_operation',
      resource: 'resource',
      operation: 'inspect',
      reason: 'test exact ordering',
      suggestedScope: 'once',
    });

    expect(order).toEqual(['pause', 'checkpoint', 'deny', 'resume']);
  });

  it('returns the persisted grant ID for an already authorized request', async () => {
    let normalized: NormalizedCapabilityRequest | null = null;
    const service = new PermissionWorkflowService({
      context: context(),
      repository: {
        countDistinctForAttempt: vi.fn().mockReturnValue(0),
        createRequest: vi.fn().mockImplementation((request: NormalizedCapabilityRequest, createdAt: string) => {
          normalized = request;
          return record(request, 'granted', createdAt);
        }),
        listGrants: vi.fn().mockImplementation(() => [{
          id: 'grant_1', requestId: normalized!.id, fingerprint: normalized!.fingerprint,
          taskId: 'task_1', subtaskId: 'subtask_1', attemptId: 'attempt_1',
          capability: normalized!.capability, partition: normalized!.partition,
          operation: normalized!.operation, scope: normalized!.suggestedScope,
          limits: { expiresAt: '2026-07-23T00:05:00.000Z', maxCalls: 1, maxBytes: 1024 * 1024 },
          callsUsed: 0, bytesUsed: 0, revokedAt: null,
        }]),
      },
      resolver: { resolve: vi.fn().mockReturnValue({ kind: 'logical', namespace: 'test', key: 'resource' }) },
      clock: { now: () => '2026-07-23T00:00:00.000Z' },
    } as never);

    await expect(service.request({
      capability: 'logical_resource_operation', resource: 'resource', operation: 'inspect',
      reason: 'reuse exact authorization', suggestedScope: 'once',
    })).resolves.toMatchObject({ status: 'granted', grantId: 'grant_1' });
  });

  it('resumes a paused sandbox when checkpoint creation fails', async () => {
    const order: string[] = [];
    let normalized: NormalizedCapabilityRequest | null = null;
    const service = new PermissionWorkflowService({
      context: context(),
      repository: {
        countDistinctForAttempt: vi.fn().mockReturnValue(0),
        createRequest: vi.fn().mockImplementation((request: NormalizedCapabilityRequest, createdAt: string) => {
          normalized = request;
          return record(request, 'pending', createdAt);
        }),
      },
      resolver: { resolve: vi.fn().mockReturnValue({ kind: 'logical', namespace: 'test', key: 'resource' }) },
      sandbox: {
        pause: vi.fn().mockImplementation(async () => { order.push('pause'); }),
        inspect: vi.fn().mockResolvedValue({ status: 'paused' }),
        resume: vi.fn().mockImplementation(async () => { order.push('resume'); }),
      },
      hooks: {
        checkpoint: vi.fn().mockImplementation(async () => { order.push('checkpoint'); throw new Error('checkpoint failed'); }),
      },
      clock: { now: () => '2026-07-23T00:00:00.000Z' },
    } as never);

    await expect(service.request({
      capability: 'logical_resource_operation', resource: 'resource', operation: 'inspect',
      reason: 'test checkpoint rollback', suggestedScope: 'once',
    })).rejects.toThrow('checkpoint failed');
    expect(normalized).not.toBeNull();
    expect(order).toEqual(['pause', 'checkpoint', 'resume']);
  });

  it('atomically consumes a grant using the Runtime-measured UTF-8 payload size', () => {
    const consumeGrant = vi.fn().mockReturnValue({
      id: 'grant_1', requestId: 'request_1', fingerprint: 'fingerprint', taskId: 'task_1',
      subtaskId: 'subtask_1', attemptId: 'attempt_1', capability: 'external_object_operation',
      partition: { kind: 'logical', namespace: 'test', key: 'resource' }, operation: 'update', scope: 'once',
      limits: { expiresAt: '2026-07-23T00:05:00.000Z', maxCalls: 1, maxBytes: 1024 * 1024 },
      callsUsed: 1, bytesUsed: 2, revokedAt: null,
    });
    const service = new PermissionWorkflowService({
      context: context(),
      repository: { consumeGrant },
      clock: { now: () => '2026-07-23T00:00:01.000Z' },
    } as never);

    expect(service.use({ grantId: 'grant_1', payload: '\u03c0' })).toMatchObject({
      status: 'consumed', grantId: 'grant_1', callsUsed: 1, bytesUsed: 2,
      remainingCalls: 0, remainingBytes: 1024 * 1024 - 2,
    });
    expect(consumeGrant).toHaveBeenCalledWith(
      'grant_1', 'attempt_1', 2, '2026-07-23T00:00:01.000Z',
    );
  });

  it('fails a capability use closed when TTL or call/byte budgets reject consumption', () => {
    const service = new PermissionWorkflowService({
      context: context(),
      repository: { consumeGrant: vi.fn().mockReturnValue(null) },
      clock: { now: () => '2026-07-23T00:10:00.000Z' },
    } as never);

    expect(service.use({ grantId: 'grant_expired', payload: 'effect' })).toEqual({
      status: 'denied',
      grantId: 'grant_expired',
      reason: 'grant is expired, exhausted, revoked, or belongs to another attempt',
    });
  });
});

function context() {
  return {
    sessionId: 'session_1', taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
    attemptId: 'attempt_1', agentClassName: 'codex-cli', permissionProfileId: 'workspace-engineering' as const,
    runtimeHandle: 'worktree:attempt_1', workspaceId: 'workspace_1', checkpointId: null,
  };
}

function record(
  request: NormalizedCapabilityRequest,
  status: PermissionRequestRecord['status'],
  createdAt: string,
): PermissionRequestRecord {
  return {
    request, status, decisionId: status === 'pending' ? null : 'decision_deny',
    decisionReason: status === 'denied' ? 'test denial' : null,
    createdAt, resolvedAt: status === 'pending' ? null : createdAt,
  };
}

function inMemoryWorkflowStore(): KernelWorkflowStore {
  let event: KernelEvent | null = null;
  let application: KernelDecisionApplicationRecord | null = null;
  return {
    enqueue(next) { event ??= next; return true; },
    claimNext() { const next = event; event = null; return next; },
    issue(_eventId, decision) {
      application = {
        id: 'application_1', decisionId: decision.id, eventId: decision.eventId,
        idempotencyKey: 'decision:' + decision.id, status: 'pending', applyAttempts: 0,
        observationEvent: null, errorSummary: null, createdAt: decision.createdAt,
        updatedAt: decision.createdAt, decision: decision.decision,
      };
      return application;
    },
    listRecoverableApplications() {
      return application && (application.status === 'pending' || application.status === 'applying') ? [application] : [];
    },
    markApplying() {
      if (!application) throw new Error('missing application');
      application = { ...application, status: 'applying', applyAttempts: application.applyAttempts + 1 };
      return application;
    },
    markApplied(_decisionId, observation) {
      if (!application) throw new Error('missing application');
      application = { ...application, status: 'applied', observationEvent: observation };
      if (observation) event = observation;
    },
    markApplicationFailed() {}, reconcileProcessing() { return 0; },
    countByApplicationStatus() {
      const counts = { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 };
      if (application) counts[application.status] += 1;
      return counts;
    },
  };
}
