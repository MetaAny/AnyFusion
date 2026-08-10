import { createHash, randomUUID } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Task } from '../core/types.js';

const TERMINAL_STATUSES = new Set(['done', 'archived', 'cancelled']);
const ACTIVE_DISPATCH_STATUSES = ['pending_launch', 'launching', 'running', 'cancelling', 'uncertain'];
const ACTIVE_PUBLICATION_STATUSES = ['awaiting_approval', 'pending', 'applying', 'conflicted', 'cancelling', 'uncertain'];
const ACTIVE_WORK_UNIT_STATES = ['starting', 'claimed', 'running', 'waiting', 'draining'];

export interface TaskPurgeResult {
  taskId: string;
  audit: {
    source: Task['source'];
    smokeRunId: string | null;
    terminalStatus: string;
    counts: Record<string, number>;
    resultSummaryHash: string;
    reason: string;
    purgedAt: string;
  };
  removedPaths: string[];
  cleanupErrors: string[];
}

interface PurgeTaskRow {
  id: string;
  source: Task['source'];
  smoke_run_id: string | null;
  status: string;
  summary: string;
  artifacts_json: string;
}

interface PurgeWorkspaceRow {
  generation_id: string;
  subtask_id: string;
  root_uri: string;
  managed_repository_uri: string | null;
}

export class TaskPurgeService {
  constructor(private readonly db: Database.Database) {}

