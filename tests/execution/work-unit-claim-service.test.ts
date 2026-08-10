import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import type { WorkUnit } from '../../src/core/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function workUnit(): WorkUnit {
  return {
    id: 'executor-1',
    agentClassName: 'codex-cli',
    agentClassKind: 'executor',
    state: 'idle',
    claimedTaskId: null,
    claimedSubtaskId: null,
    claimedAttemptId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

describe('WorkUnitClaimService', () => {
  it('claims and releases an idle executor work unit', async () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);
    repo.upsert(workUnit());

    const claim = await new WorkUnitClaimService(repo).claim({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['codex-cli'],
      },
    });

    expect(claim?.workUnit.id).toBe('executor-1');
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'claimed',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
      claimedAttemptId: 'attempt_1',
    });

    claim?.markRunning();
    expect(repo.findById('executor-1')?.state).toBe('running');

    claim?.release();
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'idle',
      claimedTaskId: null,
      claimedSubtaskId: null,
      claimedAttemptId: null,
    });
    expect(repo.listEvents('executor-1').map(event => event.eventType)).toEqual([
      'claimed',
      'running',
      'released',
    ]);
    expect(repo.listEvents('executor-1').at(-1)).toMatchObject({
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      eventType: 'released',
    });
  });

  it('marks expired claimed work units as heartbeat_lost', () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);
    repo.upsert({
      ...workUnit(),
      state: 'running',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
      claimedAttemptId: 'attempt_1',
      leaseExpiresAt: '2026-07-02T00:00:00.000Z',
    });

    const lost = new WorkUnitClaimService(repo).sweepExpired(new Date('2026-07-02T00:01:00.000Z'));

    expect(lost).toHaveLength(1);
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'heartbeat_lost',
      claimedTaskId: null,
      claimedSubtaskId: null,
    });
    expect(lost[0]).toMatchObject({
      state: 'heartbeat_lost',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
    });
  });

  it('does not let a stale attempt release a WorkUnit that has been claimed by another attempt', async () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);
    repo.upsert(workUnit());
    const claim = await new WorkUnitClaimService(repo).claim({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['codex-cli'],
      },
    });
    repo.updateState('executor-1', 'running', {
      claimedTaskId: 'task_2',
      claimedSubtaskId: 'subtask_2',
      claimedAttemptId: 'attempt_2',
    });

    claim?.release();

    expect(repo.findById('executor-1')).toMatchObject({
      state: 'running',
      claimedTaskId: 'task_2',
      claimedSubtaskId: 'subtask_2',
      claimedAttemptId: 'attempt_2',
    });
    expect(repo.listEvents('executor-1').at(-1)).toMatchObject({
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      eventType: 'release_skipped_stale',
      state: 'running',
    });
  });

  it('enforces one active attempt per Subtask at the database boundary', () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);
    repo.upsert(workUnit());
    repo.upsert({ ...workUnit(), id: 'executor-2' });
    repo.updateState('executor-1', 'running', {
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
      claimedAttemptId: 'attempt_1',
    });
    expect(() => repo.updateState('executor-2', 'claimed', {
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
      claimedAttemptId: 'attempt_2',
    })).toThrow();
  });

  it('provisions and claims an executor only after a successful runtime probe', async () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);
    const probe = vi.fn().mockResolvedValue(true);

    const claim = await new WorkUnitClaimService(repo, 60_000, probe).claim({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['codex-cli'],
      },
    });

    expect(probe).toHaveBeenCalledWith('codex-cli', 'claim');
    expect(claim?.workUnit).toMatchObject({ agentClassName: 'codex-cli', state: 'claimed' });
    expect(repo.listEvents(claim!.workUnit.id).map(event => event.eventType)).toEqual([
      'probe_started',
      'probe_succeeded',
      'claimed',
    ]);
  });

  it('falls back through planner candidates and preserves failed probes', async () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);
    const probe = vi.fn(async (name: string) => name === 'second-executor');

    const claim = await new WorkUnitClaimService(repo, 60_000, probe).claim({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['first-executor', 'second-executor'],
      },
    });

    expect(probe.mock.calls.map(call => call[0])).toEqual(['first-executor', 'second-executor']);
    expect(claim?.workUnit.agentClassName).toBe('second-executor');
    expect(repo.findAll()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentClassName: 'first-executor', state: 'failed' }),
      expect.objectContaining({ agentClassName: 'second-executor', state: 'claimed' }),
    ]));
  });

  it('returns no claim when every planned executor probe fails', async () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);

    const claim = await new WorkUnitClaimService(repo, 60_000, async () => false).claim({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['first-executor', 'second-executor'],
      },
    });

    expect(claim).toBeNull();
    expect(repo.findAll().filter(unit => unit.agentClassKind === 'executor').map(unit => unit.state))
      .toEqual(['failed', 'failed']);
  });

  it('persists the concrete executor probe error for later diagnostics', async () => {
    const db = createDb();
    const repo = new WorkUnitRepo(db);

    const claim = await new WorkUnitClaimService(repo, 60_000, async () => {
      throw new Error(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock; '
        + 'OPENAI_API_KEY=sk-not-for-planner',
      );
    }).claim({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['codex-cli'],
      },
    });

    expect(claim).toBeNull();
    const failed = repo.findAll().find(unit => unit.state === 'failed');
    expect(failed).toBeDefined();
    expect(repo.listEvents(failed!.id).at(-1)).toMatchObject({
      eventType: 'probe_failed',
      message: expect.stringContaining('Cannot connect to the Docker daemon'),
    });
    expect(repo.listEvents(failed!.id).at(-1)?.message).not.toContain('sk-not-for-planner');
  });
});
