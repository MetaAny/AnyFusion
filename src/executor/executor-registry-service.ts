import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import type { ExecutorVerificationRepo } from '../storage/executor-verification-repo.js';
import { resolveAnyFusionConfigHome } from '../utils/paths.js';
import { ensureExecutorRegistryConfig, loadExecutorRegistryConfig } from './executor-registry-config.js';
import { createExecutorRegistrySnapshot } from './executor-registry-snapshot.js';
import type { ExecutorRegistrySnapshot } from './executor-registry-types.js';
import { createTestExecutorRegistrySnapshot } from './test-executor-registry.js';

export class ExecutorRegistryService {
  private snapshot: ExecutorRegistrySnapshot;
  private lastReloadError: Error | null = null;

  constructor(private readonly deps: {
    verificationRepo: ExecutorVerificationRepo;
    statusRepo: KernelExecutorStatusRepo;
    configPath?: string;
  }) {
    const configPath = deps.configPath
      ?? resolve(resolveAnyFusionConfigHome(), 'executors.yaml');
    if (!deps.configPath && process.env.NODE_ENV === 'test') {
      this.snapshot = createTestExecutorRegistrySnapshot(configPath);
      return;
    }
    ensureExecutorRegistryConfig(configPath);
    this.snapshot = this.load(configPath);
  }

  current(): ExecutorRegistrySnapshot {
    return this.snapshot;
  }

  reload(): ExecutorRegistrySnapshot {
    try {
      const next = this.load(this.snapshot.configPath);
      this.snapshot = next;
      this.lastReloadError = null;
      return next;
    } catch (error) {
      this.lastReloadError = error as Error;
      throw error;
    }
  }

  getLastReloadError(): Error | null {
    return this.lastReloadError;
  }

  private load(configPath: string): ExecutorRegistrySnapshot {
    const loaded = loadExecutorRegistryConfig(configPath);
    return createExecutorRegistrySnapshot({
      configPath,
      config: loaded.config,
      configDigest: loaded.configDigest,
      verifications: this.deps.verificationRepo.list(),
      statuses: this.deps.statusRepo.list(),
    });
  }
}