  async purge(input: {
    taskId: string;
    confirmation: string;
    reason: string;
    expectedSmokeRunId?: string;
  }): Promise<TaskPurgeResult> {
    if (input.confirmation !== input.taskId) {
      throw new Error('Task purge confirmation must exactly match the Task ID');
    }
    const task = this.db.prepare(`
      SELECT id, source, smoke_run_id, status, summary, artifacts_json
      FROM tasks WHERE id = ?
    `).get(input.taskId) as PurgeTaskRow | undefined;
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    if (!TERMINAL_STATUSES.has(task.status)) {
      throw new Error(`Task ${task.id} must be done, archived, or cancelled before purge; current status is ${task.status}`);
    }
    if (task.source === 'system_smoke') {
      if (!input.expectedSmokeRunId || input.expectedSmokeRunId !== task.smoke_run_id) {
        throw new Error(`Smoke Task ${task.id} requires its exact smoke_run_id`);
      }
    } else if (input.expectedSmokeRunId) {
      throw new Error('Smoke cleanup cannot purge a user Task');
    }
    this.assertQuiescent(task.id);

    const workspaceRows = this.db.prepare(`
      SELECT generation_id, subtask_id, root_uri, managed_repository_uri
      FROM workspace_records WHERE task_id = ?
    `).all(task.id) as PurgeWorkspaceRow[];
    const artifactPaths = parseStringArray(task.artifacts_json);
    const counts = this.collectCounts(task.id);
    const purgedAt = new Date().toISOString();
    const resultSummaryHash = createHash('sha256').update(task.summary ?? '').digest('hex');
    const authorizationToken = randomUUID();

    const unreferencedObjectUris = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO task_purge_audits (
          task_id, source, smoke_run_id, terminal_status, counts_json,
          result_summary_hash, reason, purged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.source,
        task.smoke_run_id,
        task.status,
        JSON.stringify(counts),
        resultSummaryHash,
        input.reason,
        purgedAt,
      );
      this.db.prepare(`
        INSERT INTO task_purge_authorizations (task_id, authorization_token, created_at)
        VALUES (?, ?, ?)
      `).run(task.id, authorizationToken, purgedAt);
      const objectReferences = this.deleteTaskFacts(task.id);
      this.db.prepare('DELETE FROM task_purge_authorizations WHERE task_id = ?').run(task.id);
      return objectReferences
        .filter(reference => !this.db.prepare(
          'SELECT 1 FROM workspace_objects WHERE content_hash = ?',
        ).get(reference.contentHash))
        .map(reference => reference.objectUri);
    })();

    const cleanupTargets = [
      ...workspaceRows.flatMap(row => [row.root_uri, row.managed_repository_uri].filter((value): value is string => Boolean(value))),
      ...taskOwnedWorkspaceRoots(task.id, workspaceRows),
      ...unreferencedObjectUris,
      ...artifactPaths,
    ];
    const removedPaths: string[] = [];
    const cleanupErrors: string[] = [];
    for (const target of [...new Set(cleanupTargets)]) {
      try {
        const path = pathFromUriOrAbsolute(target);
        if (!path) throw new Error('cleanup target must be an absolute path or file URI');
        await rm(path, { recursive: true, force: true });
        removedPaths.push(path);
      } catch (error) {
        cleanupErrors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const objectUri of unreferencedObjectUris) {
      const objectPath = pathFromUriOrAbsolute(objectUri);
      if (!objectPath) continue;
      try {
        await rmdir(dirname(objectPath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
          cleanupErrors.push(`${dirname(objectPath)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return {
      taskId: task.id,
      audit: {
        source: task.source,
        smokeRunId: task.smoke_run_id,
        terminalStatus: task.status,
        counts,
        resultSummaryHash,
        reason: input.reason,
        purgedAt,
      },
      removedPaths,
      cleanupErrors,
    };
  }

  private assertQuiescent(taskId: string): void {
    const checks: Array<[string, string, unknown[]]> = [
      [
        'dispatch items',
        `SELECT COUNT(*) AS count FROM kernel_dispatch_items
         WHERE task_id = ? AND status IN (${placeholders(ACTIVE_DISPATCH_STATUSES)})`,
        [taskId, ...ACTIVE_DISPATCH_STATUSES],
      ],
      [
        'publications',
        `SELECT COUNT(*) AS count FROM workspace_publications
         WHERE task_id = ? AND status IN (${placeholders(ACTIVE_PUBLICATION_STATUSES)})`,
        [taskId, ...ACTIVE_PUBLICATION_STATUSES],
      ],
      [
        'sandboxes',
        `SELECT COUNT(*) AS count FROM attempt_sandboxes
         WHERE task_id = ? AND status <> 'removed'`,
        [taskId],
      ],
      [
        'resource leases',
        'SELECT COUNT(*) AS count FROM resource_leases WHERE task_id = ? AND released_at IS NULL',
        [taskId],
      ],
      [
        'work units',
        `SELECT COUNT(*) AS count FROM work_units
         WHERE claimed_task_id = ? AND state IN (${placeholders(ACTIVE_WORK_UNIT_STATES)})`,
        [taskId, ...ACTIVE_WORK_UNIT_STATES],
      ],
    ];
    for (const [label, sql, params] of checks) {
      const row = this.db.prepare(sql).get(...params) as { count: number };
      if (row.count > 0) throw new Error(`Task ${taskId} cannot be purged while ${label} are active`);
    }
  }

  private collectCounts(taskId: string): Record<string, number> {
    const tables = [
      'subtasks',
      'task_events',
      'executor_attempt_receipts',
      'kernel_events',
      'kernel_decisions',
      'kernel_dispatch_items',
      'workspace_records',
      'workspace_publications',
      'resource_leases',
      'attempt_sandboxes',
      'interactions',
      'task_memory_cards',
    ];
    return Object.fromEntries(tables.map(table => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(taskId) as { count: number };
      return [table, row.count];
    }));
  }

  private deleteTaskFacts(taskId: string): Array<{
    contentHash: string;
    objectUri: string;
    referenceCount: number;
  }> {
    const candidateIds = this.db.prepare(
      'SELECT id FROM learning_candidates WHERE source_task_id = ?',
    ).all(taskId) as Array<{ id: string }>;
    const workUnitIds = this.db.prepare(`
      SELECT DISTINCT work_unit_id AS id FROM executor_attempt_receipts WHERE task_id = ?
      UNION
      SELECT DISTINCT work_unit_id AS id FROM work_unit_events WHERE task_id = ?
      UNION
      SELECT id FROM work_units WHERE claimed_task_id = ?
    `).all(taskId, taskId, taskId) as Array<{ id: string }>;
    const attemptIds = this.db.prepare(`
      SELECT attempt_id AS id FROM executor_attempt_receipts WHERE task_id = ?
      UNION SELECT attempt_id AS id FROM kernel_dispatch_items WHERE task_id = ?
    `).all(taskId, taskId) as Array<{ id: string }>;
    const workspaceIds = this.db.prepare(
      'SELECT id FROM workspace_records WHERE task_id = ?',
    ).all(taskId) as Array<{ id: string }>;
    const publicationIds = this.db.prepare(
      'SELECT id FROM workspace_publications WHERE task_id = ?',
    ).all(taskId) as Array<{ id: string }>;
    const requestIds = this.db.prepare(
      'SELECT id FROM permission_requests WHERE task_id = ?',
    ).all(taskId) as Array<{ id: string }>;
    const decisionIds = this.db.prepare(
      'SELECT id FROM kernel_decisions WHERE task_id = ?',
    ).all(taskId) as Array<{ id: string }>;
    const eventIds = this.db.prepare(
      `SELECT id FROM kernel_events WHERE task_id = ?
       UNION
       SELECT event_id AS id FROM kernel_decisions WHERE task_id = ?`,
    ).all(taskId, taskId) as Array<{ id: string }>;
    const proposalTurns = eventIds.length === 0
      ? []
      : this.db.prepare(`
          SELECT session_id AS sessionId, turn_id AS turnId
          FROM planner_proposal_submissions
          WHERE event_id IN (${placeholders(eventIds)})
        `).all(...eventIds.map(item => item.id)) as Array<{ sessionId: string; turnId: string }>;
    const checkpointIds = this.checkpointIds(workspaceIds);
    const workspaceObjectReferences = checkpointIds.length === 0
      ? []
      : this.db.prepare(`
          SELECT link.content_hash AS contentHash, object.object_uri AS objectUri,
                 COUNT(*) AS referenceCount
          FROM workspace_checkpoint_objects link
          JOIN workspace_objects object ON object.content_hash = link.content_hash
          WHERE link.checkpoint_id IN (${placeholders(checkpointIds)})
          GROUP BY link.content_hash, object.object_uri
        `).all(...checkpointIds.map(item => item.id)) as Array<{
          contentHash: string;
          objectUri: string;
          referenceCount: number;
        }>;

    deleteByIds(this.db, 'executor_skill_install_events', 'candidate_id', candidateIds);
    this.db.prepare('DELETE FROM learning_candidates WHERE source_task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM executor_skill_usage_events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM preference_usage WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM task_memory_cards WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM task_search_index WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM interactions WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM task_execution_evidence WHERE task_id = ?').run(taskId);
    deleteByIds(this.db, 'permission_grants', 'request_id', requestIds);
    this.db.prepare('DELETE FROM user_authorizations WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM permission_requests WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM attempt_sandboxes WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM resource_waits WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM resource_leases WHERE task_id = ?').run(taskId);
    deleteByIds(this.db, 'workspace_checkpoint_objects', 'checkpoint_id', checkpointIds);
    deleteByIds(this.db, 'workspace_checkpoints', 'workspace_id', workspaceIds);
    for (const reference of workspaceObjectReferences) {
      this.db.prepare(`
        UPDATE workspace_objects
        SET reference_count = MAX(0, reference_count - ?),
            last_referenced_at = ?
        WHERE content_hash = ?
      `).run(reference.referenceCount, new Date().toISOString(), reference.contentHash);
      this.db.prepare(`
        DELETE FROM workspace_objects
        WHERE content_hash = ? AND reference_count = 0
      `).run(reference.contentHash);
    }
    deleteByIds(this.db, 'workspace_merge_attempts', 'publication_id', publicationIds);
    this.db.prepare('DELETE FROM workspace_publications WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM workspace_records WHERE task_id = ?').run(taskId);
    deleteByIds(this.db, 'executor_attempt_runtime', 'attempt_id', attemptIds);
    this.db.prepare('DELETE FROM executor_attempt_receipts WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM kernel_dispatch_items WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM subtask_handoffs WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM generation_replan_requests WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM work_graph_revisions WHERE task_id = ?').run(taskId);
    deleteByIds(this.db, 'kernel_effect_outbox', 'decision_id', decisionIds);
    deleteByIds(this.db, 'kernel_decision_applications', 'decision_id', decisionIds);
    deleteByIds(this.db, 'kernel_decision_applications', 'event_id', eventIds);
    deleteByIds(this.db, 'planner_proposal_submissions', 'event_id', eventIds);
    for (const turn of proposalTurns) {
      this.db.prepare(`
        DELETE FROM planner_proposal_turns
        WHERE session_id = ? AND turn_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM planner_proposal_submissions submission
            WHERE submission.session_id = planner_proposal_turns.session_id
              AND submission.turn_id = planner_proposal_turns.turn_id
          )
      `).run(turn.sessionId, turn.turnId);
    }
    this.db.prepare('DELETE FROM kernel_decisions WHERE task_id = ?').run(taskId);
    deleteByIds(this.db, 'kernel_events', 'id', eventIds);
    this.db.prepare('DELETE FROM work_unit_events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(taskId);
    this.db.prepare(`
      UPDATE work_units
      SET claimed_task_id = NULL,
          claimed_subtask_id = NULL,
          claimed_attempt_id = NULL,
          state = CASE WHEN state IN ('stopped', 'failed') THEN state ELSE 'idle' END,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE claimed_task_id = ?
    `).run(new Date().toISOString(), taskId);
    if (workUnitIds.length > 0) {
      this.db.prepare(`
        DELETE FROM work_units
        WHERE id IN (${placeholders(workUnitIds)})
          AND claimed_task_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM work_unit_events event
            WHERE event.work_unit_id = work_units.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM executor_attempt_receipts receipt
            WHERE receipt.work_unit_id = work_units.id
          )
      `).run(...workUnitIds.map(item => item.id));
    }
    this.db.prepare(`
      UPDATE session_state
      SET last_focused_task_id = CASE WHEN last_focused_task_id = ? THEN NULL ELSE last_focused_task_id END,
          last_completed_task_id = CASE WHEN last_completed_task_id = ? THEN NULL ELSE last_completed_task_id END
    `).run(taskId, taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    return workspaceObjectReferences;
  }

  private checkpointIds(workspaceIds: Array<{ id: string }>): Array<{ id: string }> {
    if (workspaceIds.length === 0) return [];
    return this.db.prepare(`
      SELECT id FROM workspace_checkpoints
      WHERE workspace_id IN (${placeholders(workspaceIds)})
    `).all(...workspaceIds.map(item => item.id)) as Array<{ id: string }>;
  }
}

function taskOwnedWorkspaceRoots(taskId: string, rows: readonly PurgeWorkspaceRow[]): string[] {
  const targets = new Set<string>();
  for (const row of rows) {
    const workspacePath = pathFromUriOrAbsolute(row.root_uri);
    if (!workspacePath) continue;
    const generationRoot = dirname(workspacePath);
    const taskRoot = dirname(generationRoot);
    const workspacesRoot = dirname(taskRoot);
    if (
      basename(workspacePath) !== row.subtask_id
      || basename(generationRoot) !== row.generation_id
      || basename(taskRoot) !== taskId
      || basename(workspacesRoot) !== 'workspaces'
    ) {
      continue;
    }
    targets.add(taskRoot);

    if (!row.managed_repository_uri) continue;
    const repositoryPath = pathFromUriOrAbsolute(row.managed_repository_uri);
    if (!repositoryPath) continue;
    const repositoryTaskRoot = dirname(repositoryPath);
    const repositoriesRoot = dirname(repositoryTaskRoot);
    if (
      dirname(workspacesRoot) !== dirname(repositoriesRoot)
      || basename(repositoriesRoot) !== 'repositories'
      || basename(repositoryTaskRoot) !== safeManagedGitSegment(taskId)
      || basename(repositoryPath) !== `${safeManagedGitSegment(row.generation_id)}.git`
    ) {
      continue;
    }
    targets.add(repositoryTaskRoot);
  }
  return [...targets];
}

function safeManagedGitSegment(value: string): string {
  return value.normalize('NFC').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '') || 'unnamed';
}

function pathFromUriOrAbsolute(value: string): string | null {
  try {
    if (value.startsWith('file:')) return resolve(fileURLToPath(value));
    return isAbsolute(value) ? resolve(value) : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function deleteByIds(
  db: Database.Database,
  table: string,
  column: string,
  values: Array<{ id: string }>,
): void {
  if (values.length === 0) return;
  db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(values)})`)
    .run(...values.map(item => item.id));
}
