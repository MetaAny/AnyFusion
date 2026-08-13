import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';

describe('WorkspacePublicationRepo integrated result query', () => {
  it('returns only integrated publications for selected Tasks in stable completion order', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const tasks = new TaskEngine(new TaskRepo(db), '/tmp/publication-result-query');
    const subtasks = new SubtaskRepo(db);
    const publications = new WorkspacePublicationRepo(db);
    tasks.create({ id: 'task-a', title: 'task-a', goal: 'Complete task-a' });
    createSubtask(subtasks, 'task-a', 'subtask-a-earlier');
    createSubtask(subtasks, 'task-a', 'subtask-a-later');
    createSubtask(subtasks, 'task-a', 'subtask-a-pending');
    createTaskAndSubtask(tasks, subtasks, 'task-b', 'subtask-b');

    insertPublication(publications, 'publication-later', 'task-a', 'subtask-a-later', 'later.md');
    insertPublication(publications, 'publication-earlier', 'task-a', 'subtask-a-earlier', 'earlier.md');
    insertPublication(publications, 'publication-other-task', 'task-b', 'subtask-b', 'other.md');
    insertPublication(publications, 'publication-pending', 'task-a', 'subtask-a-pending', 'pending.md');
    publications.markApproved('publication-later', '2026-08-04T00:00:00.500Z');
    publications.markApplying('publication-later', '2026-08-04T00:00:01.000Z');
    publications.markIntegrated('publication-later', 'commit-later', '2026-08-04T00:00:03.000Z');
    publications.markApproved('publication-earlier', '2026-08-04T00:00:00.500Z');
    publications.markApplying('publication-earlier', '2026-08-04T00:00:01.000Z');
    publications.markIntegrated('publication-earlier', 'commit-earlier', '2026-08-04T00:00:02.000Z');
    publications.markApproved('publication-other-task', '2026-08-04T00:00:00.500Z');
    publications.markApplying('publication-other-task', '2026-08-04T00:00:01.000Z');
    publications.markIntegrated('publication-other-task', 'commit-other', '2026-08-04T00:00:02.000Z');

    const results = publications.listIntegratedByTaskIds(['task-a', 'task-a']);
    expect(results.map(result => result.id)).toEqual(['publication-earlier', 'publication-later']);
    expect(results.map(result => result.originalCompletion.artifacts)).toEqual([['earlier.md'], ['later.md']]);
    expect(publications.listIntegratedByTaskIds([])).toEqual([]);
    db.close();
  });

  it('lists only distinct Feishu sessions that own recoverable publications', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const tasks = new TaskEngine(new TaskRepo(db), '/tmp/publication-recovery-sessions');
    const subtasks = new SubtaskRepo(db);
    const publications = new WorkspacePublicationRepo(db);
    createTaskAndSubtask(tasks, subtasks, 'task-recover', 'subtask-recover');
    createTaskAndSubtask(tasks, subtasks, 'task-complete', 'subtask-complete');
    createTaskAndSubtask(tasks, subtasks, 'task-local', 'subtask-local');

    insertPublication(publications, 'publication-recover', 'task-recover', 'subtask-recover', 'recover.md');
    insertPublication(publications, 'publication-complete', 'task-complete', 'subtask-complete', 'complete.md');
    insertPublication(publications, 'publication-local', 'task-local', 'subtask-local', 'local.md');
    publications.markApproved('publication-complete', '2026-08-04T00:00:01.000Z');
    publications.markApplying('publication-complete', '2026-08-04T00:00:02.000Z');
    publications.markIntegrated('publication-complete', 'commit-complete', '2026-08-04T00:00:03.000Z');

    insertEscalationDecision(db, 'decision-recover-1', 'permission-publication-recover', 'sess_feishu_bbbbbbbbbbbbbbbbbbbbbbbb');
    insertEscalationDecision(db, 'decision-recover-2', 'permission-publication-recover', 'sess_feishu_bbbbbbbbbbbbbbbbbbbbbbbb');
    insertEscalationDecision(db, 'decision-complete', 'permission-publication-complete', 'sess_feishu_aaaaaaaaaaaaaaaaaaaaaaaa');
    insertEscalationDecision(db, 'decision-local', 'permission-publication-local', 'sess_local');

    expect(publications.listRecoverySessionIds('sess_feishu_')).toEqual([
      'sess_feishu_bbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    db.close();
  });
});

function createTaskAndSubtask(
  tasks: TaskEngine,
  subtasks: SubtaskRepo,
  taskId: string,
  subtaskId: string,
): void {
  tasks.create({ id: taskId, title: taskId, goal: `Complete ${taskId}` });
  createSubtask(subtasks, taskId, subtaskId);
}

function createSubtask(subtasks: SubtaskRepo, taskId: string, subtaskId: string): void {
  subtasks.upsert({
    id: subtaskId,
    taskId,
    graphRevision: 1,
    generationId: `generation-${taskId}`,
    title: subtaskId,
    goal: `Complete ${subtaskId}`,
    status: 'awaiting_integration',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    acceptance: [],
    riskLevel: 'low',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  });
}

function insertPublication(
  publications: WorkspacePublicationRepo,
  id: string,
  taskId: string,
  subtaskId: string,
  artifact: string,
): void {
  publications.insertCandidate({
    id,
    taskId,
    generationId: `generation-${taskId}`,
    subtaskId,
    sourceAttemptId: `attempt-${id}`,
    agentClassName: 'codex-cli',
    mainBaseCommit: `main-${id}`,
    candidateCommit: `candidate-${id}`,
    permissionRequestId: `permission-${id}`,
    changedPaths: [artifact],
    completion: {
      body: `Report for ${id}`,
      artifacts: [artifact],
      warnings: [],
      handoffs: [],
      completionSchemaVersion: 4,
    },
    topologyLayer: 0,
    firstDispatchOrder: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
  });
}

function insertEscalationDecision(
  db: Database.Database,
  id: string,
  correlationId: string,
  sessionId: string,
): void {
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, created_at
    ) VALUES (?, 5, ?, 'permission_required', ?, NULL, ?, NULL, NULL, NULL,
      '{}', '{}', '{}', 'escalate_capability', 'test', '2026-08-04T00:00:00.000Z')
  `).run(id, `event-${id}`, correlationId, sessionId);
}
