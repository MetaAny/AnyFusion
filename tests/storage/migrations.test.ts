import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';

describe('current SQLite baseline', () => {
  it('creates only the current pre-release schema on a fresh database', () => {
    const db = new Database(':memory:');

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 30 }]);
    for (const table of [
      'tasks',
      'subtasks',
      'work_graph_revisions',
      'kernel_events',
      'kernel_decisions',
      'kernel_decision_applications',
      'kernel_effect_outbox',
      'kernel_dispatch_items',
      'executor_attempt_receipts',
      'resource_leases',
      'resource_waits',
      'workspace_records',
      'workspace_publications',
      'workspace_merge_attempts',
      'generation_replan_requests',
      'kernel_executor_status',
      'planner_proposal_turns',
      'planner_proposal_submissions',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
    }
    for (const removed of [
      'planning_decisions_legacy_audit',
      'subtasks_v2_audit',
      'subtasks_v3_audit',
      'worktree_leases_legacy_audit',
      'executor_profiles',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${removed})`).all(), removed).toEqual([]);
    }
    expect((db.prepare('PRAGMA table_info(work_graph_revisions)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('completion_kind');
    expect((db.prepare('PRAGMA table_info(resource_leases)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'revocation_requested_at',
      'revocation_reason',
    ]));
    expect((db.prepare('PRAGMA table_info(kernel_executor_status)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('recent_recovery_checks_json');
    expect((db.prepare('PRAGMA table_info(generation_replan_requests)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'deferred_plan_json',
      'availability_explanation',
    ]));
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_planner_proposal_submissions_turn'
    `).get()).toEqual({ name: 'idx_planner_proposal_submissions_turn' });
    expect(db.prepare('PRAGMA foreign_key_list(planner_proposal_submissions)').all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'planner_proposal_turns', from: 'session_id', to: 'session_id', on_delete: 'CASCADE',
        }),
        expect.objectContaining({
          table: 'planner_proposal_turns', from: 'turn_id', to: 'turn_id', on_delete: 'CASCADE',
        }),
      ]));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('upgrades schema 29 recoverable plans and subtasks while preserving terminal ledger JSON', () => {
    const db = schema29Fixture();
    seedTaskAndSubtask(db, 'patch');
    const plan = v6Plan('artifact');
    const rawPlan = JSON.stringify(plan);
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, event_json,
        available_at, status, created_at, updated_at
      ) VALUES (?, 5, 'plan_proposed', ?, 'session', ?, ?, ?, ?, ?)
    `).run('event_pending', 'corr_pending', rawPlan, NOW, 'pending', NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, event_json,
        available_at, status, processed_at, created_at, updated_at
      ) VALUES (?, 5, 'plan_proposed', ?, 'session', ?, ?, 'processed', ?, ?, ?)
    `).run('event_terminal', 'corr_terminal', rawPlan, NOW, NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, session_id,
        event_json, snapshot_json, decision_json, action, reason, created_at
      ) VALUES ('decision_pending', 5, 'event_terminal', 'plan_proposed', 'corr_terminal', 'session', ?, ?, ?,
        'authorize_task_plan', 'test', ?)
    `).run(rawPlan, JSON.stringify({ proposal: plan }), JSON.stringify({ proposal: plan }), NOW);
    db.prepare(`
      INSERT INTO kernel_decision_applications (
        id, decision_id, event_id, idempotency_key, status, created_at, updated_at
      ) VALUES ('application_pending', 'decision_pending', 'event_terminal', 'decision:pending', 'pending', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_dispatch_items (
        attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
        agent_class_name, attempt_kind, recovery_mode, attempt_payload_json,
        resource_grant_json, status, created_at, updated_at
      ) VALUES ('attempt_pending', 'decision_pending', 0, 'task', 'generation', 'subtask',
        'codex-cli', 'primary', 'fresh', ?, '[]', 'pending_launch', ?, ?)
    `).run(JSON.stringify({ proposal: plan }), NOW, NOW);
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        deferred_plan_json, created_at, updated_at
      ) VALUES ('replan', 'task', 'generation', 1, 'waiting_for_availability',
        'decision_pending', ?, ?, ?)
    `).run(rawPlan, NOW, NOW);

    runMigrations(db);

    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 30 });
    expect(db.prepare('SELECT delivery_kind FROM subtasks WHERE id = ?').get('subtask'))
      .toEqual({ delivery_kind: 'edit' });
    expect(readJson(db, 'SELECT event_json FROM kernel_events WHERE id = ?', 'event_pending'))
      .toMatchObject({ schemaVersion: 7, workGraph: { subtasks: [{ deliveryKind: 'edit' }] } });
    expect(db.prepare('SELECT event_json FROM kernel_events WHERE id = ?').get('event_terminal'))
      .toEqual({ event_json: rawPlan });
    expect(readJson(db, 'SELECT decision_json FROM kernel_decisions WHERE id = ?', 'decision_pending'))
      .toMatchObject({ proposal: { schemaVersion: 7, workGraph: { subtasks: [{ deliveryKind: 'edit' }] } } });
    expect(readJson(db, 'SELECT attempt_payload_json FROM kernel_dispatch_items WHERE attempt_id = ?', 'attempt_pending'))
      .toMatchObject({ proposal: { schemaVersion: 7, workGraph: { subtasks: [{ deliveryKind: 'edit' }] } } });
    expect(readJson(db, 'SELECT deferred_plan_json FROM generation_replan_requests WHERE id = ?', 'replan'))
      .toMatchObject({ schemaVersion: 7, workGraph: { subtasks: [{ deliveryKind: 'edit' }] } });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back schema 29 migration when a recoverable payload is invalid', () => {
    const db = schema29Fixture();
    seedTaskAndSubtask(db, 'summary');
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        deferred_plan_json, created_at, updated_at
      ) VALUES ('replan', 'task', 'generation', 1, 'waiting_for_availability',
        'decision_missing', '{broken', ?, ?)
    `).run(NOW, NOW);

    expect(() => runMigrations(db)).toThrow('contains invalid recoverable JSON');
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 29 });
    expect((db.prepare('PRAGMA table_info(subtasks)').all() as Array<{ name: string }>).map(item => item.name))
      .toContain('expected_output');
    expect(db.prepare('SELECT expected_output FROM subtasks WHERE id = ?').get('subtask'))
      .toEqual({ expected_output: 'summary' });
  });

  it('rejects schema versions older than the single supported upgrade', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (26);
    `);

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite schema (26); create a fresh database for schema 30',
    );
    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 26 }]);
  });

  it('rejects a non-empty pre-release database that has no schema marker', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)');

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite database without schema_version',
    );
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([{ name: 'legacy_marker' }]);
  });
});

