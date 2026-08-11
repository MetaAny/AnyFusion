import Database from 'better-sqlite3';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskPurgeService } from '../../src/task/task-purge-service.js';

function harness(source: 'user' | 'system_smoke' = 'user') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const engine = new TaskEngine(new TaskRepo(db), '/tmp');
  const task = engine.create({
    id: 'task_purge',
    title: 'Purge',
    goal: 'Verify purge',
    source,
    smokeRunId: source === 'system_smoke' ? 'smoke_1' : null,
  });
  db.prepare("UPDATE tasks SET status = 'done', summary = 'finished' WHERE id = ?").run(task.id);
  db.prepare(`
    INSERT INTO subtasks (
      id, task_id, title, goal, status, dependencies_json, context_refs_json,
      required_capabilities_json, preferred_agent_class_list_json,
      acceptance_json, risk_level, result, artifacts_json, verification_json,
      error, created_at, updated_at, graph_revision, generation_id
    ) VALUES (
      'subtask_1', ?, 'Subtask', 'Work', 'done', '[]', '[]',
      '["workspace-engineering"]', '["repo-codex"]',
      '[]', 'low', 'done', '[]', '{}', NULL, ?, ?, 1, 'generation_1'
    )
  `).run(task.id, task.createdAt, task.updatedAt);
  db.prepare(`
    INSERT INTO subtask_handoffs (
      task_id, from_subtask_id, to_subtask_id, attempt_id, items_json,
      completion_schema_version, created_at
    ) VALUES (?, 'subtask_1', 'subtask_1', 'attempt_1', '[]', 4, ?)
  `).run(task.id, task.createdAt);
  return { db, taskId: task.id };
}

