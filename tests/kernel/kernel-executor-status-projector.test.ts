import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

describe('KernelExecutorStatusProjector', () => {
  it('keeps transient failures as recent facts without making the class unhealthy and bounds history', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelExecutorStatusRepo(db);
    const projector = new KernelExecutorStatusProjector(repo);

    for (let index = 0; index < 4; index += 1) {
      projector.recordExecutionOutcome({
        agentClassName: 'codex-cli', attemptId: `attempt_${index}`, outcome: 'failed',
        failure: { kind: 'network', scope: 'agent_class', code: 'connection_failed', summary: 'network connection timeout' },
        completedAt: `2026-07-16T00:00:0${index}.000Z`,
      });
    }

    const projection = repo.findByAgentClassName('codex-cli');
    expect(projection?.classHealth).toBe('unverified');
    expect(projection?.recentAttempts).toHaveLength(4);
    expect(projection?.recentAttempts[0]).toMatchObject({ failure: { kind: 'network', scope: 'agent_class' } });
    projector.recordExecutionOutcome({
      agentClassName: 'codex-cli', attemptId: 'attempt_3', outcome: 'failed',
      failure: { kind: 'network', scope: 'agent_class', code: 'duplicate', summary: 'duplicate replay' },
    });
    expect(repo.findByAgentClassName('codex-cli')?.recentAttempts).toHaveLength(4);
  });

  it('marks confirmed adapter/configuration faults as class errors and success as healthy', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelExecutorStatusRepo(db);
    const projector = new KernelExecutorStatusProjector(repo);

    projector.recordExecutionOutcome({
      agentClassName: 'codex-cli', attemptId: 'attempt_adapter', outcome: 'failed',
      failure: { kind: 'adapter', scope: 'agent_class', code: 'binding_invalid', summary: 'adapter binding invalid' },
    });
    expect(repo.findByAgentClassName('codex-cli')?.classHealth).toBe('error');
    const attemptsBeforeRecovery = repo.findByAgentClassName('codex-cli')?.recentAttempts;
    const recovery = projector.recordRecoveryCheck({
      agentClassName: 'codex-cli',
      checkId: 'recovery_1',
      trigger: 'planning_cycle',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      outcome: 'recovered',
    });
    expect(recovery?.classHealth).toBe('healthy');
    expect(recovery?.recentAttempts).toEqual(attemptsBeforeRecovery);
    expect(recovery?.recentRecoveryChecks).toMatchObject([
      { checkId: 'recovery_1', outcome: 'recovered', trigger: 'planning_cycle' },
    ]);
    projector.recordExecutionOutcome({ agentClassName: 'codex-cli', attemptId: 'attempt_success', outcome: 'succeeded' });
    expect(repo.findByAgentClassName('codex-cli')?.classHealth).toBe('healthy');
  });

  it('never automatically recovers a disabled class', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new KernelExecutorStatusRepo(db);
    repo.upsert({
      agentClassName: 'codex-cli',
      classHealth: 'disabled',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    const projector = new KernelExecutorStatusProjector(repo);
    expect(projector.recordRecoveryCheck({
      agentClassName: 'codex-cli',
      checkId: 'recovery_disabled',
      trigger: 'manual',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      outcome: 'recovered',
    })?.classHealth).toBe('disabled');
    expect(repo.findByAgentClassName('codex-cli')?.recentRecoveryChecks).toEqual([]);
  });
});