const NOW = '2026-08-03T00:00:00.000Z';

function schema29Fixture(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP INDEX idx_subtasks_task;
    CREATE TABLE subtasks_v29 (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created', dependencies_json TEXT NOT NULL DEFAULT '[]',
      context_refs_json TEXT NOT NULL DEFAULT '[]', required_capabilities_json TEXT NOT NULL,
      preferred_agent_class_list_json TEXT NOT NULL, expected_output TEXT NOT NULL DEFAULT 'summary',
      acceptance_json TEXT NOT NULL DEFAULT '[]', risk_level TEXT NOT NULL DEFAULT 'medium',
      result TEXT NOT NULL DEFAULT '', artifacts_json TEXT NOT NULL DEFAULT '[]',
      verification_json TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, graph_revision INTEGER, generation_id TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    DROP TABLE subtasks;
    ALTER TABLE subtasks_v29 RENAME TO subtasks;
    CREATE INDEX idx_subtasks_task ON subtasks(task_id, status, created_at);
    UPDATE schema_version SET version = 29;
  `);
  db.pragma('foreign_keys = ON');
  return db;
}

function seedTaskAndSubtask(db: Database.Database, expectedOutput: string): void {
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES ('task', 'Task', 'Goal', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO subtasks (
      id, task_id, title, goal, status, dependencies_json, context_refs_json,
      required_capabilities_json, preferred_agent_class_list_json, expected_output,
      acceptance_json, risk_level, created_at, updated_at, graph_revision, generation_id
    ) VALUES ('subtask', 'task', 'Subtask', 'Goal', 'ready', '[]', '[]',
      '["workspace-engineering"]', '["codex-cli"]', ?, '[]', 'low', ?, ?, 1, 'generation')
  `).run(expectedOutput, NOW, NOW);
}

function v6Plan(expectedOutput: string): Record<string, unknown> {
  return {
    id: 'plan_v6', schemaVersion: 6, action: 'plan_work_graph', task: {},
    workGraph: { subtasks: [{ id: 'subtask', expectedOutput }] },
  };
}

function readJson(
  db: Database.Database,
  sql: string,
  id: string,
): unknown {
  const row = db.prepare(sql).get(id) as Record<string, string>;
  return JSON.parse(Object.values(row)[0]!) as unknown;
}
