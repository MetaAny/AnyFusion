import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelDecision, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import {
  DurableKernelWorkflow,
  type KernelDecisionApplicationRecord,
  type KernelWorkflowStore,
} from '../../src/kernel/kernel-workflow.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import type { KernelDecisionLedgerRecord } from '../../src/kernel/kernel-workflow.js';

describe('DurableKernelWorkflow', () => {
  it('persists input, issuance, and application before apply', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const workflow = createWorkflow(store, order);

    const result = await workflow.submit(directReplyEvent());

    expect(result.decisions).toHaveLength(1);
    expect(order).toEqual(['enqueue:event_1', 'issue:event_1', 'applying:decision_event_1', 'apply:decision_event_1', 'applied:decision_event_1']);
    expect(store.application?.status).toBe('applied');
  });

  it('resumes an existing pending application for a duplicate event without issuing twice', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    store.enqueue(event);
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);
    store.issue(event.id, ledgerRecord(event, snapshot, decision));
    order.length = 0;
    const workflow = createWorkflow(store, order);

    const result = await workflow.submit(event);

    expect(result.decisions).toEqual([decision]);
    expect(order).toEqual(['enqueue:event_1', 'applying:decision_event_1', 'apply:decision_event_1', 'applied:decision_event_1']);
    expect(store.issueCount).toBe(1);
  });

  it('does not steal an application that another nested workflow is currently applying', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    store.enqueue(event);
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);
    store.issue(event.id, ledgerRecord(event, snapshot, decision));
    store.markApplying(decision.id, event.occurredAt);
    order.length = 0;

    const result = await createWorkflow(store, order).submit(event);

    expect(result.decisions).toEqual([]);
    expect(order).toEqual(['enqueue:event_1']);
    expect(store.application?.status).toBe('applying');
  });

  it('requeues interrupted applying work only during explicit recovery', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    store.enqueue(event);
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);
    store.issue(event.id, ledgerRecord(event, snapshot, decision));
    store.markApplying(decision.id, event.occurredAt);
    order.length = 0;

    const result = await createWorkflow(store, order).recover();

    expect(result.decisions).toEqual([decision]);
    expect(order).toEqual(['applying:decision_event_1', 'apply:decision_event_1', 'applied:decision_event_1']);
    expect(store.application?.status).toBe('applied');
  });
});

function createWorkflow(store: MemoryWorkflowStore, order: string[]): DurableKernelWorkflow {
  store.onOperation = value => order.push(value);
  return new DurableKernelWorkflow({
    kernel: new ControlKernel(),
    store,
    clock: { now: () => '2026-07-21T00:00:00.000Z' },
    buildSnapshot: () => planSnapshot(),
    runtime: {
      async apply(decision) {
        order.push(`apply:${decision.id}`);
        return null;
      },
    },
  });
}

class MemoryWorkflowStore implements KernelWorkflowStore {
  event: KernelEvent | null = null;
  eventStatus: 'pending' | 'processing' | 'processed' | 'dead_letter' | null = null;
  ledger: KernelDecisionLedgerRecord | null = null;
  application: KernelDecisionApplicationRecord | null = null;
  issueCount = 0;
  onOperation: (value: string) => void = () => undefined;

  enqueue(event: KernelEvent): boolean {
    this.onOperation(`enqueue:${event.id}`);
    if (this.event) return false;
    this.event = event;
    this.eventStatus = 'pending';
    return true;
  }

  claimNext(): KernelEvent | null {
    if (this.eventStatus !== 'pending') return null;
    this.eventStatus = 'processing';
    return this.event;
  }

  issue(eventId: string, record: KernelDecisionLedgerRecord): KernelDecisionApplicationRecord {
    this.onOperation(`issue:${eventId}`);
    this.issueCount += 1;
    this.ledger = record;
    this.eventStatus = 'processed';
    this.application = {
      id: `application_${record.id}`,
      decisionId: record.id,
      eventId,
      idempotencyKey: `decision:${record.id}`,
      status: 'pending',
      applyAttempts: 0,
      observationEvent: null,
      errorSummary: null,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      decision: record.decision,
    };
    return this.application;
  }

  listRecoverableApplications(): KernelDecisionApplicationRecord[] {
    return this.application?.status === 'pending' ? [this.application] : [];
  }

  markApplying(decisionId: string, now: string): KernelDecisionApplicationRecord {
    this.onOperation(`applying:${decisionId}`);
    this.application = { ...this.application!, status: 'applying', applyAttempts: this.application!.applyAttempts + 1, updatedAt: now };
    return this.application;
  }

  markApplied(decisionId: string, observation: KernelEvent | null, now: string): void {
    this.onOperation(`applied:${decisionId}`);
    this.application = { ...this.application!, status: 'applied', observationEvent: observation, updatedAt: now };
    if (observation) {
      this.event = observation;
      this.eventStatus = 'pending';
    }
  }

  markApplicationFailed(decisionId: string, status: 'uncertain' | 'failed', errorSummary: string, now: string): void {
    this.application = { ...this.application!, status, errorSummary, updatedAt: now };
  }

  reconcileProcessing(): number {
    let reconciled = 0;
    if (this.eventStatus === 'processing') {
      this.eventStatus = this.ledger ? 'processed' : 'pending';
      reconciled += 1;
    }
    if (this.application?.status === 'applying') {
      this.application = { ...this.application, status: 'pending' };
      reconciled += 1;
    }
    return reconciled;
  }

  countByApplicationStatus(): Record<'pending' | 'applying' | 'applied' | 'uncertain' | 'failed', number> {
    const result = { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 };
    if (this.application) result[this.application.status] += 1;
    return result;
  }
}

function directReplyEvent(): KernelEvent {
  return {
    schemaVersion: 5,
    type: 'plan_proposed',
    id: 'event_1',
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z',
    sessionId: 'session_1',
    requestText: 'done',
    generationId: 'generation_event_1',
    proposalSource: 'initial',
    targetGraphRevision: 1,
    proposal: {
      id: 'plan_1', schemaVersion: 7, action: 'direct_reply', confidence: 1, reason: 'answer',
      clarificationQuestion: null, response: { directReply: 'done' },
      task: { binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null, includeRecentConversationContext: false, priority: null },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] }, authorizationResolution: null, workGraph: null, source: 'anyfusion-planner',
    },
  };
}

function planSnapshot(): KernelSnapshot {
  return {
    schemaVersion: 5, type: 'plan_admission', tasks: [], runningTaskId: null,
    executorCatalog: getPlannerExecutorCatalog(), executorStatuses: [], v5WorkGraphTaskIds: [], eligibleContextRefKeys: [], pendingAuthorizationRequest: null,
  };
}

function ledgerRecord(event: KernelEvent, snapshot: KernelSnapshot, decision: KernelDecision): KernelDecisionLedgerRecord {
  return {
    id: decision.id, schemaVersion: 5, eventId: event.id, eventType: event.type,
    correlationId: event.correlationId, causationId: event.causationId, sessionId: event.sessionId,
    taskId: null, subtaskId: null, attemptId: null, event, snapshot, decision,
    action: decision.action.type, reason: decision.reason, createdAt: event.occurredAt,
  };
}
