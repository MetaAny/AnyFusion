import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { buildDefaultResourceClaims } from '../../src/resource/index.js';
import { buildPermissionRules } from '../../src/resource/index.js';
import { PermissionWorkflowService } from '../../src/execution/permission-workflow-service.js';
import { RegisteredCapabilityResourceResolver } from '../../src/execution/capability-resource-resolver.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { ControlKernel } from '../../src/kernel/control-kernel.js';
import { stubPlanningAgent, taskControlPlan } from '../support/planning-agent-plans.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('session startup running-task reconciliation', () => {
  it('re-presents an unresolved publication approval in the current Session without re-running its Executor', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-publication-review');
    const task = taskEngine.create({
      title: 'World Cup odds',
      goal: 'Publish the completed World Cup odds candidate',
    });
    seedPersistedWorkGraph(db, task.id, task.goal);
    taskEngine.transition(task.id, 'ready');
    const subtasks = new SubtaskRepo(db);
    const subtask = subtasks.listActiveByTask(task.id)[0]!;
    subtasks.updateStatus(subtask.id, 'awaiting_integration');
    const permissions = new SqlitePermissionRepository(db);
    const now = new Date().toISOString();
    const sourceRoot = '/workspace/default';
    const oldWorkflow = new PermissionWorkflowService({
      context: {
        sessionId: 'sess_old_review',
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        attemptId: 'attempt-publication-review',
        agentClassName: 'codex-cli',
        permissionProfileId: 'workspace-engineering',
        runtimeHandle: '',
        workspaceId: `workspace:${task.id}:${subtask.generationId}:${subtask.id}`,
        checkpointId: null,
      },
      repository: permissions,
      resolver: new RegisteredCapabilityResourceResolver(new Map([
        [sourceRoot, { kind: 'repository' as const, repositoryId: 'project-default' }],
      ])),
      sandbox: new FakeAttemptSandbox(),
      workflowStore: new KernelWorkflowRepo(db),
      kernel: new ControlKernel(),
      rules: buildPermissionRules({
        permissionProfileId: 'workspace-engineering',
        additionalReadPartitions: [],
      }),
      hooks: {
        checkpoint: async () => null,
        onEscalation: async () => undefined,
        onRecoveryAuthorized: async () => undefined,
      },
      clock: { now: () => now },
    });
    const requested = await oldWorkflow.request({
      capability: 'repository_promotion',
      resource: sourceRoot,
      operation: 'promote_commit:candidate-world-cup',
      reason: 'Merge the completed candidate into Project main.',
      suggestedScope: 'once',
    }, { suspendAttempt: false });
    expect(requested.status).toBe('escalated');
    const publications = new WorkspacePublicationRepo(db);
    publications.insertCandidate({
      id: 'publication-world-cup',
      taskId: task.id,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      sourceAttemptId: 'attempt-publication-review',
      agentClassName: 'codex-cli',
      mainBaseCommit: 'base-world-cup',
      candidateCommit: 'candidate-world-cup',
      permissionRequestId: requested.requestId,
      changedPaths: ['next_world_cup_odds.md'],
      completion: {
        body: 'World Cup odds complete',
        artifacts: ['next_world_cup_odds.md'],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 4,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    const attemptSandbox = new FakeAttemptSandbox();
    const common = {
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptSandbox,
      db,
      config: createConfig(),
      contextRecaller: new ContextRecaller(db),
    };
    const staleSession = new MetaclawSession({ ...common, sessionId: 'sess_old_review' });
    const currentSession = new MetaclawSession({
      ...common,
      sessionId: 'sess_current_review',
      planningAgent: stubPlanningAgent(taskControlPlan({ control: 'resume_task', taskId: task.id })),
    });

    expect(currentSession.getPlannerTuiPermissionRequests()).toEqual([]);
    currentSession.initialize();
    await currentSession.waitForAsyncWork();

    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(currentSession.getSnapshot().output.join('\n')).toContain('等待审批');
    expect(currentSession.getSnapshot().output.join('\n')).not.toContain('操作提案');
    expect(currentSession.getPlannerTuiSnapshot().taskPool).toMatchObject([{
      id: task.id,
      status: 'waiting_approval',
      blockingReason: `等待批准仓库发布请求 ${requested.requestId}`,
    }]);
    expect(currentSession.getPlannerTuiPermissionRequests()).toMatchObject([{
      permissionRequestId: requested.requestId,
      taskId: task.id,
      operation: 'promote_commit:candidate-world-cup',
    }]);
    await currentSession.submit('继续世界杯任务', { awaitAsyncWork: true });
    expect(currentSession.getSnapshot().output.join('\n')).toContain('当前只等待仓库发布审批');
    expect(attemptSandbox.create).not.toHaveBeenCalled();
    await expect(staleSession.resolvePlannerTuiPermission(requested.requestId, 'approve'))
      .resolves.toMatchObject({ status: 'conflict' });
    await expect(currentSession.resolvePlannerTuiPermission(requested.requestId, 'deny'))
      .resolves.toMatchObject({ status: 'resolved', resolution: 'deny' });
    expect(publications.find('publication-world-cup')).toMatchObject({
      status: 'denied',
      candidateCommit: 'candidate-world-cup',
      sourceAttemptId: 'attempt-publication-review',
    });
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });

  it('records and safely blocks orphaned running work without automatic execution', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const runningTask = taskEngine.create({ title: '长时间调研任务', goal: '继续调研产业链' });
    seedPersistedWorkGraph(db, runningTask.id, runningTask.goal);
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');
    taskRepo.update(runningTask.id, {
      summary: '已完成一半',
    });

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '自动恢复成功' }));
    attemptSandbox.listManaged.mockRejectedValue(
      new Error('sandbox must not be consulted without attempt ownership'),
    );
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_startup_reconcile',
      contextRecaller,
    });

    session.initialize();
    await session.waitForAsyncWork();
    const snapshot = session.getSnapshot();

    expect(attemptSandbox.listManaged).not.toHaveBeenCalled();
    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(taskRepo.findById(runningTask.id)?.status).toBe('blocked');
    expect(snapshot.output.join('\n')).toContain(`检测到上次异常退出，任务 #${runningTask.id} 已安全阻塞`);
    expect(db.prepare("SELECT action FROM kernel_decisions WHERE task_id = ?").get(runningTask.id))
      .toEqual({ action: 'block_work' });
  });

  it('enters recovery-blocked mode without releasing claims when Docker reconciliation fails', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-recovery-blocked');
    const runningTask = taskEngine.create({
      title: 'Recovery blocked',
      goal: 'Preserve ownership until Docker can be inspected',
    });
    seedPersistedWorkGraph(db, runningTask.id, runningTask.goal);
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');
    const workUnits = new WorkUnitRepo(db);
    workUnits.upsert({
      id: 'executor-recovery-blocked',
      agentClassName: 'codex-cli',
      agentClassKind: 'executor',
      state: 'running',
      claimedTaskId: runningTask.id,
      claimedSubtaskId: `${runningTask.id}_execute`,
      claimedAttemptId: 'attempt-recovery-blocked',
      heartbeatAt: '2026-07-28T00:00:00.000Z',
      leaseExpiresAt: '2026-07-28T00:10:00.000Z',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const attemptSandbox = new FakeAttemptSandbox();
    attemptSandbox.listManaged.mockRejectedValue(new Error('Docker daemon unavailable'));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_recovery_blocked',
      contextRecaller: new ContextRecaller(db),
    });

    session.initialize();
    await session.waitForAsyncWork();

    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(workUnits.findById('executor-recovery-blocked')).toMatchObject({
      state: 'running',
      claimedTaskId: runningTask.id,
      claimedSubtaskId: `${runningTask.id}_execute`,
      claimedAttemptId: 'attempt-recovery-blocked',
    });
    expect(taskRepo.findById(runningTask.id)?.status).toBe('blocked');
    expect(session.getSnapshot().output.join('\n')).toContain('恢复阻塞');
  });

  it('does not release a reconciled claim or lease before terminal facts are durably sealed', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-terminal-seal-blocked');
    const runningTask = taskEngine.create({
      title: 'Terminal seal blocked',
      goal: 'Preserve ownership when terminal persistence fails',
    });
    seedPersistedWorkGraph(db, runningTask.id, runningTask.goal);
    taskEngine.transition(runningTask.id, 'ready');
    taskEngine.transition(runningTask.id, 'running');
    const subtaskRepo = new SubtaskRepo(db);
    const subtask = subtaskRepo.listActiveByTask(runningTask.id)[0]!;
    subtaskRepo.updateStatus(subtask.id, 'running');
    const attemptId = 'attempt-terminal-seal-blocked';
    const workUnitId = 'executor-terminal-seal-blocked';
    const workUnits = new WorkUnitRepo(db);
    workUnits.upsert({
      id: workUnitId,
      agentClassName: 'codex-cli',
      agentClassKind: 'executor',
      state: 'running',
      claimedTaskId: runningTask.id,
      claimedSubtaskId: subtask.id,
      claimedAttemptId: attemptId,
      heartbeatAt: '2099-01-01T00:00:00.000Z',
      leaseExpiresAt: '2099-01-01T00:10:00.000Z',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const resourceGrant = buildDefaultResourceClaims({
      workspaceId: `workspace-${runningTask.id}-${subtask.generationId}-${subtask.id}`,
      sourceMountId: `source-${runningTask.id}`,
      inputsMountId: `inputs-${runningTask.id}`,
      handoffsMountId: `handoffs-${runningTask.id}`,
      gitMetadataMountId: `git-${runningTask.id}`,
    });
    const leaseRepository = new SqliteResourceLeaseRepository(db);
    new ResourceLeaseService(leaseRepository).claim({
      taskId: runningTask.id,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId,
      claims: resourceGrant,
      leaseToken: 'lease-terminal-seal-blocked',
      now: '2099-01-01T00:00:00.000Z',
    });
    new KernelDispatchItemRepo(db).insertBatch({
      schemaVersion: 5,
      id: 'decision-terminal-seal-blocked',
      eventId: 'event-dispatch-terminal-seal-blocked',
      reason: 'persisted authorized attempt',
      action: {
        type: 'dispatch_batch',
        taskId: runningTask.id,
        items: [{
          order: 0,
          subtaskId: subtask.id,
          attemptId,
          agentClassName: 'codex-cli',
          attemptKind: 'primary',
          sourceAttemptId: null,
          recoveryMode: 'fresh',
          attemptPayload: null,
          defaultResourceGrant: resourceGrant,
        }],
      },
    }, subtask.generationId, '2026-07-28T00:00:00.000Z');
    const dispatch = new KernelDispatchItemRepo(db);
    dispatch.claimPending(attemptId, '2026-07-28T00:00:00.000Z');
    dispatch.markRunning(attemptId, null, '2026-07-28T00:00:00.000Z');
    db.exec(`
      CREATE TRIGGER reject_reconciled_terminal_receipt
      BEFORE INSERT ON executor_attempt_receipts
      WHEN NEW.attempt_id = 'attempt-terminal-seal-blocked'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal seal failure');
      END
    `);
    const attemptSandbox = new FakeAttemptSandbox();
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_terminal_seal_blocked',
      contextRecaller: new ContextRecaller(db),
    });

    session.initialize();
    await expect(session.waitForAsyncWork()).resolves.toBeUndefined();

    expect(workUnits.findById(workUnitId)).toMatchObject({
      state: 'running',
      claimedTaskId: runningTask.id,
      claimedSubtaskId: subtask.id,
      claimedAttemptId: attemptId,
    });
    const activeLeases = leaseRepository.findActive('2026-07-28T00:00:00.000Z');
    expect(activeLeases).toHaveLength(resourceGrant.length);
    expect(activeLeases.every(lease => lease.attemptId === attemptId && lease.releasedAt === null)).toBe(true);
    expect(dispatch.find(attemptId)?.status).toBe('running');
    expect(taskRepo.findById(runningTask.id)?.status).toBe('blocked');
    expect(session.getSnapshot().output.join('\n')).toContain('恢复阻塞');
  });
});
