import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePublicationWorker } from '../../src/execution/workspace-publication-worker.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';

describe('WorkspacePublicationWorker cancellation fence', () => {
  it('keeps an observed integration commit as audit only when cancellation wins before publication', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-cancel');
    const taskRuntime = new TaskRuntimeService({
      taskEngine,
      taskRepo: new TaskRepo(db),
    });
    const task = taskEngine.create({
      id: 'task-publication-cancel',
      title: 'Publication cancellation',
      goal: 'Do not publish after cancellation',
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    const subtasks = new SubtaskRepo(db);
    subtasks.upsert({
      id: 'subtask-publication-cancel',
      taskId: task.id,
      graphRevision: 1,
      generationId: 'generation-publication-cancel',
      title: 'Candidate',
      goal: 'Publish candidate',
      status: 'awaiting_integration',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      preferredAgentClassList: ['codex-cli'],
      deliveryKind: 'report',
      acceptance: [],
      riskLevel: 'low',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const publications = new WorkspacePublicationRepo(db);
    publications.insertCandidate({
      id: 'publication-cancel-race',
      taskId: task.id,
      generationId: 'generation-publication-cancel',
      subtaskId: 'subtask-publication-cancel',
      sourceAttemptId: 'attempt-source',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate-commit',
      completion: {
        body: 'must not become visible',
        artifacts: ['result.md'],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 3,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    const release = vi.fn();
    const worker = new WorkspacePublicationWorker({
      db,
      sessionId: 'session-publication-cancel',
      sourceRoot: '/tmp/source',
      workspaceStore: { rootPath: '/tmp/workspace-publication-test' } as never,
      workspaceRepository: {
        findByIdentity: vi.fn().mockReturnValue(null),
      } as never,
      subtaskRepo: subtasks,
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue({ workUnitId: 'work-unit-source' }),
      } as never,
      resourceLeaseService: {
        claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
        release,
      } as never,
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([]),
      } as never,
      taskRuntimeService: taskRuntime,
    });
    Object.defineProperty(worker, 'git', {
      value: {
        ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
        describeCandidate: vi.fn().mockResolvedValue({
          changedPaths: [],
          filePolicy: {},
        }),
        mergeCandidate: vi.fn(async () => {
          publications.requestCancellation({
            taskId: task.id,
            generationId: 'generation-publication-cancel',
            subtaskIds: ['subtask-publication-cancel'],
            decisionId: 'decision-cancel-race',
            now,
          });
          taskEngine.cancel(task.id, 'cancel during merge');
          return {
            type: 'integrated',
            baseCommit: 'base',
            oursCommit: 'ours',
            theirsCommit: 'theirs',
            integrationCommit: 'observed-integration-commit',
            filePolicy: {},
          };
        }),
      },
    });

    const outcomes = await worker.drain(task.id, 'generation-publication-cancel');

    expect(outcomes).toEqual([{
      type: 'cancelled',
      publicationId: 'publication-cancel-race',
      taskId: task.id,
      subtaskId: 'subtask-publication-cancel',
      observedIntegrationCommit: 'observed-integration-commit',
    }]);
    expect(publications.find('publication-cancel-race')).toMatchObject({
      status: 'cancelled',
      integrationCommit: null,
      observedIntegrationCommit: 'observed-integration-commit',
    });
    expect(subtasks.findById('subtask-publication-cancel')).toMatchObject({
      status: 'awaiting_integration',
      result: '',
      artifacts: [],
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({
      count: 0,
    });
    expect(release).toHaveBeenCalledOnce();
  });
});

const now = '2026-07-28T00:00:00.000Z';
