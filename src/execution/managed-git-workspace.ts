import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceHandle, WorkspaceIdentity, WorkspaceStore } from './workspace-store.js';

const execFileAsync = promisify(execFile);
const PLAIN_SOURCE_EXCLUDED_TOP_LEVEL = new Set([
  '.cache',
  '.git',
  '.metaclaw',
  'coverage',
  'dist',
  'logs',
  'node_modules',
  'workspace-store',
]);

export interface ManagedGitWorkspace extends WorkspaceHandle {
  kind: 'git';
  projectRoot: string;
  repositoryPath: string;
  branch: string;
  sourceCommit: string;
  baselineCommit: string;
  sourceDiffHash: string;
  gitMetadataPath: string;
}

export interface ManagedGitCommit {
  branch: string;
  commit: string;
  changedPaths: string[];
}

export interface ManagedGitRepairCommit extends ManagedGitCommit {
  workspaceCommit: string;
}

export interface ManagedGitCandidateDescription {
  baseCommit: string;
  oursCommit: string;
  theirsCommit: string;
  changedPaths: string[];
  filePolicy: Record<string, 'text' | 'binary'>;
}

export interface ManagedGitRepairPreparation {
  integrationCommit: string;
  conflictPaths: string[];
  filePolicy: Record<string, 'text' | 'binary'>;
  materialsPath: string;
}

export type ManagedGitMergeResult =
  | {
      type: 'integrated';
      baseCommit: string;
      oursCommit: string;
      theirsCommit: string;
      integrationCommit: string;
      changedPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    }
  | {
      type: 'conflicted';
      baseCommit: string;
      oursCommit: string;
      theirsCommit: string;
      conflictPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    };

function safeRefSegment(value: string): string {
  return value.normalize('NFC').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '') || 'unnamed';
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== '..'
      && !isAbsolute(pathFromRoot));
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', withSafeDirectory(args), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Host-side Git controller for Runtime-managed Project branches and approved main promotion. */
export class ManagedGitWorkspaceService {
  readonly repositoriesPath: string;
  private readonly repositoryOperations = new Map<string, Promise<void>>();

  constructor(private readonly store: WorkspaceStore) {
    this.repositoriesPath = join(store.rootPath, 'repositories');
  }

  async detectSource(sourcePath: string): Promise<{ root: string; commit: string } | null> {
    try {
      const root = await realpath(await git(['-C', sourcePath, 'rev-parse', '--show-toplevel']));
      const commit = await git(['-C', root, 'rev-parse', 'HEAD']);
      return { root, commit };
    } catch {
      return null;
    }
  }

  async ensure(identity: WorkspaceIdentity, sourcePath: string): Promise<ManagedGitWorkspace> {
    await this.store.initialize();
    const detectedSource = await this.detectSource(sourcePath);
    if (!detectedSource) throw new Error(`Project path is not a Git repository: ${sourcePath}`);
    const sourceRoot = await realpath(sourcePath);
    if (detectedSource.root !== sourceRoot) {
      throw new Error(`Project path must equal its Git top-level directory: ${detectedSource.root}`);
    }
    const branchAtRoot = await git(['-C', sourceRoot, 'branch', '--show-current']);
    if (branchAtRoot !== 'main') throw new Error(`Project repository must have main checked out; found ${branchAtRoot}`);
    const projectStatus = await git(['-C', sourceRoot, 'status', '--porcelain']);
    if (projectStatus) throw new Error('Project main worktree must be clean before creating a Subtask worktree');
    const sourceCommit = await git(['-C', sourceRoot, 'rev-parse', 'main']);
    const workspace = await this.store.ensureWorkspace(identity, 'git');
    const commonDir = await git(['-C', sourceRoot, 'rev-parse', '--git-common-dir']);
    const repositoryPath = await realpath(resolve(sourceRoot, commonDir));
    const branch = `anyfusion/task/${safeRefSegment(identity.taskId)}/subtask/${safeRefSegment(identity.subtaskId)}`;
    const gitMetadataPath = join(workspace.filesPath, '.git');

    await this.withRepositoryOperation(repositoryPath, async () => {
      if (!(await exists(gitMetadataPath))) {
        await git(['-C', sourceRoot, 'worktree', 'add', '-B', branch, workspace.filesPath, sourceCommit]);
        await git(['-C', workspace.filesPath, 'config', 'user.name', 'AnyFusion Executor']);
        await git(['-C', workspace.filesPath, 'config', 'user.email', 'executor@anyfusion.local']);
        const workspaceCommonDir = await git(['-C', workspace.filesPath, 'rev-parse', '--git-common-dir']);
        const excludePath = resolve(workspace.filesPath, workspaceCommonDir, 'info', 'exclude');
        const existingExclude = await readFile(excludePath, 'utf8').catch(() => '');
        if (!existingExclude.split(/\r?\n/u).includes('.metaclaw/')) {
          await writeFile(excludePath, `${existingExclude.replace(/\s*$/u, '')}\n.metaclaw/\n`, 'utf8');
        }
      }
    });

    const baselineCommit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    const sourceDiffHash = createHash('sha256')
      .update(sourceCommit)
      .digest('hex');
    return {
      ...workspace,
      kind: 'git',
      projectRoot: sourceRoot,
      repositoryPath,
      branch,
      sourceCommit,
      baselineCommit,
      sourceDiffHash,
      gitMetadataPath,
    };
  }

