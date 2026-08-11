import type { AttemptSandboxPort } from './attempt-sandbox.js';
import type { AttemptSandboxPersistenceRecord, AttemptSandboxRepositoryPort } from './repositories.js';

export interface AttemptSandboxReconciliation {
  orphanRuntimeHandles: string[];
  lostAttempts: AttemptSandboxPersistenceRecord[];
  exitedAttempts: AttemptSandboxPersistenceRecord[];
}

/** Reconciles durable worktree attempts with child processes at Runtime startup. */
export class AttemptSandboxReconciler {
  constructor(
    private readonly sandbox: AttemptSandboxPort,
    private readonly repository: AttemptSandboxRepositoryPort,
  ) {}

  async reconcile(input: {
    checkpoint(record: AttemptSandboxPersistenceRecord): Promise<void>;
  }): Promise<AttemptSandboxReconciliation> {
    const managed = await this.sandbox.listManaged();
    const active = this.repository.listActive();
    const managedById = new Map(managed.map(record => [record.runtimeHandle, record]));
    const activeByRuntime = new Map(active.map(record => [record.runtimeHandle, record]));
    const orphanRuntimeHandles: string[] = [];
    const lostAttempts: AttemptSandboxPersistenceRecord[] = [];
    const exitedAttempts: AttemptSandboxPersistenceRecord[] = [];

    for (const runtime of managed) {
      if (activeByRuntime.has(runtime.runtimeHandle)) continue;
      await this.sandbox.stop(runtime.runtimeHandle);
      await this.sandbox.remove(runtime.runtimeHandle);
      orphanRuntimeHandles.push(runtime.runtimeHandle);
    }

    for (const record of active) {
      const runtime = managedById.get(record.runtimeHandle);
      if (!runtime) {
        let cleanupStatus = 'missing';
        let cleanupError: string | null = null;
        if (record.processId !== null) {
          try {
            await this.sandbox.stopProcess(record.processId);
            cleanupStatus = 'terminated';
          } catch (error) {
            cleanupStatus = 'failed';
            cleanupError = error instanceof Error ? error.message : String(error);
          }
        }
        this.repository.update(record.attemptId, {
          status: 'lost', cleanupStatus, cleanupError, updatedAt: new Date().toISOString(),
        });
        lostAttempts.push(record);
        continue;
      }
      await input.checkpoint(record);
      if (runtime.status === 'exited') {
        const now = new Date().toISOString();
        this.repository.update(record.attemptId, {
          status: 'exited', exitCode: runtime.exitCode, resultCollectedAt: now, updatedAt: now,
        });
        exitedAttempts.push(record);
      } else {
        lostAttempts.push(record);
      }
      await this.sandbox.stop(runtime.runtimeHandle);
      await this.sandbox.remove(runtime.runtimeHandle);
      this.repository.update(record.attemptId, {
        status: 'removed', cleanupStatus: 'removed', updatedAt: new Date().toISOString(),
      });
    }
    return { orphanRuntimeHandles, lostAttempts, exitedAttempts };
  }
}
