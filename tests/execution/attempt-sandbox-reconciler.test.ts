import { describe, expect, it, vi } from 'vitest';
import { AttemptSandboxReconciler } from '../../src/execution/attempt-sandbox-reconciler.js';
import type { AttemptSandboxPersistenceRecord, AttemptSandboxRepositoryPort } from '../../src/execution/repositories.js';
import type { AttemptSandboxPort } from '../../src/execution/attempt-sandbox.js';

function persisted(attemptId: string, runtimeHandle: string, processId: number | null = null): AttemptSandboxPersistenceRecord {
  return {
    attemptId, taskId: 'task', generationId: 'gen', subtaskId: 'subtask', workUnitId: 'worker',
    workspaceId: 'workspace', runtimeHandle, processId, status: 'running',
    leaseToken: 'lease', labels: {}, exitCode: null, resultCollectedAt: null, cleanupStatus: null,
    cleanupError: null, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

describe('AttemptSandboxReconciler', () => {
  it('removes orphans and marks missing durable sandboxes lost', async () => {
    const active = persisted('attempt-lost', 'missing-runtime', 456);
    const updates: Array<[string, unknown]> = [];
    const repository = {
      listActive: () => [active],
      find: vi.fn(), findByRuntimeHandle: vi.fn(), create: vi.fn(),
      update: (id: string, changes: unknown) => { updates.push([id, changes]); },
    } as unknown as AttemptSandboxRepositoryPort;
    const sandbox = {
      listManaged: vi.fn().mockResolvedValue([{
        runtimeHandle: 'orphan', processId: 123, status: 'running', exitCode: null,
        labels: { 'io.metaclaw.attempt-id': 'unknown' },
      }]),
      stop: vi.fn(), stopProcess: vi.fn(), remove: vi.fn(),
    } as unknown as AttemptSandboxPort;
    const result = await new AttemptSandboxReconciler(sandbox, repository).reconcile({ checkpoint: vi.fn() });

    expect(result.orphanRuntimeHandles).toEqual(['orphan']);
    expect(result.lostAttempts).toEqual([active]);
    expect(updates).toEqual([['attempt-lost', expect.objectContaining({ status: 'lost', cleanupStatus: 'terminated' })]]);
    expect(sandbox.stopProcess).toHaveBeenCalledWith(456);
    expect(sandbox.stop).toHaveBeenCalledWith('orphan');
    expect(sandbox.remove).toHaveBeenCalledWith('orphan');
  });

  it('checkpoints and destroys a crash-left paused container', async () => {
    const active = persisted('attempt-paused', 'paused-container');
    const checkpoint = vi.fn();
    const repository = {
      listActive: () => [active], find: vi.fn(), findByRuntimeHandle: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as unknown as AttemptSandboxRepositoryPort;
    const sandbox = {
      listManaged: vi.fn().mockResolvedValue([{
        runtimeHandle: 'paused-container', processId: 789, status: 'paused', exitCode: null, labels: {},
      }]), stop: vi.fn(), stopProcess: vi.fn(), remove: vi.fn(),
    } as unknown as AttemptSandboxPort;
    const result = await new AttemptSandboxReconciler(sandbox, repository).reconcile({ checkpoint });

    expect(checkpoint).toHaveBeenCalledWith(active);
    expect(result.lostAttempts).toEqual([active]);
    expect(repository.update).toHaveBeenLastCalledWith('attempt-paused', expect.objectContaining({ status: 'removed' }));
  });
});
