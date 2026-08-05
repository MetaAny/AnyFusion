import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

describe('KernelWorkflowRepo', () => {
  it('atomically advances an event to an immutable Decision and pending application', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelWorkflowRepo(db);
    const event = directReplyEvent();
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);

    expect(repo.enqueue(event)).toBe(true);
    expect(repo.findEvent(event.id)).toEqual(event);
    expect(repo.claimNext(event.occurredAt)).toEqual(event);
    const application = repo.issue(event.id, {
      id: decision.id, schemaVersion: 5, eventId: event.id, eventType: event.type,
      correlationId: event.correlationId, causationId: null, sessionId: event.sessionId,
      taskId: null, subtaskId: null, attemptId: null, event, snapshot, decision,
      action: decision.action.type, reason: decision.reason, createdAt: event.occurredAt,
    });

    expect(application).toMatchObject({
      decisionId: decision.id,
      eventId: event.id,
      status: 'pending',
      decision,
    });
    expect(db.prepare('SELECT status FROM kernel_events WHERE id = ?').get(event.id)).toEqual({ status: 'processed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM kernel_decisions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM kernel_decision_applications').get()).toEqual({ count: 1 });
    expect(repo.hasRecoverableWork('task_1')).toBe(false);
    expect(repo.enqueue({
      ...event,
      id: 'event_task_1',
      type: 'dispatch_requested',
      taskId: 'task_1',
      reason: 'durable recovery remains pending',
    })).toBe(true);
    expect(repo.hasRecoverableWork('task_1')).toBe(true);
  });

  it('stores the stable observation while completing apply and makes it drainable once', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelWorkflowRepo(db);
    const event = directReplyEvent();
    const snapshot = planSnapshot();
    const decision = new ControlKernel().decide(event, snapshot);
    repo.enqueue(event);
    repo.claimNext(event.occurredAt);
    repo.issue(event.id, {
      id: decision.id, schemaVersion: 5, eventId: event.id, eventType: event.type,
      correlationId: event.correlationId, causationId: null, sessionId: event.sessionId,
      taskId: null, subtaskId: null, attemptId: null, event, snapshot, decision,
      action: decision.action.type, reason: decision.reason, createdAt: event.occurredAt,
    });
    repo.markApplying(decision.id, event.occurredAt);
    const observation: KernelEvent = {
      ...event,
      id: 'event_observation_1',
      type: 'dispatch_requested',
      taskId: 'task_1',
      reason: 'authorized plan applied',
      causationId: decision.id,
    };

    repo.markApplied(decision.id, observation, event.occurredAt);

    expect(repo.listRecoverableApplications()).toEqual([]);
    expect(repo.claimNext(event.occurredAt)).toEqual(observation);
    expect(repo.claimNext(event.occurredAt)).toBeNull();
  });

  it('fails closed without claiming an event outside the unique v4 contract', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelWorkflowRepo(db);
    const event = directReplyEvent();
    repo.enqueue(event);
    db.prepare(`
      UPDATE kernel_events
      SET schema_version = 3,
          event_json = json_set(event_json, '$.schemaVersion', 3)
      WHERE id = ?
    `).run(event.id);

    expect(() => repo.claimNext(event.occurredAt))
      .toThrow('unsupported Kernel event schema version 3');
    expect(db.prepare('SELECT status FROM kernel_events WHERE id = ?').get(event.id))
      .toEqual({ status: 'pending' });
  });
});

function directReplyEvent(): KernelEvent {
  return {
    schemaVersion: 5, type: 'plan_proposed', id: 'event_1', correlationId: 'correlation_1', causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z', sessionId: 'session_1',
    requestText: 'done',
    generationId: 'generation_event_1', proposalSource: 'initial', targetGraphRevision: 1,
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
