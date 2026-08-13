import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedGitWorkspaceService } from '../../src/execution/managed-git-workspace.js';
import { WorkspacePublicationWorker } from '../../src/execution/workspace-publication-worker.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('WorkspacePublicationWorker', () => {
  it('merges an approved whole branch into main and deletes its worktree', async () => {
    const setupResult = await setup();
    setupResult.publications.markApproved('publication-1', now);

    const outcomes = await setupResult.worker.drain('task-1', 'generation-1');

    expect(outcomes).toEqual([expect.objectContaining({
      type: 'integrated',
      publicationId: 'publication-1',
      taskId: 'task-1',
      subtaskId: 'subtask-1',
    })]);
    expect(await readFile(join(setupResult.project, 'result.txt'), 'utf8')).toBe('candidate\n');
    expect(setupResult.publications.find('publication-1')?.status).toBe('integrated');
    expect(setupResult.subtasks.findById('subtask-1')).toMatchObject({
      status: 'done',
      result: 'approved result',
      artifacts: [join(setupResult.project, 'result.txt')],
    });
    await expect(readFile(join(setupResult.workspace.filesPath, 'result.txt'), 'utf8')).rejects.toThrow();
    await expect(git(setupResult.project, 'rev-parse', '--verify', setupResult.workspace.branch)).rejects.toThrow();
  });

  it('preserves the worktree and returns the Subtask to ready when main is stale', async () => {
    const setupResult = await setup();
    setupResult.publications.markApproved('publication-1', now);
    await writeFile(join(setupResult.project, 'main.txt'), 'main changed\n');
    await git(setupResult.project, 'add', '-A');
    await git(setupResult.project, 'commit', '-m', 'feat: change main');

    const outcomes = await setupResult.worker.drain('task-1', 'generation-1');
    expect(outcomes).toEqual([expect.objectContaining({
      type: 'stale',
      publicationId: 'publication-1',
      taskId: 'task-1',
      subtaskId: 'subtask-1',
      reason: 'Project main changed after publication approval was requested',
      synchronized: expect.objectContaining({
        mainBaseCommit: await git(setupResult.project, 'rev-parse', 'main'),
        changedPaths: ['result.txt'],
      }),
    })]);
    expect(setupResult.publications.find('publication-1')?.status).toBe('parked');
    expect(setupResult.subtasks.findById('subtask-1')?.status).toBe('ready');
    expect(await readFile(join(setupResult.workspace.filesPath, 'result.txt'), 'utf8')).toBe('candidate\n');
    expect(await readFile(join(setupResult.workspace.filesPath, 'main.txt'), 'utf8')).toBe('main changed\n');
    expect(outcomes[0]?.type === 'stale' && outcomes[0].synchronized?.candidateCommit)
      .not.toBe(setupResult.publications.find('publication-1')?.candidateCommit);
    expect(await git(setupResult.workspace.filesPath, 'branch', '--show-current')).toBe(setupResult.workspace.branch);
  });

  it('reuses an already synchronized candidate after a restart recovery', async () => {
    const setupResult = await setup();
    setupResult.publications.markApproved('publication-1', now);
    await writeFile(join(setupResult.project, 'main.txt'), 'main changed\n');
    await git(setupResult.project, 'add', '-A');
    await git(setupResult.project, 'commit', '-m', 'feat: change main');

    await setupResult.worker.drain('task-1', 'generation-1');
    const parked = setupResult.publications.find('publication-1');
    expect(parked?.status).toBe('parked');

    const recovered = await setupResult.worker.synchronizeParked(parked!);
    expect(recovered.synchronized).toMatchObject({
      mainBaseCommit: await git(setupResult.project, 'rev-parse', 'main'),
      changedPaths: ['result.txt'],
    });
    expect(recovered.synchronized?.candidateCommit)
      .not.toBe(parked?.candidateCommit);
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-publication-worker-'));
  roots.push(root);
  const project = join(root, 'project');
  await exec('git', ['init', '-b', 'main', project]);
  await git(project, 'config', 'user.name', 'Test User');
  await git(project, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(project, 'base.txt'), 'base\n');
  await git(project, 'add', '-A');
  await git(project, 'commit', '-m', 'base');

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, 'project-test');
  const taskRuntimeService = new TaskRuntimeService({ taskEngine, taskRepo });
  const task = taskEngine.create({
    id: 'task-1',
    projectId: 'project-test',
    title: 'Publish',
    goal: 'Publish candidate',
  });
  taskEngine.transition(task.id, 'ready');
  taskEngine.transition(task.id, 'running');
  const subtasks = new SubtaskRepo(db);
  subtasks.upsert({
    id: 'subtask-1',
    taskId: task.id,
    graphRevision: 1,
    generationId: 'generation-1',
    title: 'Candidate',
    goal: 'Create result',
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
    createdAt: now,
    updatedAt: now,
  });

  const workspaceStore = new WorkspaceStore(join(root, 'store'));
  const gitService = new ManagedGitWorkspaceService(workspaceStore);
  const workspace = await gitService.ensure({
    taskId: task.id,
    generationId: 'generation-1',
    subtaskId: 'subtask-1',
  }, project);
  await writeFile(join(workspace.filesPath, 'result.txt'), 'candidate\n');
  await git(workspace.filesPath, 'add', '-A');
  await git(workspace.filesPath, 'commit', '-m', 'feat: candidate');
  const candidate = await gitService.validateExecutorCandidate(workspace);

  const publications = new WorkspacePublicationRepo(db);
  publications.insertCandidate({
    id: 'publication-1',
    taskId: task.id,
    generationId: 'generation-1',
    subtaskId: 'subtask-1',
    sourceAttemptId: 'attempt-1',
    agentClassName: 'codex-cli',
    mainBaseCommit: candidate.mainCommit,
    candidateCommit: candidate.candidateCommit,
    permissionRequestId: 'permission-1',
    changedPaths: candidate.changedPaths,
    completion: {
      body: 'approved result',
      artifacts: [join(workspace.filesPath, 'result.txt')],
      warnings: [],
      handoffs: [],
      completionSchemaVersion: 4,
    },
    topologyLayer: 0,
    firstDispatchOrder: 0,
    createdAt: now,
  });

  const worker = new WorkspacePublicationWorker({
    db,
    sourceRoot: project,
    workspaceStore,
    workspaceRepository: {
      findByIdentity: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
    } as never,
    subtaskRepo: subtasks,
    attemptReceiptRepo: {
      findByAttemptId: vi.fn().mockReturnValue({ attemptId: 'attempt-1' }),
    } as never,
    taskRuntimeService,
  });

  return { project, publications, subtasks, workspace, worker };
}

const now = '2026-08-10T00:00:00.000Z';
