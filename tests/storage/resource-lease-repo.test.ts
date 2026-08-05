import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';

function seedForeignKeys(db: Database.Database): void {
  const now = '2026-07-22T00:00:00.000Z';
  db.prepare(`INSERT INTO tasks (
    id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
    dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
    last_interruption_reason, interruption_count, created_at, updated_at
  ) VALUES ('task', 'task', 'task', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)`)
    .run(now, now);
  const insertSubtask = db.prepare(`INSERT INTO subtasks (
    id, task_id, graph_revision, generation_id, title, goal, status, dependencies_json,
    context_refs_json, required_capabilities_json, preferred_agent_class_list_json,
    delivery_kind, acceptance_json, risk_level, result, artifacts_json,
    verification_json, error, created_at, updated_at
  ) VALUES (?, 'task', 1, 'gen', ?, ?, 'ready', '[]', '[]', '[]', '[]', 'report', '[]', 'low', '', '[]', '{}', NULL, ?, ?)`);
  insertSubtask.run('subtask-a', 'a', 'a', now, now);
  insertSubtask.run('subtask-b', 'b', 'b', now, now);
  new AgentClassService({ db }).seedDefaults();
  for (const id of ['worker-a', 'worker-b']) {
    db.prepare(`INSERT INTO work_units (
      id, agent_class_name, agent_class_kind, state, claimed_task_id, claimed_subtask_id,
      claimed_attempt_id, heartbeat_at, lease_expires_at, created_at, updated_at
    ) VALUES (?, 'codex-cli', 'executor', 'idle', NULL, NULL, NULL, NULL, NULL, ?, ?)`).run(id, now, now);
  }
}

describe('SqliteResourceLeaseRepository', () => {
  it('allows only one competing write claim and remains idempotent per attempt', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedForeignKeys(db);
    const repo = new SqliteResourceLeaseRepository(db);
    const claim = (attemptId: string, subtaskId: string, workUnitId: string, leaseToken: string) => repo.claim({
      taskId: 'task', generationId: 'gen', subtaskId, attemptId, workUnitId, leaseToken,
      claims: [{ partition: { kind: 'logical', namespace: 'dataset', key: 'customer-42' }, access: 'write' }],
      now: '2026-07-22T00:00:00.000Z', expiresAt: '2026-07-22T00:01:00.000Z',
    });

    expect(claim('attempt-a', 'subtask-a', 'worker-a', 'token-a').type).toBe('claimed');
    expect(claim('attempt-a', 'subtask-a', 'worker-a', 'token-a')).toMatchObject({ type: 'claimed', leases: [{ attemptId: 'attempt-a' }] });
    const competing = claim('attempt-b', 'subtask-b', 'worker-b', 'token-b');
    expect(competing).toMatchObject({ type: 'conflict', conflictingLeases: [{ attemptId: 'attempt-a' }] });
    expect(repo.releaseAttempt('attempt-a', 'token-a', '2026-07-22T00:00:10.000Z')).toBe(1);
    expect(claim('attempt-b', 'subtask-b', 'worker-b', 'token-b').type).toBe('claimed');
  });
});
