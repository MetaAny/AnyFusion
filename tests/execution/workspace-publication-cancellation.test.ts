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
  it('cancels an approved publication without touching Git when Task cancellation already won', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-cancel');
    const taskRuntime = new TaskRuntimeService({ taskEngine, taskRepo: new TaskRepo(db) });
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
      id: 'publication-cancel',
      taskId: task.id,
      generationId: 'generation-publication-cancel',
      subtaskId: 'subtask-publication-cancel',
      sourceAttemptId: 'attempt-source',
      agentClassName: 'codex-cli',
      mainBaseCommit: 'main-commit',
      candidateCommit: 'candidate-commit',
      permissionRequestId: 'permission-cancel',
      changedPaths: [],
      completion: {
        body: 'must not become visible',
        artifacts: [],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 3,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    publications.markApproved('publication-cancel', now);
    taskEngine.cancel(task.id, 'cancel before publication');
    const worker = new WorkspacePublicationWorker({
      db,
      sourceRoot: '/tmp/source',
      workspaceStore: { rootPath: '/tmp/workspace-publication-test' } as never,
      workspaceRepository: { findByIdentity: vi.fn().mockReturnValue(null) } as never,
      subtaskRepo: subtasks,
      attemptReceiptRepo: { findByAttemptId: vi.fn() } as never,
      taskRuntimeService: taskRuntime,
    });
    const ensure = vi.fn();
    Object.defineProperty(worker, 'git', { value: { ensure } });

    await expect(worker.drain(task.id, 'generation-publication-cancel')).resolves.toEqual([{
      type: 'cancelled',
      publicationId: 'publication-cancel',
      taskId: task.id,
      subtaskId: 'subtask-publication-cancel',
      observedIntegrationCommit: null,
    }]);
    expect(publications.find('publication-cancel')?.status).toBe('cancelled');
    expect(ensure).not.toHaveBeenCalled();
  });
});

const now = '2026-08-10T00:00:00.000Z';