describe('TaskPurgeService', () => {
  it('keeps immutable facts protected from ordinary SQL and purges them only with a minimal audit', async () => {
    const { db, taskId } = harness();
    expect(() => db.prepare('DELETE FROM subtask_handoffs WHERE task_id = ?').run(taskId))
      .toThrow('subtask_handoffs are immutable');
    const result = await new TaskPurgeService(db).purge({
      taskId,
      confirmation: taskId,
      reason: 'test purge',
    });
    expect(result.audit.counts.subtasks).toBe(1);
    expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM subtask_handoffs WHERE task_id = ?').all(taskId)).toEqual([]);
    expect(db.prepare('SELECT task_id, reason FROM task_purge_audits').all())
      .toEqual([{ task_id: taskId, reason: 'test purge' }]);
  });

  it('rejects active resources and rolls back audit plus deletion on transaction failure', async () => {
    const active = harness();
    const now = new Date().toISOString();
    active.db.prepare(`
      INSERT INTO work_units (
        id, agent_class_name, agent_class_kind, state, claimed_task_id,
        claimed_subtask_id, claimed_attempt_id, heartbeat_at, lease_expires_at,
        created_at, updated_at
      ) VALUES (
        'work_1', 'repo-codex', 'executor', 'idle', NULL, NULL, NULL,
        ?, NULL, ?, ?
      )
    `).run(now, now, now);
    active.db.prepare(`
      INSERT INTO resource_leases (
        id, partition_key, partition_json, access_mode, task_id, generation_id,
        subtask_id, attempt_id, work_unit_id, lease_token, heartbeat_at,
        expires_at, released_at, created_at
      ) VALUES (
        'lease_1', 'workspace:test', '{}', 'write', ?, 'generation_1',
        'subtask_1', 'attempt_1', 'work_1', 'token', ?, ?, NULL, ?
      )
    `).run(active.taskId, now, new Date(Date.now() + 60_000).toISOString(), now);
    await expect(new TaskPurgeService(active.db).purge({
      taskId: active.taskId,
      confirmation: active.taskId,
      reason: 'test',
    })).rejects.toThrow('resource leases are active');

    const rollback = harness();
    rollback.db.exec(`
      CREATE TRIGGER reject_task_purge
      BEFORE DELETE ON tasks BEGIN
        SELECT RAISE(ABORT, 'injected purge failure');
      END;
    `);
    await expect(new TaskPurgeService(rollback.db).purge({
      taskId: rollback.taskId,
      confirmation: rollback.taskId,
      reason: 'test',
    })).rejects.toThrow('injected purge failure');
    expect(rollback.db.prepare('SELECT * FROM tasks WHERE id = ?').get(rollback.taskId)).toBeTruthy();
    expect(rollback.db.prepare('SELECT * FROM task_purge_audits').all()).toEqual([]);
  });

  it('requires an exact smoke_run_id for smoke-owned cleanup', async () => {
    const { db, taskId } = harness('system_smoke');
    await expect(new TaskPurgeService(db).purge({
      taskId,
      confirmation: taskId,
      reason: 'smoke cleanup',
      expectedSmokeRunId: 'wrong',
    })).rejects.toThrow('requires its exact smoke_run_id');
    await expect(new TaskPurgeService(db).purge({
      taskId,
      confirmation: taskId,
      reason: 'smoke cleanup',
      expectedSmokeRunId: 'smoke_1',
    })).resolves.toMatchObject({ taskId });
  });

  it('purges receipts, merge audits, workspace CAS and Kernel application facts without global Executor facts', async () => {
    const { db, taskId } = harness();
    const now = '2026-08-08T00:00:00.000Z';
    db.prepare(`
      INSERT INTO work_units (
        id, agent_class_name, agent_class_kind, state, claimed_task_id,
        claimed_subtask_id, claimed_attempt_id, heartbeat_at, lease_expires_at,
        created_at, updated_at
      ) VALUES ('work_purge', 'repo-codex', 'executor', 'idle', ?, 'subtask_1',
        'attempt_1', ?, NULL, ?, ?)
    `).run(taskId, now, now, now);
    db.prepare(`
      INSERT INTO executor_attempt_receipts (
        attempt_id, execution_id, task_id, subtask_id, work_unit_id,
        agent_class_name, started_at, completed_at, terminal_state,
        raw_response, completion_schema_version, parsing_json,
        verification_json, graph_revision, generation_id, attempt_kind,
        recovery_mode
      ) VALUES (
        'attempt_1', 'execution_1', ?, 'subtask_1', 'work_purge',
        'repo-codex', ?, ?, 'completed', 'done', 3, '{}', '{}',
        1, 'generation_1', 'primary', 'fresh'
      )
    `).run(taskId, now, now);
    db.prepare(`
      INSERT INTO workspace_records (
        id, task_id, generation_id, subtask_id, workspace_kind, root_uri,
        baseline_json, managed_repository_uri, status, created_at, updated_at
      ) VALUES (
        'workspace_1', ?, 'generation_1', 'subtask_1', 'git',
        '/tmp/nonexistent-purge-workspace', '{}',
        '/tmp/nonexistent-purge-repository', 'retained', ?, ?
      )
    `).run(taskId, now, now);
    db.prepare(`
      INSERT INTO workspace_objects (
        content_hash, object_uri, size_bytes, reference_count,
        created_at, last_referenced_at
      ) VALUES ('hash_1', '/tmp/nonexistent-purge-object', 10, 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO workspace_checkpoints (
        id, workspace_id, attempt_id, reason, manifest_uri,
        manifest_hash, manifest_size, created_at
      ) VALUES (
        'checkpoint_1', 'workspace_1', 'attempt_1', 'success',
        '/tmp/nonexistent-manifest', 'manifest_hash', 10, ?
      )
    `).run(now);
    db.prepare(`
      INSERT INTO workspace_checkpoint_objects (checkpoint_id, content_hash)
      VALUES ('checkpoint_1', 'hash_1')
    `).run();
    db.prepare(`
      INSERT INTO workspace_publications (
        id, task_id, generation_id, subtask_id, source_attempt_id,
        agent_class_name, main_base_commit, candidate_commit,
        permission_request_id, changed_paths_json, original_completion_json,
        topology_layer, first_dispatch_order, status, created_at, updated_at
      ) VALUES (
        'publication_1', ?, 'generation_1', 'subtask_1', 'attempt_1',
        'repo-codex', 'main', 'candidate', 'permission_1', '[]', '{}',
        0, 0, 'integrated', ?, ?
      )
    `).run(taskId, now, now);
    db.prepare(`
      INSERT INTO workspace_merge_attempts (
        id, publication_id, decision_id, attempt_id, ordinal, attempt_kind,
        base_commit, ours_commit, theirs_commit, result, created_at
      ) VALUES (
        'merge_1', 'publication_1', 'decision_1', 'attempt_1', 1, 'automatic',
        'base', 'ours', 'theirs', 'integrated', ?
      )
    `).run(now);
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, task_id,
        event_json, available_at, status, created_at, updated_at
      ) VALUES (
        'event_1', 5, 'plan_proposed', 'correlation_1', 'session_1', NULL,
        '{}', ?, 'processed', ?, ?
      )
    `).run(now, now, now);
    db.prepare(`
      INSERT INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, session_id,
        task_id, event_json, snapshot_json, decision_json, action, reason, created_at
      ) VALUES (
        'decision_1', 5, 'event_1', 'plan_proposed', 'correlation_1', 'session_1',
        ?, '{}', '{}', '{}', 'authorize_task_plan', 'test', ?
      )
    `).run(taskId, now);
    db.prepare(`
      INSERT INTO kernel_decision_applications (
        id, decision_id, event_id, idempotency_key, status, created_at, updated_at
      ) VALUES ('application_1', 'decision_1', 'event_1', 'application_key', 'applied', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO kernel_effect_outbox (
        id, decision_id, task_id, effect_type, idempotency_key, payload_json,
        status, available_at, created_at, updated_at
      ) VALUES (
        'outbox_1', 'decision_1', ?, 'test', 'outbox_key', '{}',
        'delivered', ?, ?, ?
      )
    `).run(taskId, now, now, now);
    db.prepare(`
      INSERT INTO planner_proposal_turns (
        session_id, turn_id, user_input, accepted_submission_id, created_at, updated_at
      ) VALUES ('session_1', 'turn_1', 'work', 'submission_1', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO planner_proposal_submissions (
        session_id, turn_id, submission_id, plan_fingerprint, plan_id,
        event_id, status, result_json, created_at, updated_at
      ) VALUES (
        'session_1', 'turn_1', 'submission_1', 'fingerprint', 'plan_1',
        'event_1', 'accepted', '{}', ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO executor_verifications (
        executor_id, config_digest, binary_path, binary_path_digest, version,
        driver, verified_at, success, result_json
      ) VALUES (
        'repo-codex', 'digest_1', '/usr/bin/codex', 'path_digest', '1.0',
        'codex', ?, 1, '{}'
      )
    `).run(now);
    db.prepare(`
      INSERT INTO kernel_executor_status (
        agent_class_name, class_health, recent_attempts_json,
        recent_recovery_checks_json, updated_at
      ) VALUES ('repo-codex', 'healthy', '[]', '[]', ?)
    `).run(now);

    expect(() => db.prepare("DELETE FROM executor_attempt_receipts WHERE attempt_id = 'attempt_1'").run())
      .toThrow('executor_attempt_receipts are immutable');
    expect(() => db.prepare("DELETE FROM workspace_merge_attempts WHERE id = 'merge_1'").run())
      .toThrow('workspace_merge_attempts are immutable');

    await new TaskPurgeService(db).purge({
      taskId,
      confirmation: taskId,
      reason: 'deep purge test',
    });

    for (const table of [
      'executor_attempt_receipts',
      'subtask_handoffs',
      'workspace_merge_attempts',
      'workspace_publications',
      'workspace_checkpoint_objects',
      'workspace_checkpoints',
      'workspace_records',
      'kernel_decision_applications',
      'kernel_effect_outbox',
      'kernel_decisions',
      'kernel_events',
      'planner_proposal_submissions',
      'planner_proposal_turns',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_objects').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM executor_verifications').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM kernel_executor_status').get()).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('removes the complete task workspace, integration tree, managed repository, artifact, and unreferenced CAS object', async () => {
    const { db, taskId } = harness();
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'anyfusion-task-purge-'));
    try {
      const storeRoot = join(temporaryRoot, 'workspace-store');
      const taskWorkspaceRoot = join(storeRoot, 'workspaces', taskId);
      const subtaskRoot = join(taskWorkspaceRoot, 'generation_1', 'subtask_1');
      const integrationRoot = join(taskWorkspaceRoot, 'generation_1', '__integration__');
      const artifactPath = join(integrationRoot, 'files', 'smoke-result.md');
      const taskRepositoryRoot = join(storeRoot, 'repositories', taskId);
      const repositoryPath = join(taskRepositoryRoot, 'generation_1.git');
      const objectHash = 'a'.repeat(64);
      const objectPath = join(storeRoot, 'objects', 'sha256', 'aa', objectHash);
      await Promise.all([
        mkdir(join(subtaskRoot, 'files'), { recursive: true }),
        mkdir(join(repositoryPath, 'objects'), { recursive: true }),
        mkdir(join(objectPath, '..'), { recursive: true }),
        mkdir(join(integrationRoot, 'files'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(subtaskRoot, 'files', 'result.txt'), 'subtask'),
        writeFile(join(repositoryPath, 'HEAD'), 'ref: refs/heads/main\n'),
        writeFile(artifactPath, 'artifact'),
        writeFile(objectPath, 'object'),
      ]);
      db.prepare('UPDATE tasks SET artifacts_json = ? WHERE id = ?')
        .run(JSON.stringify([artifactPath]), taskId);
      db.prepare(`
        INSERT INTO workspace_records (
          id, task_id, generation_id, subtask_id, workspace_kind, root_uri,
          baseline_json, managed_repository_uri, status, created_at, updated_at
        ) VALUES (
          'workspace_filesystem', ?, 'generation_1', 'subtask_1', 'git',
          ?, '{}', ?, 'retained', ?, ?
        )
      `).run(
        taskId,
        pathToFileURL(subtaskRoot).href,
        pathToFileURL(repositoryPath).href,
        '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z',
      );
      db.prepare(`
        INSERT INTO workspace_objects (
          content_hash, object_uri, size_bytes, reference_count,
          created_at, last_referenced_at
        ) VALUES (?, ?, 6, 1, ?, ?)
      `).run(
        objectHash,
        pathToFileURL(objectPath).href,
        '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z',
      );
      db.prepare(`
        INSERT INTO workspace_checkpoints (
          id, workspace_id, attempt_id, reason, manifest_uri,
          manifest_hash, manifest_size, created_at
        ) VALUES (
          'checkpoint_filesystem', 'workspace_filesystem', NULL, 'success',
          ?, 'manifest_hash', 10, ?
        )
      `).run(
        pathToFileURL(join(subtaskRoot, 'checkpoints', 'manifest.json')).href,
        '2026-08-08T00:00:00.000Z',
      );
      db.prepare(`
        INSERT INTO workspace_checkpoint_objects (checkpoint_id, content_hash)
        VALUES ('checkpoint_filesystem', ?)
      `).run(objectHash);

      const result = await new TaskPurgeService(db).purge({
        taskId,
        confirmation: taskId,
        reason: 'filesystem purge test',
      });

      await expect(access(taskWorkspaceRoot)).rejects.toThrow();
      await expect(access(taskRepositoryRoot)).rejects.toThrow();
      await expect(access(artifactPath)).rejects.toThrow();
      await expect(access(objectPath)).rejects.toThrow();
      await expect(access(join(storeRoot, 'objects', 'sha256', 'aa'))).rejects.toThrow();
      expect(result.cleanupErrors).toEqual([]);
      expect(result.removedPaths).toEqual(expect.arrayContaining([
        taskWorkspaceRoot,
        taskRepositoryRoot,
        objectPath,
      ]));
    } finally {
      db.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
