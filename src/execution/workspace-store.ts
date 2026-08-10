import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  chmod,
  chown,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  lstat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type WorkspaceKind = 'git' | 'directory';
export type CheckpointReason = 'attempt_start' | 'explicit' | 'permission_suspended' | 'success' | 'failure' | 'cancelled';

export interface WorkspaceIdentity {
  taskId: string;
  generationId: string;
  subtaskId: string;
}

export interface WorkspaceHandle extends WorkspaceIdentity {
  id: string;
  kind: WorkspaceKind;
  rootPath: string;
  filesPath: string;
  checkpointsPath: string;
}

export interface WorkspaceManifestEntry {
  path: string;
  type: 'file' | 'directory';
  size: number;
  hash: string | null;
  objectUri: string | null;
}

export interface WorkspaceCheckpointManifest {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  attemptId: string | null;
  reason: CheckpointReason;
  createdAt: string;
  entries: WorkspaceManifestEntry[];
}

export interface StoredWorkspaceCheckpoint {
  id: string;
  workspaceId: string;
  manifestPath: string;
  manifestUri: string;
  manifestHash: string;
  manifestSize: number;
  manifest: WorkspaceCheckpointManifest;
}

function safeIdentitySegment(value: string, label: string): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\u0000-\u001f]/u.test(normalized)) {
    throw new Error(`${label} is not a safe workspace identity segment`);
  }
  return normalized;
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== '..'
      && !isAbsolute(pathFromRoot));
}

async function sha256File(path: string): Promise<{ hash: string; size: number }> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  let size = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { hash: hash.digest('hex'), size };
}

