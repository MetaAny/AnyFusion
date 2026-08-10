import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedGitWorkspaceService } from '../../src/execution/managed-git-workspace.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function createProject(root: string): Promise<string> {
  const project = join(root, 'project');
  await exec('git', ['init', '-b', 'main', project]);
  await git(project, 'config', 'user.name', 'Test User');
  await git(project, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(project, 'base.txt'), 'base\n');
  await git(project, 'add', '.');
  await git(project, 'commit', '-m', 'base');
  return project;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ManagedGitWorkspaceService', () => {
  it('creates one persistent branch and worktree per Subtask from Project main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-managed-worktree-'));
    roots.push(root);
    const project = await createProject(root);
    const service = new ManagedGitWorkspaceService(new WorkspaceStore(join(root, 'store')));
    const identity = { taskId: 'task-1', generationId: 'generation-1', subtaskId: 'subtask-1' };

    const first = await service.ensure(identity, project);
    const second = await service.ensure(identity, project);

    expect(second.filesPath).toBe(first.filesPath);
    expect(first.branch).toBe('anyfusion/task/task-1/subtask/subtask-1');
    expect(await git(first.filesPath, 'branch', '--show-current')).toBe(first.branch);
    expect(await git(project, 'branch', '--show-current')).toBe('main');
    expect(await git(project, 'status', '--porcelain')).toBe('');
  });

  it('validates a clean Executor commit that contains the current local main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-managed-candidate-'));
    roots.push(root);
    const project = await createProject(root);
    const service = new ManagedGitWorkspaceService(new WorkspaceStore(join(root, 'store')));
    const workspace = await service.ensure({
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
    }, project);

    await writeFile(join(workspace.filesPath, 'result.txt'), 'executor result\n');
    await git(workspace.filesPath, 'add', '-A');
    await git(workspace.filesPath, 'commit', '-m', 'feat: add result');

    await expect(service.validateExecutorCandidate(workspace)).resolves.toMatchObject({
      mainCommit: await git(project, 'rev-parse', 'main'),
      changedPaths: ['result.txt'],
    });
    await expect(readFile(join(project, 'result.txt'), 'utf8')).rejects.toThrow();
  });

  it('rejects uncommitted Executor changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-managed-dirty-'));
    roots.push(root);
    const project = await createProject(root);
    const service = new ManagedGitWorkspaceService(new WorkspaceStore(join(root, 'store')));
    const workspace = await service.ensure({
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
    }, project);
    await writeFile(join(workspace.filesPath, 'result.txt'), 'not committed\n');

    await expect(service.validateExecutorCandidate(workspace))
      .rejects.toThrow('Executor must commit all changes');
  });

  it('promotes the exact approved candidate and removes its branch and worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-managed-promote-'));
    roots.push(root);
    const project = await createProject(root);
    const service = new ManagedGitWorkspaceService(new WorkspaceStore(join(root, 'store')));
    const workspace = await service.ensure({
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
    }, project);
    await writeFile(join(workspace.filesPath, 'result.txt'), 'approved\n');
    await git(workspace.filesPath, 'add', '-A');
    await git(workspace.filesPath, 'commit', '-m', 'feat: approved result');
    const candidate = await service.validateExecutorCandidate(workspace);

    const promoted = await service.promoteCandidate({
      workspace,
      candidateCommit: candidate.candidateCommit,
      approvedMainCommit: candidate.mainCommit,
    });
    expect(await readFile(join(project, 'result.txt'), 'utf8')).toBe('approved\n');
    expect(await git(project, 'rev-parse', 'main')).toBe(promoted.integrationCommit);

    await service.removePublishedWorkspace(workspace);
    await expect(git(project, 'rev-parse', '--verify', workspace.branch)).rejects.toThrow();
    await expect(readFile(join(workspace.filesPath, 'result.txt'), 'utf8')).rejects.toThrow();
  });

  it('rejects an approval when Project main changed after review started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-managed-stale-'));
    roots.push(root);
    const project = await createProject(root);
    const service = new ManagedGitWorkspaceService(new WorkspaceStore(join(root, 'store')));
    const workspace = await service.ensure({
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
    }, project);
    await writeFile(join(workspace.filesPath, 'result.txt'), 'candidate\n');
    await git(workspace.filesPath, 'add', '-A');
    await git(workspace.filesPath, 'commit', '-m', 'feat: candidate');
    const candidate = await service.validateExecutorCandidate(workspace);

    await writeFile(join(project, 'other.txt'), 'main moved\n');
    await git(project, 'add', '-A');
    await git(project, 'commit', '-m', 'feat: move main');

    await expect(service.promoteCandidate({
      workspace,
      candidateCommit: candidate.candidateCommit,
      approvedMainCommit: candidate.mainCommit,
    })).rejects.toThrow('Project main changed after publication approval was requested');
  });
});
