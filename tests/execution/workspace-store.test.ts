import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';

describe('WorkspaceStore', () => {
  let temporaryRoot = '';

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'metaclaw-workspace-store-'));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test('persists a workspace across attempts and deduplicates objects by hash', async () => {
    const source = join(temporaryRoot, 'source');
    await mkdir(source);
    await writeFile(join(source, 'a.txt'), 'same content');
    await writeFile(join(source, 'b.txt'), 'same content');
    const store = new WorkspaceStore(join(temporaryRoot, 'store'));
    await store.initialize();
    const workspace = await store.ensureWorkspace({ taskId: 't1', generationId: 'g1', subtaskId: 's1' }, 'directory');
    await store.seedDirectory(workspace, source);
    const checkpoint = await store.createCheckpoint(workspace, { reason: 'attempt_start', attemptId: 'a1', now: '2026-07-22T00:00:00.000Z' });
    const files = checkpoint.manifest.entries.filter(entry => entry.type === 'file');
    expect(files).toHaveLength(2);
    expect(new Set(files.map(entry => entry.hash)).size).toBe(1);

    await writeFile(join(workspace.filesPath, 'a.txt'), 'changed');
    await store.restoreCheckpoint(workspace, checkpoint.manifestPath);
    expect(await readFile(join(workspace.filesPath, 'a.txt'), 'utf8')).toBe('same content');
  });

  test('rejects workspace identity traversal', async () => {
    const store = new WorkspaceStore(join(temporaryRoot, 'store'));
    await expect(store.ensureWorkspace({ taskId: '..', generationId: 'g', subtaskId: 's' }, 'directory')).rejects.toThrow();
  });

  test('skips the managed store when it is nested inside the source directory', async () => {
    const source = join(temporaryRoot, 'source');
    await mkdir(source);
    await writeFile(join(source, 'input.txt'), 'task input');
    const store = new WorkspaceStore(join(source, '.local', 'share', 'anyfusion', 'workspace-store'));
    await store.initialize();
    const workspace = await store.ensureWorkspace({ taskId: 't1', generationId: 'g1', subtaskId: 's1' }, 'directory');

    await store.seedDirectory(workspace, source);

    expect(await readFile(join(workspace.filesPath, 'input.txt'), 'utf8')).toBe('task input');
    await expect(readFile(
      join(workspace.filesPath, '.local', 'share', 'anyfusion', 'workspace-store', 'workspaces'),
      'utf8',
    )).rejects.toThrow();
  });
});
