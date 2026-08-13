import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelEffectOutboxRepo } from '../../src/storage/kernel-effect-outbox-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';

describe('KernelEffectOutboxRepo', () => {
  it('does not automatically resend an effect whose provider result is unknown', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedDecision(db);
    const repo = new KernelEffectOutboxRepo(db);
    const now = '2026-07-21T00:00:00.000Z';
    repo.enqueue({
      id: 'effect_1', decisionId: 'decision_1', taskId: null,
      effectType: 'message', payload: { text: 'hello' }, availableAt: now,
    });
    const sender = vi.fn().mockRejectedValue(new Error('provider response lost'));

    expect(await repo.deliver('effect_1', sender, () => now)).toMatchObject({ status: 'uncertain', deliveryAttempts: 1 });
    expect(await repo.deliver('effect_1', sender, () => now)).toMatchObject({ status: 'uncertain', deliveryAttempts: 1 });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('marks an in-flight effect uncertain during startup reconcile', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedDecision(db);
    const repo = new KernelEffectOutboxRepo(db);
    const now = '2026-07-21T00:00:00.000Z';
    repo.enqueue({ id: 'effect_1', decisionId: 'decision_1', effectType: 'message', payload: {}, availableAt: now });
    db.prepare(`UPDATE kernel_effect_outbox SET status = 'sending' WHERE id = 'effect_1'`).run();

    expect(repo.reconcileSending(now)).toBe(1);
    expect(repo.find('effect_1')).toMatchObject({ status: 'uncertain' });
  });

  it('finds Feishu sessions and Tasks whose completion projection needs recovery', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedTaskCompletion(db);
    const repo = new KernelEffectOutboxRepo(db);

    expect(repo.listIncompleteCompletionTaskIds()).toEqual(['task_1']);
    expect(repo.listCompletionRecoverySessionIds('sess_feishu_')).toEqual(['sess_feishu_1']);
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = 'task_1'`).run();
    expect(repo.listIncompleteCompletionTaskIds()).toEqual([]);
  });
});

function seedDecision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO kernel_events (
      id, schema_version, event_type, correlation_id, causation_id, session_id,
      task_id, subtask_id, attempt_id, event_json, available_at, status,
      created_at, updated_at
    ) VALUES ('event_1', 2, 'timer_tick', 'correlation_1', NULL, 'session_1',
      NULL, NULL, NULL, '{}', '2026-07-21T00:00:00.000Z', 'processed',
      '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, created_at
    ) VALUES ('decision_1', 2, 'event_1', 'timer_tick', 'correlation_1', NULL,
      'session_1', NULL, NULL, NULL, '{}', '{}', '{}', 'no_op', 'test',
      '2026-07-21T00:00:00.000Z')
  `).run();
}

function seedTaskCompletion(db: Database.Database): void {
  const tasks = new TaskEngine(new TaskRepo(db), '/tmp/kernel-effect-outbox');
  tasks.create({ id: 'task_1', title: 'Task', goal: 'Goal' });
  tasks.transition('task_1', 'ready');
  db.prepare(`
    INSERT INTO kernel_events (
      id, schema_version, event_type, correlation_id, causation_id, session_id,
      task_id, subtask_id, attempt_id, event_json, available_at, status,
      created_at, updated_at
    ) VALUES ('event_completion', 5, 'dispatch_requested', 'task_1', NULL, 'sess_feishu_1',
      'task_1', NULL, NULL, '{}', '2026-07-21T00:00:00.000Z', 'processed',
      '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, created_at
    ) VALUES ('decision_completion', 5, 'event_completion', 'dispatch_requested', 'task_1', NULL,
      'sess_feishu_1', 'task_1', NULL, NULL, '{}', '{}', '{}', 'complete_task', 'test',
      '2026-07-21T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO kernel_effect_outbox (
      id, decision_id, task_id, effect_type, idempotency_key, payload_json,
      status, delivery_attempts, provider_receipt, error_summary,
      available_at, created_at, updated_at
    ) VALUES ('effect_completion', 'decision_completion', 'task_1',
      'task_completion_notification', 'effect:completion', '{}', 'sent', 1,
      'receipt', NULL, '2026-07-21T00:00:00.000Z',
      '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')
  `).run();
}
