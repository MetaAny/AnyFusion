import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectService, defaultProjectPath } from '../../src/project/project-service.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { ProjectRepo } from '../../src/storage/project-repo.js';

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

function service(): ProjectService {
  const db = new Database(':memory:');
  runMigrations(db);
  return new ProjectService(new ProjectRepo(db));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ProjectService', () => {
  it('uses a default path outside AnyFusion runtime configuration', () => {
    expect(defaultProjectPath()).toMatch(/AnyFusionProjects[/\\]default$/u);
  });

  it('initializes and commits a non-Git directory on main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-project-init-'));
    roots.push(root);
    const projectPath = join(root, 'project');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'input.txt'), 'existing content\n');

    const project = await service().resolveProject(projectPath);

    expect(project.rootPath).toBe(projectPath);
    expect(await git(projectPath, 'branch', '--show-current')).toBe('main');
    expect(await git(projectPath, 'status', '--porcelain')).toBe('');
    expect(await git(projectPath, 'show', 'HEAD:input.txt')).toBe('existing content');
  });

  it('accepts only the exact top-level directory of an existing clean main repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-project-root-'));
    roots.push(root);
    const projectPath = join(root, 'project');
    await exec('git', ['init', '-b', 'main', projectPath]);
    await git(projectPath, 'config', 'user.name', 'Test User');
    await git(projectPath, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(projectPath, 'tracked.txt'), 'tracked\n');
    await git(projectPath, 'add', '-A');
    await git(projectPath, 'commit', '-m', 'base');
    const child = join(projectPath, 'child');
    await mkdir(child);

    await expect(service().resolveProject(projectPath)).resolves.toMatchObject({ rootPath: projectPath });
    await expect(service().resolveProject(child))
      .rejects.toThrow('project path must equal the Git top-level directory');
  });

  it('rejects a new Project directory inside an ancestor repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-project-ancestor-'));
    roots.push(root);
    await exec('git', ['init', '-b', 'main', root]);
    await git(root, 'config', 'user.name', 'Test User');
    await git(root, 'config', 'user.email', 'test@example.invalid');
    await git(root, 'commit', '--allow-empty', '-m', 'base');

    await expect(service().resolveProject(join(root, 'nested')))
      .rejects.toThrow('project path must equal the Git top-level directory');
  });

  it('rejects dirty, non-main, and nested repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-project-invalid-'));
    roots.push(root);
    const dirty = join(root, 'dirty');
    await exec('git', ['init', '-b', 'main', dirty]);
    await git(dirty, 'config', 'user.name', 'Test User');
    await git(dirty, 'config', 'user.email', 'test@example.invalid');
    await git(dirty, 'commit', '--allow-empty', '-m', 'base');
    await writeFile(join(dirty, 'dirty.txt'), 'dirty\n');
    await expect(service().resolveProject(dirty)).rejects.toThrow('must be clean');

    const feature = join(root, 'feature');
    await exec('git', ['init', '-b', 'main', feature]);
    await git(feature, 'config', 'user.name', 'Test User');
    await git(feature, 'config', 'user.email', 'test@example.invalid');
    await git(feature, 'commit', '--allow-empty', '-m', 'base');
    await git(feature, 'switch', '-c', 'feature');
    await expect(service().resolveProject(feature)).rejects.toThrow('must have main checked out');

    const nested = join(root, 'nested');
    await exec('git', ['init', '-b', 'main', nested]);
    await git(nested, 'config', 'user.name', 'Test User');
    await git(nested, 'config', 'user.email', 'test@example.invalid');
    await git(nested, 'commit', '--allow-empty', '-m', 'base');
    await exec('git', ['init', '-b', 'main', join(nested, 'child')]);
    await expect(service().resolveProject(nested)).rejects.toThrow('nested Git repository');
  });
});
