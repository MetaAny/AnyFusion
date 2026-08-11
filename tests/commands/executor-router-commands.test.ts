import { describe, expect, it } from 'vitest';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { createTestExecutorRegistrySnapshot } from '../../src/executor/test-executor-registry.js';

function createContext() {
  const snapshot = createTestExecutorRegistrySnapshot();
  return {
    executorRegistry: {
      digest: () => snapshot.configDigest,
      list: () => snapshot.tui,
      discover: async () => [],
      verify: async () => snapshot.verifications.get('codex-cli'),
      setEnabled: async () => undefined,
      reload: () => snapshot,
      register: async () => snapshot.verifications.get('codex-cli'),
    },
  } as any;
}

describe('executor registry commands', () => {
  it('lists Executor registry projection from the command surface', async () => {
    const context = createContext();
    const catalog = createDefaultCommandCatalog();

    const initial = await catalog.execute('/executor list', context);
    expect(initial.content).toContain('Executor registry digest:');
    expect(initial.content).toContain('codex-cli');
    expect(initial.content).toContain('enabled / verified');
    expect(initial.content).toContain('driver=codex');
    expect(initial.content).toContain('binary=/usr/bin/codex');
  });

  it('exposes unified registration and rejects the removed unregister command', async () => {
    const context = createContext();
    const catalog = createDefaultCommandCatalog();

    expect((await catalog.execute('/executor register wizard', context)).content)
      .toContain('Usage: /executor register <id>');
    expect((await catalog.execute('/executor unregister codex-cli', context)).content)
      .toContain('未知命令');
  });

  it('rejects legacy registration options without a compatibility translation', async () => {
    const context = createContext();
    const catalog = createDefaultCommandCatalog();

    expect((await catalog.execute('/executor register codex-cli --command custom', context)).content)
      .toContain('未知选项: --command');
  });
});
