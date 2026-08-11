import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutorRegistryService } from '../../src/executor/executor-registry-service.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';
import { ExecutorVerificationRepo } from '../../src/storage/executor-verification-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const originalConfigHome = process.env.ANYFUSION_CONFIG_HOME;
const temporaryRoots: string[] = [];

afterEach(() => {
  if (originalConfigHome === undefined) delete process.env.ANYFUSION_CONFIG_HOME;
  else process.env.ANYFUSION_CONFIG_HOME = originalConfigHome;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ExecutorRegistryService test isolation', () => {
  it('does not load a host-level default registry in tests without an explicit configPath', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'anyfusion-registry-service-test-'));
    temporaryRoots.push(configHome);
    mkdirSync(configHome, { recursive: true });
    writeFileSync(join(configHome, 'executors.yaml'), 'invalid: host-config');
    process.env.ANYFUSION_CONFIG_HOME = configHome;

    const db = new Database(':memory:');
    runMigrations(db);
    try {
      const service = new ExecutorRegistryService({
        verificationRepo: new ExecutorVerificationRepo(db),
        statusRepo: new KernelExecutorStatusRepo(db),
      });

      expect(service.current().planner.executors.map(executor => executor.name)).toEqual([
        'codex-cli',
        'pi-agent',
      ]);
    } finally {
      db.close();
    }
  });
});
