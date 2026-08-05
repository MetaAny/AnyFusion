import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AttemptTerminalService } from '../../src/execution/attempt-terminal-service.js';
import type { KernelEvent } from '../../src/kernel/control-kernel.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorAttemptReceiptRepo } from '../../src/storage/executor-attempt-receipt-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import type { Subtask } from '../../src/core/types.js';
import { getBuiltinExecutorAgentClasses } from '../../src/executor/builtin-executor-catalog.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db);
  const now = '2026-07-28T00:00:00.000Z';
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES (
      'task-terminal', 'Terminal', 'Land terminal facts', 'running', '', '[]', '[]', '[]',
      '[]', '{}', '[]', '', '', 0, ?, ?
    )
  `).run(now, now);
  const subtask: Subtask = {
    id: 'subtask-terminal',
    taskId: 'task-terminal',
    graphRevision: 1,
    generationId: 'generation-terminal',
    title: 'Terminal',
    goal: 'Land terminal facts',
    status: 'running',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'low',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  const subtasks = new SubtaskRepo(db);
  subtasks.upsert(subtask);
  new AgentClassRepo(db).upsert(
    getBuiltinExecutorAgentClasses().find(item => item.name === 'codex-cli')!,
  );
  new WorkUnitRepo(db).upsert({
    id: 'work-unit-terminal',
    agentClassName: 'codex-cli',
    agentClassKind: 'executor',
    state: 'running',
    claimedTaskId: 'task-terminal',
    claimedSubtaskId: 'subtask-terminal',
    claimedAttemptId: 'attempt-terminal',
    heartbeatAt: now,
    leaseExpiresAt: now,
    createdAt: now,
    updatedAt: now,
  });
  db.prepare(`
    INSERT INTO kernel_dispatch_items (
      attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
      agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
      attempt_payload_json, resource_grant_json, status, launch_started_at,
      created_at, updated_at
    ) VALUES (
      'attempt-terminal', 'decision-terminal', 0, 'task-terminal', 'generation-terminal',
      'subtask-terminal', 'codex-cli', 'primary', NULL, 'fresh', 'null', '[]',
      'running', ?, ?, ?
    )
  `).run(now, now, now);
  return {
    db,
    now,
    service: new AttemptTerminalService(db),
    tasks: new TaskRepo(db),
    subtasks,
    dispatch: new KernelDispatchItemRepo(db),
    receipts: new ExecutorAttemptReceiptRepo(db),
    workflow: new KernelWorkflowRepo(db),
    publications: new WorkspacePublicationRepo(db),
  };
}

function outcomeEvent(now: string): KernelEvent {
  return {
    schemaVersion: 5,
    type: 'execution_outcome',
    id: 'event_attempt-terminal_execution_outcome',
    correlationId: 'decision-terminal',
    causationId: 'decision-terminal',
    occurredAt: now,
    sessionId: 'session-terminal',
    taskId: 'task-terminal',
    subtaskId: 'subtask-terminal',
    attemptId: 'attempt-terminal',
    terminalKind: 'failed',
    agentClassName: 'codex-cli',
    attemptKind: 'primary',
    sourceAttemptId: null,
    failure: {
      kind: 'infrastructure',
      scope: 'attempt',
      code: 'executor_failed',
      summary: 'executor failed',
    },
  };
}

describe('AttemptTerminalService', () => {
  it('rolls back receipt, Subtask, dispatch and outcome inbox together when landing fails', () => {
    const setupResult = setup();
    setupResult.db.exec(`
      CREATE TRIGGER reject_terminal_outcome
      BEFORE INSERT ON kernel_events
      WHEN NEW.id = 'event_attempt-terminal_execution_outcome'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal inbox failure');
      END
    `);

    expect(() => setupResult.service.land({
      receipt: {
        attemptId: 'attempt-terminal',
        executionId: 'execution-terminal',
        taskId: 'task-terminal',
        subtaskId: 'subtask-terminal',
        workUnitId: 'work-unit-terminal',
        agentClassName: 'codex-cli',
        startedAt: setupResult.now,
        completedAt: setupResult.now,
        terminalState: 'executor_failed',
        rawResponse: '',
        completionSchemaVersion: null,
        parsing: {},
        verification: { warnings: [], violations: [] },
        errorCode: 'executor_failed',
        errorDetail: 'executor failed',
        failure: outcomeEvent(setupResult.now).type === 'execution_outcome'
          ? outcomeEvent(setupResult.now).failure
          : null,
      },
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: 'executor failed',
      event: outcomeEvent(setupResult.now),
      now: setupResult.now,
    })).toThrow('injected terminal inbox failure');

    expect(setupResult.tasks.findById('task-terminal')?.status).toBe('running');
    expect(setupResult.subtasks.findById('subtask-terminal')?.status).toBe('running');
    expect(setupResult.dispatch.find('attempt-terminal')?.status).toBe('running');
    expect(setupResult.receipts.findByAttemptId('attempt-terminal')).toBeNull();
    expect(setupResult.workflow.findEvent('event_attempt-terminal_execution_outcome')).toBeNull();
  });

  it('resolves a reconciled uncertain dispatch when its immutable terminal facts are known', () => {
    const setupResult = setup();
    setupResult.dispatch.markUncertain(
      'attempt-terminal',
      'controller restarted after receipt',
      setupResult.now,
    );

    setupResult.service.land({
      receipt: {
        attemptId: 'attempt-terminal',
        executionId: 'execution-terminal',
        taskId: 'task-terminal',
        subtaskId: 'subtask-terminal',
        workUnitId: 'work-unit-terminal',
        agentClassName: 'codex-cli',
        startedAt: setupResult.now,
        completedAt: setupResult.now,
        terminalState: 'executor_failed',
        rawResponse: '',
        completionSchemaVersion: null,
        parsing: {},
        verification: { warnings: [], violations: [] },
        errorCode: 'executor_failed',
        errorDetail: 'executor failed',
        failure: outcomeEvent(setupResult.now).type === 'execution_outcome'
          ? outcomeEvent(setupResult.now).failure
          : null,
      },
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: 'executor failed',
      event: outcomeEvent(setupResult.now),
      now: setupResult.now,
    });

    expect(setupResult.dispatch.find('attempt-terminal')?.status).toBe('terminal');
    expect(setupResult.receipts.findByAttemptId('attempt-terminal')).not.toBeNull();
    expect(setupResult.workflow.findEvent('event_attempt-terminal_execution_outcome')).not.toBeNull();
  });

  it('lands a repaired candidate with the merge-repair terminal facts', () => {
    const setupResult = setup();
    setupResult.publications.insertCandidate({
      id: 'publication-terminal',
      taskId: 'task-terminal',
      generationId: 'generation-terminal',
      subtaskId: 'subtask-terminal',
      sourceAttemptId: 'attempt-source',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate-before-repair',
      completion: {} as never,
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: setupResult.now,
    });
    setupResult.db.prepare(`
      UPDATE workspace_publications
      SET status = 'conflicted'
      WHERE id = 'publication-terminal'
    `).run();

    setupResult.service.land({
      receipt: {
        attemptId: 'attempt-terminal',
        executionId: 'execution-terminal',
        taskId: 'task-terminal',
        subtaskId: 'subtask-terminal',
        workUnitId: 'work-unit-terminal',
        agentClassName: 'codex-cli',
        startedAt: setupResult.now,
        completedAt: setupResult.now,
        terminalState: 'completed',
        rawResponse: '{"protocol":"metaclaw:merge-repair:v1"}',
        completionSchemaVersion: null,
        parsing: {},
        verification: { warnings: [], violations: [] },
        errorCode: null,
        errorDetail: null,
        failure: null,
      },
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_integration',
      subtaskError: null,
      repairPublication: {
        publicationId: 'publication-terminal',
        candidateCommit: 'candidate-after-repair',
      },
      event: {
        ...outcomeEvent(setupResult.now),
        terminalKind: 'completed',
        failure: undefined,
      },
      now: setupResult.now,
    });

    expect(setupResult.db.prepare(`
      SELECT status, candidate_commit FROM workspace_publications
      WHERE id = 'publication-terminal'
    `).get()).toEqual({
      status: 'pending',
      candidate_commit: 'candidate-after-repair',
    });
    expect(setupResult.subtasks.findById('subtask-terminal')?.status).toBe('awaiting_integration');
    expect(setupResult.dispatch.find('attempt-terminal')?.status).toBe('terminal');
  });

  it('rolls back a merge-repair publication update with the rest of terminal landing', () => {
    const setupResult = setup();
    setupResult.publications.insertCandidate({
      id: 'publication-terminal',
      taskId: 'task-terminal',
      generationId: 'generation-terminal',
      subtaskId: 'subtask-terminal',
      sourceAttemptId: 'attempt-source',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate-before-repair',
      completion: {} as never,
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: setupResult.now,
    });
    setupResult.db.prepare(`
      UPDATE workspace_publications
      SET status = 'conflicted'
      WHERE id = 'publication-terminal'
    `).run();
    setupResult.db.exec(`
      CREATE TRIGGER reject_merge_repair_outcome
      BEFORE INSERT ON kernel_events
      WHEN NEW.id = 'event_attempt-terminal_execution_outcome'
      BEGIN
        SELECT RAISE(ABORT, 'injected merge repair inbox failure');
      END
    `);

    expect(() => setupResult.service.land({
      receipt: {
        attemptId: 'attempt-terminal',
        executionId: 'execution-terminal',
        taskId: 'task-terminal',
        subtaskId: 'subtask-terminal',
        workUnitId: 'work-unit-terminal',
        agentClassName: 'codex-cli',
        startedAt: setupResult.now,
        completedAt: setupResult.now,
        terminalState: 'completed',
        rawResponse: '{"protocol":"metaclaw:merge-repair:v1"}',
        completionSchemaVersion: null,
        parsing: {},
        verification: { warnings: [], violations: [] },
        errorCode: null,
        errorDetail: null,
        failure: null,
      },
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_integration',
      subtaskError: null,
      repairPublication: {
        publicationId: 'publication-terminal',
        candidateCommit: 'candidate-after-repair',
      },
      event: {
        ...outcomeEvent(setupResult.now),
        terminalKind: 'completed',
        failure: undefined,
      },
      now: setupResult.now,
    })).toThrow('injected merge repair inbox failure');

    expect(setupResult.subtasks.findById('subtask-terminal')?.status).toBe('running');
    expect(setupResult.dispatch.find('attempt-terminal')?.status).toBe('running');
    expect(setupResult.receipts.findByAttemptId('attempt-terminal')).toBeNull();
    expect(setupResult.db.prepare(`
      SELECT status, candidate_commit AS candidateCommit
      FROM workspace_publications
      WHERE id = 'publication-terminal'
    `).get()).toMatchObject({
      status: 'conflicted',
      candidateCommit: 'candidate-before-repair',
    });
  });
});