  async validateExecutorCandidate(workspace: ManagedGitWorkspace): Promise<{
    candidateCommit: string;
    mainCommit: string;
    changedPaths: string[];
  }> {
    const actualRoot = await realpath(await git(['-C', workspace.filesPath, 'rev-parse', '--show-toplevel']));
    if (actualRoot !== await realpath(workspace.filesPath)) throw new Error('managed worktree root mismatch');
    const branch = await git(['-C', workspace.filesPath, 'branch', '--show-current']);
    if (branch !== workspace.branch) {
      throw new Error(`Executor must remain on assigned branch ${workspace.branch}; found ${branch || 'detached HEAD'}`);
    }
    const status = await git(['-C', workspace.filesPath, 'status', '--porcelain']);
    if (status) throw new Error('Executor must commit all changes and leave the assigned worktree clean');
    const projectBranch = await git(['-C', workspace.projectRoot, 'branch', '--show-current']);
    if (projectBranch !== 'main') throw new Error(`Project repository must remain on main; found ${projectBranch}`);
    const projectStatus = await git(['-C', workspace.projectRoot, 'status', '--porcelain']);
    if (projectStatus) throw new Error('Project main worktree must remain clean while validating a candidate');
    const mainCommit = await git(['-C', workspace.projectRoot, 'rev-parse', 'main']);
    const candidateCommit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    await git(['-C', workspace.filesPath, 'merge-base', '--is-ancestor', mainCommit, candidateCommit])
      .catch(() => {
        throw new Error('Executor candidate must merge the current local main before completion');
      });
    const changedPaths = splitLines(await git([
      '-C', workspace.filesPath, 'diff', '--name-only', `${mainCommit}..${candidateCommit}`,
    ]));
    return { candidateCommit, mainCommit, changedPaths };
  }

  async promoteCandidate(input: {
    workspace: ManagedGitWorkspace;
    candidateCommit: string;
    approvedMainCommit: string;
  }): Promise<{ integrationCommit: string; changedPaths: string[] }> {
    const projectBranch = await git(['-C', input.workspace.projectRoot, 'branch', '--show-current']);
    if (projectBranch !== 'main') throw new Error(`Project repository must remain on main; found ${projectBranch}`);
    const status = await git(['-C', input.workspace.projectRoot, 'status', '--porcelain']);
    if (status) throw new Error('Project main worktree must be clean before approved publication');
    const currentMain = await git(['-C', input.workspace.projectRoot, 'rev-parse', 'main']);
    if (currentMain !== input.approvedMainCommit) {
      throw new Error('Project main changed after publication approval was requested');
    }
    await git(['-C', input.workspace.projectRoot, 'merge-base', '--is-ancestor', currentMain, input.candidateCommit])
      .catch(() => {
        throw new Error('Approved candidate no longer contains the current local main');
      });
    const changedPaths = splitLines(await git([
      '-C', input.workspace.projectRoot, 'diff', '--name-only', `${currentMain}..${input.candidateCommit}`,
    ]));
    await git([
      '-C', input.workspace.projectRoot, 'merge', '--no-ff', '--no-edit', input.candidateCommit,
    ]);
    return {
      integrationCommit: await git(['-C', input.workspace.projectRoot, 'rev-parse', 'main']),
      changedPaths,
    };
  }