export class WorkspaceStore {
  readonly rootPath: string;
  readonly workspacesPath: string;
  readonly objectsPath: string;
  readonly repositoriesPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
    this.workspacesPath = join(this.rootPath, 'workspaces');
    this.objectsPath = join(this.rootPath, 'objects', 'sha256');
    this.repositoriesPath = join(this.rootPath, 'repositories');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.workspacesPath, { recursive: true }),
      mkdir(this.objectsPath, { recursive: true }),
      mkdir(this.repositoriesPath, { recursive: true }),
    ]);
  }

  async ensureWorkspace(identity: WorkspaceIdentity, kind: WorkspaceKind): Promise<WorkspaceHandle> {
    const taskId = safeIdentitySegment(identity.taskId, 'taskId');
    const generationId = safeIdentitySegment(identity.generationId, 'generationId');
    const subtaskId = safeIdentitySegment(identity.subtaskId, 'subtaskId');
    const rootPath = join(this.workspacesPath, taskId, generationId, subtaskId);
    const filesPath = join(rootPath, 'files');
    const checkpointsPath = join(rootPath, 'checkpoints');
    await Promise.all([mkdir(filesPath, { recursive: true }), mkdir(checkpointsPath, { recursive: true })]);
    return {
      id: `workspace:${taskId}:${generationId}:${subtaskId}`,
      taskId,
      generationId,
      subtaskId,
      kind,
      rootPath,
      filesPath,
      checkpointsPath,
    };
  }

  async seedDirectory(workspace: WorkspaceHandle, sourcePath: string): Promise<void> {
    const sourceRoot = await realpath(sourcePath);
    const sourceInfo = await stat(sourceRoot);
    if (!sourceInfo.isDirectory()) throw new Error('workspace seed source must be a directory');
    const managedStoreRoot = await realpath(this.rootPath);
    if (isPathWithin(managedStoreRoot, sourceRoot)) {
      throw new Error('workspace seed source cannot be inside the managed workspace store');
    }
    await this.copyDirectory(sourceRoot, sourceRoot, workspace.filesPath, [managedStoreRoot]);
  }

  async prepareForSandbox(workspace: WorkspaceHandle, uid = 1000, gid = 1000): Promise<void> {
    await this.assertManagedWorkspace(workspace);
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`sandbox workspace rejects symlink: ${path}`);
      if (process.platform !== 'win32') await chown(path, uid, gid);
      const mode = info.isDirectory()
        ? 0o770
        : (info.mode & 0o111) !== 0 ? 0o770 : 0o660;
      await chmod(path, mode);
      if (!info.isDirectory()) return;
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children) {
        if (child.name === '.git') continue;
        await visit(join(path, child.name));
      }
    };
    await visit(workspace.filesPath);
  }

  async createCheckpoint(
    workspace: WorkspaceHandle,
    input: { reason: CheckpointReason; attemptId?: string | null; now?: string },
  ): Promise<StoredWorkspaceCheckpoint> {
    await this.assertManagedWorkspace(workspace);
    const id = `checkpoint_${randomUUID()}`;
    const entries = await this.scanWorkspace(workspace.filesPath);
    const manifest: WorkspaceCheckpointManifest = {
      schemaVersion: 1,
      id,
      workspaceId: workspace.id,
      attemptId: input.attemptId ?? null,
      reason: input.reason,
      createdAt: input.now ?? new Date().toISOString(),
      entries,
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestHash = createHash('sha256').update(bytes).digest('hex');
    const manifestPath = join(workspace.checkpointsPath, `${id}.json`);
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, manifestPath);
    return {
      id,
      workspaceId: workspace.id,
      manifestPath,
      manifestUri: pathToFileURL(manifestPath).href,
      manifestHash,
      manifestSize: bytes.byteLength,
      manifest,
    };
  }

  async restoreCheckpoint(workspace: WorkspaceHandle, manifestPath: string): Promise<void> {
    await this.assertManagedWorkspace(workspace);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkspaceCheckpointManifest;
    if (manifest.workspaceId !== workspace.id || manifest.schemaVersion !== 1) {
      throw new Error('checkpoint does not belong to this workspace');
    }
    await rm(workspace.filesPath, { recursive: true, force: true });
    await mkdir(workspace.filesPath, { recursive: true });
    for (const entry of manifest.entries) {
      const destination = this.resolveWorkspaceRelative(workspace.filesPath, entry.path);
      if (entry.type === 'directory') {
        await mkdir(destination, { recursive: true });
        continue;
      }
      if (!entry.hash) throw new Error(`checkpoint file has no hash: ${entry.path}`);
      const objectPath = this.objectPath(entry.hash);
      const objectInfo = await sha256File(objectPath);
      if (objectInfo.hash !== entry.hash || objectInfo.size !== entry.size) {
        throw new Error(`checkpoint object failed integrity validation: ${entry.path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(objectPath, destination);
    }
  }

  async removeWorkspaceUri(rootUri: string): Promise<void> {
    const target = this.assertFileUriUnder(rootUri, this.workspacesPath, 'workspace cleanup');
    await rm(target, { recursive: true, force: true });
  }

  async removeObjectUri(objectUri: string): Promise<void> {
    const target = this.assertFileUriUnder(objectUri, this.objectsPath, 'CAS cleanup');
    await rm(target, { force: true });
  }

  async removeManagedRepositoryUri(repositoryUri: string): Promise<void> {
    const target = this.assertFileUriUnder(repositoryUri, this.repositoriesPath, 'managed repository cleanup');
    await rm(target, { recursive: true, force: true });
  }

  private async scanWorkspace(rootPath: string): Promise<WorkspaceManifestEntry[]> {
    const entries: WorkspaceManifestEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.name === '.git') continue;
        const absolute = join(directory, child.name);
        const relativePath = relative(rootPath, absolute).split(sep).join('/');
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error(`workspace checkpoint rejects symlink: ${relativePath}`);
        if (info.isDirectory()) {
          entries.push({ path: relativePath, type: 'directory', size: 0, hash: null, objectUri: null });
          await visit(absolute);
          continue;
        }
        if (!info.isFile()) throw new Error(`workspace checkpoint rejects special file: ${relativePath}`);
        const object = await this.storeObject(absolute);
        entries.push({
          path: relativePath,
          type: 'file',
          size: object.size,
          hash: object.hash,
          objectUri: pathToFileURL(object.path).href,
        });
      }
    };
    await visit(rootPath);
    return entries;
  }

  private async storeObject(sourcePath: string): Promise<{ hash: string; size: number; path: string }> {
    const { hash, size } = await sha256File(sourcePath);
    const destination = this.objectPath(hash);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, temporary);
      const copied = await sha256File(temporary);
      if (copied.hash !== hash || copied.size !== size) throw new Error(`CAS staging integrity failure: ${hash}`);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stored = await sha256File(destination);
    if (stored.hash !== hash || stored.size !== size) throw new Error(`CAS object integrity failure: ${hash}`);
    return { hash, size, path: destination };
  }

  private objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('invalid sha256 object key');
    return join(this.objectsPath, hash.slice(0, 2), hash);
  }

  private async copyDirectory(
    sourceRoot: string,
    current: string,
    destinationRoot: string,
    excludedRoots: readonly string[],
  ): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', '.metaclaw'].includes(entry.name)) continue;
      const source = join(current, entry.name);
      if (excludedRoots.some(root => isPathWithin(root, source))) continue;
      const relativePath = relative(sourceRoot, source);
      const destination = this.resolveWorkspaceRelative(destinationRoot, relativePath);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`workspace seed rejects symlink: ${relativePath}`);
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        await this.copyDirectory(sourceRoot, source, destinationRoot, excludedRoots);
      } else if (info.isFile()) {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      } else {
        throw new Error(`workspace seed rejects special file: ${relativePath}`);
      }
    }
  }

  private resolveWorkspaceRelative(root: string, relativePath: string): string {
    const destination = resolve(root, relativePath);
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
      throw new Error('workspace relative path escaped its managed root');
    }
    return destination;
  }

  private async assertManagedWorkspace(workspace: WorkspaceHandle): Promise<void> {
    const expected = resolve(this.workspacesPath, workspace.taskId, workspace.generationId, workspace.subtaskId);
    if (resolve(workspace.rootPath) !== expected || !workspace.filesPath.startsWith(`${expected}${sep}`)) {
      throw new Error('workspace is outside the managed store');
    }
  }

  private assertFileUriUnder(uri: string, allowedRoot: string, label: string): string {
    const target = resolve(fileURLToPath(uri));
    const root = resolve(allowedRoot);
    if (target === root || !target.startsWith(`${root}${sep}`)) {
      throw new Error(`${label} target is outside its managed root`);
    }
    return target;
  }
}
