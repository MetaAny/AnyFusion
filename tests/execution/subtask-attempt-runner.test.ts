import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { SubtaskAttemptRunner } from '../../src/execution/subtask-attempt-runner.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';
import { getBuiltinExecutorAgentClasses } from '../../src/executor/builtin-executor-catalog.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import type { Subtask } from '../../src/core/types.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { SqliteWorkspaceRepository } from '../../src/storage/workspace-repo.js';
import { buildDefaultResourceClaims } from '../../src/resource/index.js';
import type { AttemptSandboxPort } from '../../src/execution/attempt-sandbox.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';

function node(id: string, dependencies: Subtask['dependencies'] = []): Subtask {
  return {
    id, taskId: 'task_phase2', graphRevision: 1, generationId: 'generation_phase2',
    title: id, goal: `complete ${id}`, status: 'ready',
    dependencies, contextRefs: [], requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'], deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function setup(rawResponse: string) {
  const db = new Database(':memory:');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
  `).run('task_phase2', 'Phase 2', 'complete the graph', 'running', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-phase2-attempt-runner');
  const taskRuntimeService = new TaskRuntimeService({
    taskEngine,
    taskRepo,
    orchestration: new OrchestrationEngine(taskEngine),
  });
  const subtaskRepo = new SubtaskRepo(db);
  new AgentClassRepo(db).upsert(
    getBuiltinExecutorAgentClasses().find(item => item.name === 'codex-cli')!,
  );
  const a = node('task_phase2_a');
  const b = node('task_phase2_b', [{
    fromSubtaskId: a.id,
    requiredItems: [{ key: 'summary', type: 'text', description: 'A summary' }],
  }]);
  subtaskRepo.upsert(a);
  subtaskRepo.upsert(b);
  const workUnitRepo = new WorkUnitRepo(db);
  workUnitRepo.upsert({
    id: 'executor-codex', agentClassName: 'codex-cli', agentClassKind: 'executor', state: 'idle',
    claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    heartbeatAt: null, leaseExpiresAt: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  });
  const executionRuntime = {
    run: vi.fn().mockResolvedValue({
      taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
      output: rawResponse, error: null, artifacts: [], subtaskResults: [], durationMs: 10,
    }),
    supportsResponseOnly: vi.fn().mockReturnValue(true),
    runResponseOnly: vi.fn(),
  };
  const attemptSandbox: AttemptSandboxPort = {
    resolveImage: vi.fn(), create: vi.fn(), start: vi.fn(), wait: vi.fn(), logs: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), inspect: vi.fn(), stop: vi.fn(), remove: vi.fn(), listManaged: vi.fn(),
  } as unknown as AttemptSandboxPort;
  const fixtureRoot = `/tmp/metaclaw-phase2-attempt-runner/${randomUUID()}`;
  const sourceRoot = join(fixtureRoot, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, 'README.md'), 'fixture\n');
  const workspaceStore = new WorkspaceStore(join(fixtureRoot, 'store'));
  const attemptRunner = new SubtaskAttemptRunner({
    db,
    sessionId: 'session_1',
    taskRuntimeService,
    subtaskRepo,
    workUnitClaimService: new WorkUnitClaimService(workUnitRepo),
    executionRuntime: executionRuntime as never,
    agentClassService: { listAgentClasses: () => getBuiltinExecutorAgentClasses() } as never,
    workspaceStore,
    attemptSandbox,
    resourceLeaseService: new ResourceLeaseService(new SqliteResourceLeaseRepository(db)),
    permissionRepository: new SqlitePermissionRepository(db),
    kernelWorkflowStore: new KernelWorkflowRepo(db),
    workspaceRepository: new SqliteWorkspaceRepository(db),
    sourceRoot,
    controlNetwork: 'metaclaw-control',
  });
  const defaultResourceGrant = buildDefaultResourceClaims({
    workspaceId: `workspace-task_phase2-${a.generationId}-${a.id}`,
    sourceMountId: 'source-task_phase2', inputsMountId: 'inputs-task_phase2', handoffsMountId: 'handoffs-task_phase2',
    gitMetadataMountId: 'git-task_phase2',
  });
  const dispatchItems = new KernelDispatchItemRepo(db);
  const authorize = (input: {
    attemptId: string;
    attemptKind?: 'primary' | 'retry' | 'fallback' | 'contract_correction' | 'merge_repair';
    sourceAttemptId?: string | null;
    recoveryMode?: 'fresh' | 'native_session' | 'recovery_packet';
    attemptPayload?: Parameters<SubtaskAttemptRunner['run']>[0]['attemptPayload'];
  }) => {
    if (dispatchItems.find(input.attemptId)) return;
    const now = '2026-07-28T00:00:00.000Z';
    dispatchItems.insertBatch({
      schemaVersion: 5,
      id: `decision_${input.attemptId}`,
      eventId: `dispatch_${input.attemptId}`,
      reason: 'test dispatch authorization',
      action: {
        type: 'dispatch_batch',
        taskId: 'task_phase2',
        items: [{
          order: 0,
          subtaskId: a.id,
          attemptId: input.attemptId,
          agentClassName: 'codex-cli',
          attemptKind: input.attemptKind ?? 'primary',
          sourceAttemptId: input.sourceAttemptId ?? null,
          recoveryMode: input.recoveryMode ?? 'fresh',
          attemptPayload: input.attemptPayload ?? null,
          defaultResourceGrant,
        }],
      },
    }, a.generationId, now);
    if (dispatchItems.claimPending(input.attemptId, now)) {
      dispatchItems.markRunning(input.attemptId, null, now);
    }
  };
  const runner = {
    run: async (input: Parameters<SubtaskAttemptRunner['run']>[0]) => {
      authorize(input);
      return attemptRunner.run(input);
    },
    runCorrection: async (input: Parameters<SubtaskAttemptRunner['runCorrection']>[0]) => {
      authorize({
        ...input,
        attemptKind: 'contract_correction',
        recoveryMode: 'fresh',
        attemptPayload: {
          protocol: 'completion-correction-v2',
          completionContract: input.completionContract as never,
          violations: input.violations,
        },
      });
      return attemptRunner.runCorrection(input);
    },
  };
  return {
    db,
    runner,
    taskRuntimeService,
    subtaskRepo,
    workUnitRepo,
    executionRuntime,
    dispatchItems,
    workflow: new KernelWorkflowRepo(db),
    a,
    b,
    defaultResourceGrant,
  };
}

function authorizeRunningAttempt(
  setupResult: ReturnType<typeof setup>,
  attemptId: string,
): void {
  const now = '2026-07-28T00:00:00.000Z';
  setupResult.dispatchItems.insertBatch({
    schemaVersion: 5,
    id: `decision_${attemptId}`,
    eventId: `dispatch_${attemptId}`,
    reason: 'test dispatch authorization',
    action: {
      type: 'dispatch_batch',
      taskId: 'task_phase2',
      items: [{
        order: 0,
        subtaskId: setupResult.a.id,
        attemptId,
        agentClassName: 'codex-cli',
        attemptKind: 'primary',
        sourceAttemptId: null,
        recoveryMode: 'fresh',
        attemptPayload: null,
        defaultResourceGrant: setupResult.defaultResourceGrant,
      }],
    },
  }, setupResult.a.generationId, now);
  expect(setupResult.dispatchItems.claimPending(attemptId, now)).not.toBeNull();
  expect(setupResult.dispatchItems.markRunning(attemptId, null, now)).toBe(true);
}

function validResponse(): string {
  return `A completed.\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
    evidence: ['verified A'],
    noChangeReason: null,
  })}`;
}

describe('SubtaskAttemptRunner', () => {
  it('atomically records a candidate receipt without publishing handoffs before integration', async () => {
    const setupResult = setup(validResponse());
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({ outcome: 'completed', output: 'A completed.' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_integration',
      result: '',
    });
    expect(setupResult.db.prepare('SELECT terminal_state, raw_response FROM executor_attempt_receipts').get())
      .toMatchObject({ terminal_state: 'completed', raw_response: validResponse() });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get())
      .toEqual({ count: 0 });
    expect(setupResult.db.prepare(`
      SELECT subtask_id, source_attempt_id, status FROM workspace_publications
    `).get()).toEqual({
      subtask_id: setupResult.a.id,
      source_attempt_id: 'attempt_1',
      status: 'pending',
    });
    expect(setupResult.dispatchItems.find('attempt_1')?.status).toBe('terminal');
    expect(setupResult.workflow.findEvent('event_attempt_1_execution_outcome')).toMatchObject({
      type: 'execution_outcome',
      terminalKind: 'completed',
      attemptId: 'attempt_1',
    });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'idle', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });

  it('blocks malformed completion without exposing it as a successful Subtask result', async () => {
    const setupResult = setup('plain response without envelope');
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome.outcome).toBe('contract_failed');
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'awaiting_decision', result: '' });
    expect(setupResult.db.prepare('SELECT terminal_state, raw_response FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'contract_blocked', raw_response: 'plain response without envelope' });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 0 });
    expect(setupResult.taskRuntimeService.findTask('task_phase2')).toMatchObject({ status: 'running' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
    expect(setupResult.db.prepare(`
      SELECT event_type, state, attempt_id FROM work_unit_events
      WHERE work_unit_id = 'executor-codex' AND event_type IN ('failed', 'released')
      ORDER BY rowid
    `).all()).toEqual([
      { event_type: 'failed', state: 'failed', attempt_id: outcome.attemptId },
      { event_type: 'released', state: 'failed', attempt_id: outcome.attemptId },
    ]);
  });

  it('terminates a stale attempt without leaving its Subtask running or releasing its WorkUnit as idle', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockImplementationOnce(async () => {
      setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled while executor was running');
      setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'cancelled', {
        error: 'cancelled while executor was running',
      });
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.taskRuntimeService.findTask('task_phase2')).toMatchObject({ status: 'cancelled' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'cancelled', error: 'cancelled while executor was running',
    });
    expect(setupResult.db.prepare('SELECT terminal_state, error_code FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'cancelled_or_stale', error_code: 'attempt_stale' });
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 0 });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
    expect(setupResult.db.prepare(`
      SELECT event_type, state, attempt_id FROM work_unit_events
      WHERE work_unit_id = 'executor-codex' AND event_type IN ('failed', 'released')
      ORDER BY rowid
    `).all()).toEqual([
      { event_type: 'failed', state: 'failed', attempt_id: outcome.attemptId },
      { event_type: 'released', state: 'failed', attempt_id: outcome.attemptId },
    ]);
  });

  it('does not resurrect a cancelled Subtask when the running Executor reports cancellation', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockImplementationOnce(async () => {
      setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled while executor was running');
      setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'cancelled', {
        error: 'cancelled while executor was running',
      });
      return {
        taskId: 'task_phase2',
        executionId: 'exec_1',
        status: 'cancelled',
        executorName: 'codex-cli',
        output: '',
        error: 'attempt cancelled',
        artifacts: [],
        subtaskResults: [],
        durationMs: 10,
      };
    });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_cancelled',
      executionId: 'exec_1',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli',
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'cancelled',
      error: 'cancelled while executor was running',
    });
    expect(setupResult.db.prepare(`
      SELECT terminal_state, error_code FROM executor_attempt_receipts
      WHERE attempt_id = 'attempt_cancelled'
    `).get()).toEqual({
      terminal_state: 'cancelled_or_stale',
      error_code: 'attempt_cancelled',
    });
  });

  it('blocks a handoff that would exceed the downstream aggregate budget', async () => {
    const rawResponse = `A completed.\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
      evidence: [
        'x'.repeat(1_000),
        'x'.repeat(1_000),
        'x'.repeat(1_000),
        'x'.repeat(997),
      ],
      noChangeReason: null,
    })}`;
    const setupResult = setup(rawResponse);
    setupResult.subtaskRepo.upsert(node('task_phase2_c'));
    setupResult.db.prepare(`
      INSERT INTO subtask_handoffs (
        task_id, from_subtask_id, to_subtask_id, attempt_id,
        items_json, completion_schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      'task_phase2',
      'task_phase2_c',
      'task_phase2_b',
      'attempt_existing',
      JSON.stringify(Array.from({ length: 6 }, (_, index) => ({
        key: `existing_${index}`,
        type: 'text',
        value: 'y'.repeat(3_500),
      }))),
      '2026-07-17T00:00:00.000Z',
    );

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({ outcome: 'contract_failed' });
    expect(outcome.outcome === 'contract_failed' ? outcome.violations : []).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded',
      path: 'handoffs.0.toSubtaskId',
    }));
    expect(setupResult.db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({ count: 1 });
  });

  it('persists an executor failure and releases the exact attempt claim when execution throws', async () => {
    const setupResult = setup(validResponse());
    setupResult.executionRuntime.run.mockRejectedValueOnce(new Error('progress callback failed'));
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_1',
      executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(outcome).toMatchObject({ outcome: 'executor_failed', error: 'progress callback failed' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({ status: 'awaiting_decision' });
    expect(setupResult.db.prepare('SELECT terminal_state, error_detail FROM executor_attempt_receipts').get())
      .toEqual({ terminal_state: 'executor_failed', error_detail: 'progress callback failed' });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'failed', claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
    });
  });

  it('lands receipt, Subtask state, dispatch terminal and Kernel outcome inbox together', async () => {
    const setupResult = setup(validResponse());
    authorizeRunningAttempt(setupResult, 'attempt_atomic_terminal');
    setupResult.executionRuntime.run.mockRejectedValueOnce(new Error('executor process crashed'));

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_atomic_terminal',
      executionId: 'exec_atomic_terminal',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli',
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'executor_failed' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)?.status).toBe('awaiting_decision');
    expect(setupResult.dispatchItems.find('attempt_atomic_terminal')?.status).toBe('terminal');
    expect(setupResult.workflow.findEvent(
      'event_attempt_atomic_terminal_execution_outcome',
    )).toMatchObject({
      type: 'execution_outcome',
      attemptId: 'attempt_atomic_terminal',
      terminalKind: 'failed',
    });
  });

  it('keeps attempt ownership for reconciliation when terminal sealing fails', async () => {
    const setupResult = setup(validResponse());
    setupResult.db.exec(`
      CREATE TRIGGER reject_runner_terminal_outcome
      BEFORE INSERT ON kernel_events
      WHEN NEW.id = 'event_attempt_terminal_blocked_execution_outcome'
      BEGIN
        SELECT RAISE(ABORT, 'injected runner terminal seal failure');
      END
    `);

    await expect(setupResult.runner.run({
      attemptId: 'attempt_terminal_blocked',
      executionId: 'exec_terminal_blocked',
      taskId: 'task_phase2',
      subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli',
      executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    })).rejects.toThrow('injected runner terminal seal failure');

    expect(setupResult.subtaskRepo.findById(setupResult.a.id)?.status).toBe('running');
    expect(setupResult.dispatchItems.find('attempt_terminal_blocked')?.status).toBe('running');
    expect(setupResult.db.prepare(`
      SELECT COUNT(*) AS count FROM executor_attempt_receipts
      WHERE attempt_id = 'attempt_terminal_blocked'
    `).get()).toEqual({ count: 0 });
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({
      state: 'running',
      claimedTaskId: 'task_phase2',
      claimedSubtaskId: setupResult.a.id,
      claimedAttemptId: 'attempt_terminal_blocked',
    });
    expect(setupResult.db.prepare(`
      SELECT COUNT(*) AS count FROM resource_leases
      WHERE attempt_id = 'attempt_terminal_blocked' AND released_at IS NULL
    `).get()).toEqual({ count: setupResult.defaultResourceGrant.length });
  });

  it('runs a Kernel-authorized fallback from awaiting_decision without treating it as stale', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'awaiting_decision', { error: 'source attempt failed' });

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_fallback', sourceAttemptId: 'attempt_source', attemptKind: 'fallback',
      recoveryMode: 'recovery_packet', executionId: 'exec_2', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, agentClassName: 'codex-cli', executionMode: 'follow-up', defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'completed', attemptId: 'attempt_fallback' });
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_integration',
    });
  });

  it('does not start a stale fallback after the Task was cancelled', async () => {
    const setupResult = setup(validResponse());
    setupResult.subtaskRepo.updateStatus(setupResult.a.id, 'awaiting_decision', { error: 'source attempt failed' });
    setupResult.taskRuntimeService.cancelTask('task_phase2', 'cancelled before retry wake');

    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_stale_fallback', sourceAttemptId: 'attempt_source', attemptKind: 'fallback',
      recoveryMode: 'recovery_packet', executionId: 'exec_2', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, agentClassName: 'codex-cli', executionMode: 'follow-up', defaultResourceGrant: setupResult.defaultResourceGrant,
    });

    expect(outcome).toMatchObject({ outcome: 'cancelled_or_stale' });
    expect(setupResult.executionRuntime.run).not.toHaveBeenCalled();
    expect(setupResult.workUnitRepo.findById('executor-codex')).toMatchObject({ state: 'idle' });
  });

  it('stages only a corrected response from one isolated response-only attempt', async () => {
    const setupResult = setup('first malformed response');
    const first = await setupResult.runner.run({
      attemptId: 'attempt_primary', executionId: 'exec_1', taskId: 'task_phase2', subtaskId: setupResult.a.id,
      agentClassName: 'codex-cli', executionMode: 'fresh', defaultResourceGrant: setupResult.defaultResourceGrant,
    });
    expect(first.outcome).toBe('contract_failed');
    if (first.outcome !== 'contract_failed') return;
    setupResult.workUnitRepo.updateState('executor-codex', 'idle');
    setupResult.executionRuntime.runResponseOnly.mockResolvedValue({
      success: true, output: validResponse(), exitCode: 0, durationMs: 5,
    });

    const corrected = await setupResult.runner.runCorrection({
      attemptId: 'attempt_correction', sourceAttemptId: first.attemptId, executionId: 'exec_1',
      taskId: 'task_phase2', subtaskId: setupResult.a.id, agentClassName: 'codex-cli',
      completionContract: first.completionContract, violations: first.violations,
    });

    expect(corrected).toMatchObject({ outcome: 'completed', output: 'A completed.' });
    expect(setupResult.executionRuntime.runResponseOnly).toHaveBeenCalledTimes(1);
    const correctionPrompt = setupResult.executionRuntime.runResponseOnly.mock.calls[0][1];
    expect(correctionPrompt).toContain('first malformed response');
    expect(correctionPrompt).toContain('{"evidence":["<concise evidence>"],"noChangeReason":null}');
    expect(correctionPrompt).not.toContain('Completion contract:');
    expect(correctionPrompt).not.toContain('task_phase2_a');
    expect(correctionPrompt).not.toContain('acceptanceEvidence');
    expect(setupResult.db.prepare(`
      SELECT attempt_id, terminal_state, raw_response FROM executor_attempt_receipts ORDER BY completed_at, attempt_id
    `).all()).toEqual(expect.arrayContaining([
      { attempt_id: 'attempt_primary', terminal_state: 'contract_blocked', raw_response: 'first malformed response' },
      { attempt_id: 'attempt_correction', terminal_state: 'completed', raw_response: validResponse() },
    ]));
    expect(setupResult.subtaskRepo.findById(setupResult.a.id)).toMatchObject({
      status: 'awaiting_integration',
      result: '',
    });
    expect(setupResult.db.prepare(`
      SELECT source_attempt_id, status FROM workspace_publications
    `).get()).toEqual({ source_attempt_id: 'attempt_correction', status: 'pending' });
  });

  it('wires exact Task resource rules into the production permission workflow', async () => {
    const setupResult = setup(validResponse());
    setupResult.db.prepare('UPDATE tasks SET resources_json = ? WHERE id = ?')
      .run(JSON.stringify(['report.pdf']), 'task_phase2');
    let permissionResult: { status: string; grantId: string | null } | null = null;
    setupResult.executionRuntime.run.mockImplementationOnce(async (invocation: any) => {
      const binding = invocation.executorInput.sandbox.capabilityBinding;
      const response = await fetch(binding.jsonUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capability: 'additional_read_resource', resource: 'report.pdf', operation: 'read',
          reason: 'inspect the Task-provided report', suggestedScope: 'once',
        }),
      });
      permissionResult = await response.json() as { status: string; grantId: string | null };
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'codex-cli',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const previousControlHost = process.env.METACLAW_CONTROL_HOST;
    process.env.METACLAW_CONTROL_HOST = '127.0.0.1';
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_registered_read', executionId: 'exec_1', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, agentClassName: 'codex-cli', executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    }).finally(() => {
      if (previousControlHost === undefined) delete process.env.METACLAW_CONTROL_HOST;
      else process.env.METACLAW_CONTROL_HOST = previousControlHost;
    });

    expect(outcome).toMatchObject({ outcome: 'completed' });
    expect(permissionResult).toMatchObject({ status: 'granted' });
    expect(permissionResult?.grantId).toMatch(/^permission_grant_/u);
  });

  it('wires public network rules only for the public-web-research AgentClass profile', async () => {
    const setupResult = setup(validResponse());
    new AgentClassRepo(setupResult.db).upsert(
      getBuiltinExecutorAgentClasses().find(item => item.name === 'pi-agent')!,
    );
    setupResult.workUnitRepo.upsert({
      id: 'executor-pi', agentClassName: 'pi-agent', agentClassKind: 'executor', state: 'idle',
      claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null,
      heartbeatAt: null, leaseExpiresAt: null,
      createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    });
    let permissionResult: { status: string; grantId: string | null } | null = null;
    setupResult.executionRuntime.run.mockImplementationOnce(async (invocation: any) => {
      const binding = invocation.executorInput.sandbox.capabilityBinding;
      const response = await fetch(binding.jsonUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capability: 'network_target', resource: 'https://example.com/reports/latest', operation: 'fetch',
          reason: 'retrieve a public source', suggestedScope: 'attempt',
        }),
      });
      permissionResult = await response.json() as { status: string; grantId: string | null };
      return {
        taskId: 'task_phase2', executionId: 'exec_1', status: 'success', executorName: 'pi-agent',
        output: validResponse(), error: null, artifacts: [], subtaskResults: [], durationMs: 10,
      };
    });

    const previousControlHost = process.env.METACLAW_CONTROL_HOST;
    process.env.METACLAW_CONTROL_HOST = '127.0.0.1';
    const outcome = await setupResult.runner.run({
      attemptId: 'attempt_public_network', executionId: 'exec_1', taskId: 'task_phase2',
      subtaskId: setupResult.a.id, agentClassName: 'pi-agent', executionMode: 'fresh',
      defaultResourceGrant: setupResult.defaultResourceGrant,
    }).finally(() => {
      if (previousControlHost === undefined) delete process.env.METACLAW_CONTROL_HOST;
      else process.env.METACLAW_CONTROL_HOST = previousControlHost;
    });

    expect(outcome).toMatchObject({ outcome: 'completed' });
    expect(permissionResult).toMatchObject({ status: 'granted' });
    expect(permissionResult?.grantId).toMatch(/^permission_grant_/u);
  });
});