  async synchronizeCandidate(workspace: ManagedGitWorkspace, candidateCommit: string): Promise<{
    mainBaseCommit: string;
    candidateCommit: string;
    changedPaths: string[];
  }> {
    const projectBranch = await git(['-C', workspace.projectRoot, 'branch', '--show-current']);
    if (projectBranch !== 'main') throw new Error(`Project repository must remain on main; found ${projectBranch}`);
    const projectStatus = await git(['-C', workspace.projectRoot, 'status', '--porcelain']);
    if (projectStatus) throw new Error('Project main worktree must be clean before synchronizing a candidate');
    const mainBaseCommit = await git(['-C', workspace.projectRoot, 'rev-parse', 'main']);
    const currentCandidate = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    const containsApprovedCandidate = await git([
      '-C', workspace.filesPath, 'merge-base', '--is-ancestor', candidateCommit, currentCandidate,
    ])
      .then(() => true)
      .catch(() => false);
    if (!containsApprovedCandidate) {
      throw new Error('candidate workspace no longer contains the approved candidate commit');
    }
    const containsMain = await git(['-C', workspace.filesPath, 'merge-base', '--is-ancestor', mainBaseCommit, currentCandidate])
      .then(() => true)
      .catch(() => false);
    if (!containsMain) {
      try {
        await git(['-C', workspace.filesPath, 'merge', '--no-ff', '--no-edit', mainBaseCommit]);
      } catch (error) {
        await git(['-C', workspace.filesPath, 'merge', '--abort']).catch(() => undefined);
        throw new Error(`stale candidate synchronization conflict: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const synchronizedCandidate = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    const changedPaths = splitLines(await git([
      '-C', workspace.filesPath, 'diff', '--name-only', `${mainBaseCommit}..${synchronizedCandidate}`,
    ]));
    return { mainBaseCommit, candidateCommit: synchronizedCandidate, changedPaths };
  }

  async removePublishedWorkspace(workspace: ManagedGitWorkspace): Promise<void> {
    await this.withRepositoryOperation(workspace.repositoryPath, async () => {
      await git(['-C', workspace.projectRoot, 'worktree', 'remove', '--force', workspace.filesPath]);
      await git(['-C', workspace.projectRoot, 'branch', '-D', workspace.branch]);
      await rm(workspace.rootPath, { recursive: true, force: true });
    });
  }

  private async withRepositoryOperation<T>(
    repositoryPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.repositoryOperations.get(repositoryPath) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolveTurn => {
      release = resolveTurn;
    });
    const queued = previous.catch(() => undefined).then(() => turn);
    this.repositoryOperations.set(repositoryPath, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryOperations.get(repositoryPath) === queued) {
        this.repositoryOperations.delete(repositoryPath);
      }
    }
  }

  async commit(workspace: ManagedGitWorkspace, message: string): Promise<ManagedGitCommit> {
    const actualRoot = await realpath(await git(['-C', workspace.filesPath, 'rev-parse', '--show-toplevel']));
    if (actualRoot !== await realpath(workspace.filesPath)) throw new Error('managed worktree root mismatch');
    const actualCommon = resolve(workspace.filesPath, await git(['-C', workspace.filesPath, 'rev-parse', '--git-common-dir']));
    if (await realpath(actualCommon) !== await realpath(workspace.repositoryPath)) {
      throw new Error('managed worktree escaped its repository');
    }
    const changedPaths = (await git(['-C', workspace.filesPath, 'status', '--porcelain']))
      .split(/\r?\n/u).filter(Boolean).map(line => line.slice(3));
    await git(['-C', workspace.filesPath, 'add', '-A']);
    await git(['-C', workspace.filesPath, 'commit', '--allow-empty', '-m', message]);
    const commit = await git(['-C', workspace.filesPath, 'rev-parse', 'HEAD']);
    return { branch: workspace.branch, commit, changedPaths };
  }

  async applyDependencyStates(workspace: ManagedGitWorkspace, commits: string[]): Promise<void> {
    for (const commit of commits) {
      try {
        await git(['-C', workspace.filesPath, 'merge-base', '--is-ancestor', commit, 'HEAD']);
        continue;
      } catch {
        // A non-ancestor direct dependency must be composed explicitly.
      }
      try {
        await git(['-C', workspace.filesPath, 'merge', '--no-ff', '--no-edit', commit]);
      } catch (error) {
        await git(['-C', workspace.filesPath, 'merge', '--abort']).catch(() => undefined);
        throw new Error(`workspace_state_conflict:${commit}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async mergeCandidate(
    integrationWorkspace: ManagedGitWorkspace,
    candidateCommit: string,
  ): Promise<ManagedGitMergeResult> {
    const candidate = await this.describeCandidate(integrationWorkspace, candidateCommit);
    const { baseCommit, oursCommit, theirsCommit } = candidate;
    try {
      await git(['-C', integrationWorkspace.filesPath, 'merge', '--no-ff', '--no-edit', theirsCommit]);
      const integrationCommit = await git(['-C', integrationWorkspace.filesPath, 'rev-parse', 'HEAD']);
      const changedPaths = splitLines(await git([
        '-C', integrationWorkspace.filesPath, 'diff', '--name-only', `${oursCommit}..${integrationCommit}`,
      ]));
      return {
        type: 'integrated',
        baseCommit,
        oursCommit,
        theirsCommit,
        integrationCommit,
        changedPaths,
        filePolicy: await this.classifyPaths(integrationWorkspace.filesPath, theirsCommit, changedPaths),
      };
    } catch (error) {
      const conflictPaths = splitLines(await git([
        '-C', integrationWorkspace.filesPath, 'diff', '--name-only', '--diff-filter=U',
      ]));
      const filePolicy = await this.classifyPaths(
        integrationWorkspace.filesPath,
        theirsCommit,
        conflictPaths,
      );
      await git(['-C', integrationWorkspace.filesPath, 'merge', '--abort']).catch(() => undefined);
      if (conflictPaths.length === 0) throw error;
      return {
        type: 'conflicted',
        baseCommit,
        oursCommit,
        theirsCommit,
        conflictPaths,
        filePolicy,
      };
    }
  }

  async describeCandidate(
    integrationWorkspace: ManagedGitWorkspace,
    candidateCommit: string,
  ): Promise<ManagedGitCandidateDescription> {
    const oursCommit = await git(['-C', integrationWorkspace.filesPath, 'rev-parse', 'HEAD']);
    const theirsCommit = await git(['-C', integrationWorkspace.filesPath, 'rev-parse', candidateCommit]);
    const baseCommit = await git(['-C', integrationWorkspace.filesPath, 'merge-base', oursCommit, theirsCommit]);
    const changedPaths = splitLines(await git([
      '-C', integrationWorkspace.filesPath, 'diff', '--name-only', `${baseCommit}..${theirsCommit}`,
    ]));
    return {
      baseCommit,
      oursCommit,
      theirsCommit,
      changedPaths,
      filePolicy: await this.classifyPaths(integrationWorkspace.filesPath, theirsCommit, changedPaths),
    };
  }

  async prepareMergeRepair(input: {
    candidateWorkspace: ManagedGitWorkspace;
    integrationWorkspace: ManagedGitWorkspace;
    candidateCommit: string;
    expectedConflictPaths: string[];
    filePolicy: Record<string, 'text' | 'binary'>;
  }): Promise<ManagedGitRepairPreparation> {
    await git(['-C', input.candidateWorkspace.filesPath, 'merge', '--abort']).catch(() => undefined);
    await git(['-C', input.candidateWorkspace.filesPath, 'reset', '--hard', input.candidateCommit]);
    const integrationCommit = await git(['-C', input.integrationWorkspace.filesPath, 'rev-parse', 'HEAD']);
    try {
      await git([
        '-C', input.candidateWorkspace.filesPath, 'merge', '--no-ff', '--no-edit', integrationCommit,
      ]);
      throw new Error('merge repair was authorized but the candidate no longer conflicts');
    } catch (error) {
      const conflictPaths = splitLines(await git([
        '-C', input.candidateWorkspace.filesPath, 'diff', '--name-only', '--diff-filter=U',
      ]));
      if (conflictPaths.length === 0) throw error;
      const expected = [...input.expectedConflictPaths].sort();
      if (conflictPaths.join('\0') !== expected.join('\0')) {
        await git(['-C', input.candidateWorkspace.filesPath, 'merge', '--abort']).catch(() => undefined);
        throw new Error(
          `merge repair conflict set changed: expected ${expected.join(', ')}, got ${conflictPaths.join(', ')}`,
        );
      }
      const materialsPath = join(input.candidateWorkspace.filesPath, '.metaclaw', 'merge-repair');
      for (const path of conflictPaths) {
        for (const [stage, suffix] of [['1', 'base'], ['2', 'ours'], ['3', 'theirs']] as const) {
          const target = join(materialsPath, `${path}.${suffix}`);
          await mkdir(dirname(target), { recursive: true });
          const content = await gitBuffer([
            '-C', input.candidateWorkspace.filesPath, 'show', `:${stage}:${path}`,
          ]).catch(() => Buffer.alloc(0));
          await writeFile(target, content);
          await chmod(target, 0o444).catch(() => undefined);
        }
      }
      return {
        integrationCommit,
        conflictPaths,
        filePolicy: input.filePolicy,
        materialsPath,
      };
    }
  }

  async commitMergeRepair(input: {
    workspace: ManagedGitWorkspace;
    allowedPaths: string[];
    filePolicy: Record<string, 'text' | 'binary'>;
    reportedResolvedPaths: string[];
  }): Promise<ManagedGitRepairCommit> {
    const allowed = [...new Set(input.allowedPaths)].sort();
    const reported = [...new Set(input.reportedResolvedPaths)].sort();
    if (allowed.join('\0') !== reported.join('\0')) {
      throw new Error(`merge repair report does not cover exactly the authorized paths: ${reported.join(', ')}`);
    }
    const unstaged = splitLines(await git([
      '-C', input.workspace.filesPath, 'diff', '--name-only',
    ]));
    const untracked = splitLines(await git([
      '-C', input.workspace.filesPath, 'ls-files', '--others', '--exclude-standard',
    ])).filter(path => !path.startsWith('.metaclaw/'));
    const outside = [...new Set([...unstaged, ...untracked])].filter(path => !allowed.includes(path));
    if (outside.length > 0) {
      throw new Error(`merge repair changed paths outside the authorized conflict set: ${outside.join(', ')}`);
    }
    for (const path of allowed) {
      if (input.filePolicy[path] !== 'text') continue;
      const content = await readFile(join(input.workspace.filesPath, path), 'utf8');
      if (/^(?:<{7}|={7}|>{7})(?:\s|$)/mu.test(content)) {
        throw new Error(`merge repair left conflict markers in ${path}`);
      }
    }
    await git(['-C', input.workspace.filesPath, 'add', '--', ...allowed]);
    const unmerged = splitLines(await git([
      '-C', input.workspace.filesPath, 'diff', '--name-only', '--diff-filter=U',
    ]));
    if (unmerged.length > 0) throw new Error(`merge repair left unmerged entries: ${unmerged.join(', ')}`);
    const originalCandidateCommit = await git([
      '-C', input.workspace.filesPath, 'rev-parse', 'HEAD',
    ]);
    await git(['-C', input.workspace.filesPath, 'commit', '--no-edit']);
    const commit = await git(['-C', input.workspace.filesPath, 'rev-parse', 'HEAD']);
    await git([
      '-C', input.workspace.filesPath, 'update-ref',
      `refs/metaclaw/publications/${commit}`, commit,
    ]);

    await git(['-C', input.workspace.filesPath, 'reset', '--hard', originalCandidateCommit]);
    for (const path of allowed) {
      const existsInRepair = await git([
        '-C', input.workspace.filesPath, 'cat-file', '-e', `${commit}:${path}`,
      ]).then(() => true).catch(() => false);
      if (existsInRepair) {
        await git(['-C', input.workspace.filesPath, 'checkout', commit, '--', path]);
      } else {
        await git(['-C', input.workspace.filesPath, 'rm', '--ignore-unmatch', '--', path]);
      }
    }
    await git(['-C', input.workspace.filesPath, 'add', '-A', '--', ...allowed]);
    await git([
      '-C', input.workspace.filesPath, 'commit', '--allow-empty',
      '-m', 'fix: project merge repair without integration ancestry',
    ]);
    const workspaceCommit = await git(['-C', input.workspace.filesPath, 'rev-parse', 'HEAD']);
    return {
      branch: input.workspace.branch,
      commit,
      workspaceCommit,
      changedPaths: allowed,
    };
  }

  private async importPlainSource(
    sourceRoot: string,
    repositoryPath: string,
    excludedRoots: readonly string[],
  ): Promise<void> {
    // The managed repository can be nested under the source directory (for
    // example, when AnyFusion is launched from $HOME). Stage outside the source
    // tree and exclude Runtime state to prevent recursive or live-file imports.
    const importRoot = await mkdtemp(join(tmpdir(), 'anyfusion-plain-import-'));
    try {
      await this.copyPlainSource(sourceRoot, sourceRoot, importRoot, excludedRoots);
      await git(['init'], importRoot);
      await git(['-C', importRoot, 'config', 'user.name', 'MetaClaw Runtime']);
      await git(['-C', importRoot, 'config', 'user.email', 'runtime@metaclaw.local']);
      await git(['-C', importRoot, 'add', '-A']);
      await git(['-C', importRoot, 'commit', '--allow-empty', '-m', 'chore: import task generation source']);
      await git(['clone', '--bare', '--no-hardlinks', importRoot, repositoryPath]);
    } finally {
      await rm(importRoot, { recursive: true, force: true });
    }
  }

  private async copyPlainSource(
    sourceRoot: string,
    current: string,
    destinationRoot: string,
    excludedRoots: readonly string[],
  ): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const source = join(current, entry.name);
      if (excludedRoots.some(root => isPathWithin(root, source))) continue;
      const pathFromSource = relative(sourceRoot, source);
      const topLevel = pathFromSource.split(/[\\/]/u)[0] ?? '';
      if (PLAIN_SOURCE_EXCLUDED_TOP_LEVEL.has(topLevel)) continue;
      const info = await lstat(source);
      const destination = resolve(destinationRoot, pathFromSource);
      if (destination !== destinationRoot && !destination.startsWith(`${destinationRoot}${sep}`)) {
        throw new Error('plain source import escaped its staging root');
      }
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        await this.copyPlainSource(sourceRoot, source, destinationRoot, excludedRoots);
      } else if (info.isFile()) {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
    }
  }

  private async classifyPaths(
    workspacePath: string,
    commit: string,
    paths: readonly string[],
  ): Promise<Record<string, 'text' | 'binary'>> {
    const policies: Record<string, 'text' | 'binary'> = {};
    for (const path of paths) {
      const attributes = await git([
        '-C', workspacePath, 'check-attr', 'binary', 'text', 'merge', '--', path,
      ]).catch(() => '');
      if (/:\s+binary:\s+set(?:\r?\n|$)/u.test(attributes)
        || /:\s+merge:\s+binary(?:\r?\n|$)/u.test(attributes)) {
        policies[path] = 'binary';
        continue;
      }
      if (/:\s+binary:\s+unset(?:\r?\n|$)/u.test(attributes)
        || /:\s+text:\s+set(?:\r?\n|$)/u.test(attributes)) {
        policies[path] = 'text';
        continue;
      }
      if (/\.(?:avif|bmp|db|docx?|gif|ico|jpe?g|m4a|mov|mp3|mp4|pdf|png|pptx?|sqlite3?|tiff?|wav|webm|webp|xlsx?)$/iu.test(path)) {
        policies[path] = 'binary';
        continue;
      }
      const content = await execFileAsync(
        'git',
        ['-C', workspacePath, 'show', `${commit}:${path}`],
        { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 },
      ).then(result => Buffer.from(result.stdout)).catch(() => Buffer.alloc(0));
      policies[path] = content.includes(0) ? 'binary' : 'text';
    }
    return policies;
  }
}

async function gitBuffer(args: string[]): Promise<Buffer> {
  const result = await execFileAsync('git', withSafeDirectory(args), {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return Buffer.from(result.stdout);
}

function withSafeDirectory(args: string[]): string[] {
  const directoryIndex = args.indexOf('-C');
  const directory = directoryIndex >= 0 ? args[directoryIndex + 1] : null;
  return directory
    ? ['-c', `safe.directory=${resolve(directory)}`, ...args]
    : args;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}
