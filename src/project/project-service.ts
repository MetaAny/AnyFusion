import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProjectRepo } from '../storage/project-repo.js';
import type { Project } from './types.js';

const execFileAsync = promisify(execFile);

function isPathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ''
    || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

async function git(args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-c', 'safe.directory=*', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitOrNull(args: string[]): Promise<string | null> {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

async function findNestedGit(root: string, current = root): Promise<string | null> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (current === root && entry.name === '.git') continue;
    if (['node_modules', 'dist', 'coverage', '.cache'].includes(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.name === '.git') return path;
    if (entry.isDirectory()) {
      const nested = await findNestedGit(root, path);
      if (nested) return nested;
    }
  }
  return null;
}

export function defaultProjectPath(): string {
  return join(homedir(), 'AnyFusionProjects', 'default');
}

export class ProjectService {
  constructor(private readonly repo: ProjectRepo) {}

  async resolveProject(inputPath?: string): Promise<Project> {
    const requested = resolve(inputPath?.trim() || defaultProjectPath());
    await mkdir(requested, { recursive: true });
    const rootPath = await realpath(requested);
    const info = await stat(rootPath);
    if (!info.isDirectory()) throw new Error(`project path must be a directory: ${rootPath}`);

    const detectedRoot = await gitOrNull(['-C', rootPath, 'rev-parse', '--show-toplevel']);
    if (detectedRoot) {
      const exactRoot = await realpath(detectedRoot);
      if (exactRoot !== rootPath) {
        throw new Error(`project path must equal the Git top-level directory: ${exactRoot}`);
      }
      await this.rejectAncestorRepository(rootPath);
      await this.validateExistingRepository(rootPath);
    } else {
      await this.rejectAncestorRepository(rootPath);
      const nestedGit = await findNestedGit(rootPath);
      if (nestedGit) throw new Error(`project directory contains a nested Git repository: ${nestedGit}`);
      await this.initializeRepository(rootPath);
    }

    const now = new Date().toISOString();
    const existing = this.repo.findByRootPath(rootPath);
    return this.repo.upsert({
      id: existing?.id ?? `project_${createHash('sha256').update(rootPath).digest('hex').slice(0, 24)}`,
      rootPath,
      mainBranch: 'main',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private async validateExistingRepository(rootPath: string): Promise<void> {
    const branch = await git(['-C', rootPath, 'branch', '--show-current']);
    if (branch !== 'main') throw new Error(`project repository must have main checked out; found ${branch || 'detached HEAD'}`);
    const nestedGit = await findNestedGit(rootPath);
    if (nestedGit) throw new Error(`project repository contains a nested Git repository: ${nestedGit}`);
    const status = await git(['-C', rootPath, 'status', '--porcelain']);
    if (status) throw new Error(`project main worktree must be clean: ${rootPath}`);
    const gitmodules = await gitOrNull(['-C', rootPath, 'ls-files', '--error-unmatch', '.gitmodules']);
    if (gitmodules !== null) throw new Error('project repository cannot contain submodules');
  }

  private async rejectAncestorRepository(rootPath: string): Promise<void> {
    let current = dirname(rootPath);
    while (true) {
      const ancestorRoot = await gitOrNull(['-C', current, 'rev-parse', '--show-toplevel']);
      if (ancestorRoot) {
        const exactAncestor = await realpath(ancestorRoot);
        if (isPathWithin(exactAncestor, rootPath)) {
          throw new Error(`project directory cannot be inside another Git repository: ${exactAncestor}`);
        }
      }
      if (current === dirname(current)) break;
      current = dirname(current);
    }
  }

  private async initializeRepository(rootPath: string): Promise<void> {
    await git(['init', '-b', 'main', rootPath]);
    await git(['-C', rootPath, 'config', 'user.name', 'AnyFusion Runtime']);
    await git(['-C', rootPath, 'config', 'user.email', 'runtime@anyfusion.local']);
    await git(['-C', rootPath, 'add', '-A']);
    await git(['-C', rootPath, 'commit', '--allow-empty', '-m', `chore: initialize ${basename(rootPath)} project`]);
  }
}
