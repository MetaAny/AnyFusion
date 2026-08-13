import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
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
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { buildDefaultResourceClaims } from '../../src/resource/index.js';
import { buildPermissionRules } from '../../src/resource/index.js';
import { PermissionWorkflowService } from '../../src/execution/permission-workflow-service.js';
import { RegisteredCapabilityResourceResolver } from '../../src/execution/capability-resource-resolver.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { ExecutorAttemptReceiptRepo } from '../../src/storage/executor-attempt-receipt-repo.js';
import { ManagedGitWorkspaceService } from '../../src/execution/managed-git-workspace.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { ControlKernel } from '../../src/kernel/control-kernel.js';
import { stubPlanningAgent, taskControlPlan } from '../support/planning-agent-plans.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

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
  it('publishes the preserved candidate and projects its original Executor report after reissued approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-publication-reissue-'));
    try {
      const project = join(root, 'project');
      await exec('git', ['init', '-b', 'main', project]);
      await git(project, 'config', 'user.name', 'Test User');
      await git(project, 'config', 'user.email', 'test@example.invalid');
      await writeFile(join(project, 'base.txt'), 'base\n');
      await git(project, 'add', '-A');
      await git(project, 'commit', '-m', 'base');

      const db = createTestDb();
      const taskRepo = new TaskRepo(db);
      const taskEngine = new TaskEngine(taskRepo, join(root, 'snapshots'));
      const task = taskEngine.create({
        title: 'World Cup publication recovery',
        goal: 'Publish the preserved World Cup report',
      });
      seedPersistedWorkGraph(db, task.id, task.goal);
      taskEngine.transition(task.id, 'ready');
      const subtasks = new SubtaskRepo(db);
      const subtask = subtasks.listActiveByTask(task.id)[0]!;
      subtasks.updateStatus(subtask.id, 'awaiting_integration');

      const workspaceStore = new WorkspaceStore(
        join(`${project}.anyfusion-runtime`, 'project-worktrees', 'project_test_default'),
      );
      const gitWorkspaces = new ManagedGitWorkspaceService(workspaceStore);
      const workspace = await gitWorkspaces.ensure({
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
      }, project);
      await writeFile(join(workspace.filesPath, 'world-cup-report.md'), '# World Cup report\n');
      await git(workspace.filesPath, 'add', '-A');
      await git(workspace.filesPath, 'commit', '-m', 'feat: add World Cup report');
      const candidate = await gitWorkspaces.validateExecutorCandidate(workspace);

      const workUnitId = 'executor-publication-reissue';
      new WorkUnitRepo(db).upsert({
        id: workUnitId,
        agentClassName: 'codex-cli',
        agentClassKind: 'executor',
        state: 'idle',
        claimedTaskId: null,
        claimedSubtaskId: null,
        claimedAttemptId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      const attemptId = 'attempt-publication-reissue-integrated';
      new ExecutorAttemptReceiptRepo(db).insert({
        attemptId,
        executionId: 'execution-publication-reissue',
        taskId: task.id,
        subtaskId: subtask.id,
        workUnitId,
        agentClassName: 'codex-cli',
        startedAt: '2026-08-01T00:00:00.000Z',
        completedAt: '2026-08-01T00:01:00.000Z',
        terminalState: 'completed',
        rawResponse: 'World Cup report completed',
        completionSchemaVersion: 4,
        parsing: {},
        verification: { warnings: [], violations: [] },
        errorCode: null,
        errorDetail: null,
      });

      const permissions = new SqlitePermissionRepository(db);
      const oldReviewAt = '2026-08-01T00:00:00.000Z';
      const workflow = new PermissionWorkflowService({
        context: {
          sessionId: 'sess_old_publication_approval',
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          attemptId,
          agentClassName: 'codex-cli',
          permissionProfileId: 'workspace-engineering',
          runtimeHandle: '',
          workspaceId: workspace.id,
          checkpointId: null,
        },
        repository: permissions,
        resolver: new RegisteredCapabilityResourceResolver(new Map([
          [project, { kind: 'repository' as const, repositoryId: 'project_test_default' }],
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
        clock: { now: () => oldReviewAt },
      });
      const requested = await workflow.request({
        capability: 'repository_promotion',
        resource: project,
        operation: `promote_commit:${candidate.candidateCommit}`,
        reason: 'Publish the preserved World Cup report candidate.',
        suggestedScope: 'once',
      }, { suspendAttempt: false });
      const publications = new WorkspacePublicationRepo(db);
      publications.insertCandidate({
        id: 'publication-world-cup-reissue-integrated',
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        sourceAttemptId: attemptId,
        agentClassName: 'codex-cli',
        mainBaseCommit: candidate.mainCommit,
        candidateCommit: candidate.candidateCommit,
        permissionRequestId: requested.requestId,
        changedPaths: candidate.changedPaths,
        completion: {
          body: 'World Cup report completed',
          artifacts: ['world-cup-report.md'],
          warnings: [],
          handoffs: [],
          completionSchemaVersion: 4,
        },
        topologyLayer: 0,
        firstDispatchOrder: 0,
        createdAt: oldReviewAt,
      });

      const attemptSandbox = new FakeAttemptSandbox();
      const session = new MetaclawSession({
        taskEngine,
        memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
        orchestration: new OrchestrationEngine(taskEngine),
        attemptSandbox,
        db,
        config: createConfig(),
        sessionId: 'sess_current_publication_approval',
        contextRecaller: new ContextRecaller(db),
        sourceRoot: project,
      });
      session.initialize();
      await session.waitForAsyncWork();
      await session.submit(`/task resume ${task.id}`, { awaitAsyncWork: true });
      expect(session.getPlannerTuiPermissionRequests()).toMatchObject([{
        permissionRequestId: requested.requestId,
        candidateReport: 'World Cup report completed',
        candidateArtifacts: ['world-cup-report.md'],
        changedPaths: ['world-cup-report.md'],
      }]);
      await expect(session.resolvePlannerTuiPermission(requested.requestId, 'approve'))
        .resolves.toMatchObject({ status: 'resolved', resolution: 'approve' });
      await session.waitForAsyncWork();

      expect(await readFile(join(project, 'world-cup-report.md'), 'utf8'))
        .toBe('# World Cup report\n');
      expect(publications.find('publication-world-cup-reissue-integrated')).toMatchObject({
        status: 'integrated',
        permissionRequestId: requested.requestId,
        candidateCommit: candidate.candidateCommit,
      });
      expect(subtasks.findById(subtask.id)).toMatchObject({
        status: 'done',
        result: 'World Cup report completed',
        artifacts: [join(project, 'world-cup-report.md')],
      });
      expect(session.getPlannerTuiExecutorResults()).toMatchObject([{
        publicationId: 'publication-world-cup-reissue-integrated',
        report: 'World Cup report completed',
        artifacts: [join(project, 'world-cup-report.md')],
        integrationCommit: expect.any(String),
      }]);
      expect(session.getSnapshot().output.join('\n')).toContain('World Cup report completed');
      expect(attemptSandbox.create).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['expired', 'missing'] as const)(
    'reissues the same immutable publication review on explicit resume when the request is %s',
    async failureMode => {
      const db = createTestDb();
      const taskRepo = new TaskRepo(db);
      const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-publication-reissue');
      const task = taskEngine.create({
        title: 'World Cup recovery',
        goal: 'Publish the preserved World Cup candidate',
      });
      seedPersistedWorkGraph(db, task.id, task.goal);
      taskEngine.transition(task.id, 'ready');
      const subtasks = new SubtaskRepo(db);
      const subtask = subtasks.listActiveByTask(task.id)[0]!;
      subtasks.updateStatus(subtask.id, 'awaiting_integration');
      const permissions = new SqlitePermissionRepository(db);
      const originalReviewAt = '2026-08-01T00:00:00.000Z';
      const sourceRoot = '/workspace/default';
      const workflow = new PermissionWorkflowService({
        context: {
          sessionId: 'sess_expired_review',
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          attemptId: 'attempt-publication-reissue',
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
        clock: { now: () => originalReviewAt },
      });
      const requested = await workflow.request({
        capability: 'repository_promotion',
        resource: sourceRoot,
        operation: 'promote_commit:candidate-world-cup-reissue',
        reason: [
          `Merge Subtask ${subtask.id} into Project main.`,
          'Approved main base: base-world-cup-reissue.',
          'Candidate: candidate-world-cup-reissue.',
          'Changed paths (1): next_world_cup_odds.md.',
        ].join(' '),
        suggestedScope: 'once',
      }, { suspendAttempt: false });
      const publications = new WorkspacePublicationRepo(db);
      publications.insertCandidate({
        id: `publication-world-cup-${failureMode}`,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        sourceAttemptId: 'attempt-publication-reissue',
        agentClassName: 'codex-cli',
        mainBaseCommit: 'base-world-cup-reissue',
        candidateCommit: 'candidate-world-cup-reissue',
        permissionRequestId: requested.requestId,
        changedPaths: ['next_world_cup_odds.md'],
        completion: {
          body: 'Recovered World Cup report',
          artifacts: ['next_world_cup_odds.md'],
          warnings: [],
          handoffs: [],
          completionSchemaVersion: 4,
        },
        topologyLayer: 0,
        firstDispatchOrder: 0,
        createdAt: originalReviewAt,
      });
      if (failureMode === 'missing') {
        db.prepare('DELETE FROM permission_requests WHERE id = ?').run(requested.requestId);
      }
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
      const staleSession = new MetaclawSession({ ...common, sessionId: 'sess_expired_review' });
      const currentSession = new MetaclawSession({ ...common, sessionId: `sess_reissue_${failureMode}` });

      currentSession.initialize();
      await currentSession.waitForAsyncWork();
      expect(currentSession.getPlannerTuiPermissionRequests()).toEqual([]);

      await currentSession.submit(`/task resume ${task.id}`, { awaitAsyncWork: true });

      const reviews = new KernelDecisionRepo(db).listByCorrelation(requested.requestId)
        .filter(decision => decision.action === 'escalate_capability'
          && new KernelWorkflowRepo(db).isDecisionApplied(decision.id));
      expect(reviews).toHaveLength(2);
      expect(reviews[1]).toMatchObject({
        sessionId: `sess_reissue_${failureMode}`,
        causationId: reviews[0]!.id,
      });
      expect(permissions.findRequest(requested.requestId)).toMatchObject({
        status: 'escalated',
        request: {
          id: requested.requestId,
          operation: 'promote_commit:candidate-world-cup-reissue',
          attemptId: 'attempt-publication-reissue',
        },
      });
      expect(publications.find(`publication-world-cup-${failureMode}`)).toMatchObject({
        permissionRequestId: requested.requestId,
        candidateCommit: 'candidate-world-cup-reissue',
        mainBaseCommit: 'base-world-cup-reissue',
        status: 'awaiting_approval',
      });
      expect(currentSession.getPlannerTuiPermissionRequests()).toMatchObject([{
        permissionRequestId: requested.requestId,
        reviewId: reviews[1]!.id,
        operation: 'promote_commit:candidate-world-cup-reissue',
      }]);
      await currentSession.submit(`/task resume ${task.id}`, { awaitAsyncWork: true });
      expect(new KernelDecisionRepo(db).listByCorrelation(requested.requestId)
        .filter(decision => decision.action === 'escalate_capability')).toHaveLength(2);
      await expect(staleSession.resolvePlannerTuiPermission(requested.requestId, 'approve'))
        .resolves.toMatchObject({ status: 'conflict' });
      expect(attemptSandbox.create).not.toHaveBeenCalled();
    },
  );

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
