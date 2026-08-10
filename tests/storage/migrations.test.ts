import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';

describe('current SQLite baseline', () => {
  it('creates only the current pre-release schema on a fresh database', () => {
    const db = new Database(':memory:');

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 34 }]);
    for (const table of [
      'projects',
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
      'executor_verifications',
      'smoke_run_audits',
      'task_purge_audits',
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
      'executor_route_events',
      'guidance_events',
      'reflection_events',
      'agent_classes',
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
    expect((db.prepare('PRAGMA table_info(learning_candidates)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'source_skill_usage_event_id',
    ]));
    expect((db.prepare('PRAGMA table_info(workspace_publications)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'main_base_commit',
      'permission_request_id',
      'changed_paths_json',
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

  it('rejects every older pre-release schema', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (30);
    `);

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite schema (30) at (unknown path); back up and create a fresh database for schema 34',
    );
    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 30 }]);
  });

  it('rejects a non-empty pre-release database that has no schema marker', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)');

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite database without schema_version at (unknown path)',
    );
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([{ name: 'legacy_marker' }]);
  });
});
