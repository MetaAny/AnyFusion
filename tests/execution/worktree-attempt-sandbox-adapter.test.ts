import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTEMPT_SANDBOX_LIMITS } from '../../src/execution/attempt-sandbox.js';
import { WorktreeAttemptSandboxAdapter } from '../../src/execution/worktree-attempt-sandbox-adapter.js';

describe('WorktreeAttemptSandboxAdapter', () => {
  it('runs a process in the writable worktree and collects its receipt output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-worktree-attempt-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const adapter = new WorktreeAttemptSandboxAdapter();
    const outputPath = join(workspace, 'result.txt');
    const record = await adapter.create({
      attemptId: 'attempt-1', taskId: 'task-1', generationId: 'generation-1', subtaskId: 'subtask-1',
      workUnitId: 'work-unit-1', leaseToken: 'lease-1', idempotencyKey: 'dispatch-1',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, 'done'); console.log('completed')`],
      environment: {}, egressMode: 'disabled',
      limits: DEFAULT_ATTEMPT_SANDBOX_LIMITS,
      mounts: [{ source: workspace, target: '/workspace', mode: 'rw' }],
    });

    try {
      expect(adapter.kind).toBe('worktree');
      expect(adapter.pathMode).toBe('native');
      expect(record.status).toBe('created');
      const running = await adapter.start(record.runtimeHandle);
      expect(running.processId).toBeTypeOf('number');
      expect(await adapter.wait(record.runtimeHandle)).toBe(0);
      expect(await readFile(outputPath, 'utf8')).toBe('done');
      expect(await adapter.logs(record.runtimeHandle)).toContain('completed');
      expect((await adapter.inspect(record.runtimeHandle))?.status).toBe('exited');
      await adapter.remove(record.runtimeHandle);
      expect(await adapter.inspect(record.runtimeHandle)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops a running Executor process and its process group during Runtime shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-worktree-stop-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const adapter = new WorktreeAttemptSandboxAdapter();
    const record = await adapter.create({
      attemptId: 'attempt-stop', taskId: 'task-stop', generationId: 'generation-stop', subtaskId: 'subtask-stop',
      workUnitId: 'work-unit-stop', leaseToken: 'lease-stop', idempotencyKey: 'dispatch-stop',
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 60_000)'],
      environment: {}, egressMode: 'disabled',
      limits: DEFAULT_ATTEMPT_SANDBOX_LIMITS,
      mounts: [{ source: workspace, target: '/workspace', mode: 'rw' }],
    });

    try {
      const running = await adapter.start(record.runtimeHandle);
      expect(running.processId).toBeTypeOf('number');
      await adapter.stop(record.runtimeHandle);
      expect((await adapter.inspect(record.runtimeHandle))?.status).toBe('exited');
      expect(() => process.kill(running.processId!, 0)).toThrow();
      await adapter.remove(record.runtimeHandle);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
