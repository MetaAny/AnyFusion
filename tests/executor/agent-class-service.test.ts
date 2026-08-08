import { describe, expect, it } from 'vitest';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { createTestExecutorRegistrySnapshot } from '../../src/executor/test-executor-registry.js';

describe('AgentClassService registry compatibility projection', () => {
  it('projects Executor values from one registry snapshot without SQLite definitions', () => {
    const snapshot = createTestExecutorRegistrySnapshot();
    const service = new AgentClassService({ snapshot: () => snapshot });

    expect(service.listByKind('planner')).toEqual([]);
    expect(service.listByKind('executor').map(item => item.name)).toEqual(['codex-cli', 'pi-agent']);
    expect(service.findByName('codex-cli')).toMatchObject({
      name: 'codex-cli',
      kind: 'executor',
      capabilities: ['workspace-engineering'],
      runtimeCommand: '/usr/bin/codex',
      permissionProfileId: 'workspace-engineering',
    });
  });

  it('derives recovery safety and evidence affordance from controlled capabilities', () => {
    const snapshot = createTestExecutorRegistrySnapshot();
    const service = new AgentClassService({ snapshot: () => snapshot });

    expect(service.deriveRecoverySafety(['current-web-research'])).toBe('read_only');
    expect(service.deriveRecoverySafety(['workspace-engineering'])).toBe('workspace_reconcilable');
    expect(service.deriveRecoverySafety(['unknown'])).toBe('external_non_idempotent');
    expect(service.supportsExecutionEvidence('codex-cli')).toBe(true);
    expect(service.supportsExecutionEvidence('missing')).toBe(false);
  });

  it('rejects writes because executors.yaml is the only definition authority', () => {
    const snapshot = createTestExecutorRegistrySnapshot();
    const service = new AgentClassService({ snapshot: () => snapshot });

    expect(() => service.upsert(service.findByName('codex-cli')!))
      .toThrow('Executor definitions must be registered through executors.yaml');
  });
});
