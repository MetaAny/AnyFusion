import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
}));

vi.mock('../../src/executor/executor-registration-service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/executor/executor-registration-service.js')>();
  return {
    ...actual,
    ExecutorRegistrationService: class {
      register = mocks.register;
    },
  };
});

vi.mock('../../src/executor/executor-registry-service.js', () => ({
  ExecutorRegistryService: class {
    current() {
      return {
        profiles: new Map([
          ['codex', {
            id: 'codex',
            displayName: 'Codex CLI',
            discoveryCommands: ['codex'],
            driver: 'codex',
            defaultDescription: 'Repository engineering.',
            suggestedCapabilities: ['workspace-engineering'],
          }],
        ]),
      };
    }
  },
}));

vi.mock('../../src/storage/executor-verification-repo.js', () => ({
  ExecutorVerificationRepo: class {},
}));

vi.mock('../../src/storage/kernel-executor-status-repo.js', () => ({
  KernelExecutorStatusRepo: class {},
}));

import { runExecutorCli } from '../../src/cli/executor-cli.js';

describe('runExecutorCli', () => {
  beforeEach(() => {
    mocks.register.mockReset();
    mocks.register.mockResolvedValue({ version: 'codex-cli 0.146.0' });
  });

  it('uses a dedicated profile without requiring generic session protocol options', async () => {
    await expect(runExecutorCli({
      db: {} as Database.Database,
      command: 'register',
      args: [
        'codex-cli',
        '--profile', 'codex',
        '--binary', '/usr/bin/codex',
        '--home', '/root/.config/anyfusion/codex',
        '--description', 'Repository engineering.',
        '--capabilities', 'workspace-engineering',
        '--use-cases', 'implementation,tests',
      ],
    })).resolves.toContain('registered, verified, enabled, and loaded');

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex-cli',
      profileId: 'codex',
      binding: expect.objectContaining({
        driver: 'codex',
        sessionProtocol: null,
      }),
    }));
  });
});
