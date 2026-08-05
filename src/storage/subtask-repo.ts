import type Database from 'better-sqlite3';
import type { AgentClassRiskLevel, Subtask, SubtaskStatus } from '../core/types.js';
import type { ContextRef, WorkGraphAcceptanceCriterion, WorkGraphDependency } from '../work-graph/index.js';

interface SubtaskRow {
  id: string;
  task_id: string;
  graph_revision: number;
  generation_id: string;
  title: string;
  goal: string;
  status: SubtaskStatus;
  dependencies_json: string;
  context_refs_json: string;
  required_capabilities_json: string;
  preferred_agent_class_list_json: string;
  delivery_kind: Subtask['deliveryKind'];
  acceptance_json: string;
  artifacts_json: string;
  verification_json: string;
  risk_level: AgentClassRiskLevel;
  result: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function parseList(value: string): string[] {
  return JSON.parse(value || '[]') as string[];
}

function parseJson<T>(value: string, fallback: T): T {
  return JSON.parse(value || JSON.stringify(fallback)) as T;
}

function rowToSubtask(row: SubtaskRow): Subtask {
  return {
    id: row.id,
    taskId: row.task_id,
    graphRevision: row.graph_revision,
    generationId: row.generation_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    dependencies: parseJson<WorkGraphDependency[]>(row.dependencies_json, []),
    contextRefs: parseJson<ContextRef[]>(row.context_refs_json, []),
    requiredCapabilities: parseList(row.required_capabilities_json),
    preferredAgentClassList: parseList(row.preferred_agent_class_list_json),
    deliveryKind: row.delivery_kind,
    acceptance: parseJson<WorkGraphAcceptanceCriterion[]>(row.acceptance_json, []),
    riskLevel: row.risk_level,
    result: row.result,
    artifacts: parseList(row.artifacts_json),
    verification: parseJson(row.verification_json, { warnings: [], completionSchemaVersion: null }),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SubtaskRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(subtask: Subtask): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO subtasks (
        id, task_id, graph_revision, generation_id, title, goal, status, dependencies_json, context_refs_json, required_capabilities_json,
        preferred_agent_class_list_json, delivery_kind, acceptance_json,
        risk_level, result, artifacts_json, verification_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        goal = excluded.goal,
        status = excluded.status,
        dependencies_json = excluded.dependencies_json,
        context_refs_json = excluded.context_refs_json,
        required_capabilities_json = excluded.required_capabilities_json,
        preferred_agent_class_list_json = excluded.preferred_agent_class_list_json,
        delivery_kind = excluded.delivery_kind,
        acceptance_json = excluded.acceptance_json,
        risk_level = excluded.risk_level,
        result = excluded.result,
        artifacts_json = excluded.artifacts_json,
        verification_json = excluded.verification_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      subtask.id,
      subtask.taskId,
      subtask.graphRevision,
      subtask.generationId,
      subtask.title,
      subtask.goal,
      subtask.status,
      JSON.stringify(subtask.dependencies),
      JSON.stringify(subtask.contextRefs),
      JSON.stringify(subtask.requiredCapabilities),
      JSON.stringify(subtask.preferredAgentClassList),
      subtask.deliveryKind,
      JSON.stringify(subtask.acceptance),
      subtask.riskLevel,
      subtask.result,
      JSON.stringify(subtask.artifacts),
      JSON.stringify(subtask.verification),
      subtask.error,
      subtask.createdAt || now,
      now,
    );
  }

  listByTask(taskId: string): Subtask[] {
    const rows = this.db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as SubtaskRow[];
    return rows.map(rowToSubtask);
  }

  listActiveByTask(taskId: string): Subtask[] {
    const rows = this.db.prepare(`
      SELECT subtask.*
      FROM subtasks subtask
      JOIN work_graph_revisions revision
        ON revision.task_id = subtask.task_id
       AND revision.revision = subtask.graph_revision
      WHERE subtask.task_id = ? AND revision.status = 'active'
      ORDER BY subtask.created_at ASC
    `).all(taskId) as SubtaskRow[];
    return rows.map(rowToSubtask);
  }

  listTaskIds(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT task_id FROM subtasks ORDER BY task_id ASC').all() as Array<{ task_id: string }>;
    return rows.map(row => row.task_id);
  }

  findById(id: string): Subtask | null {
    const row = this.db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as SubtaskRow | undefined;
    return row ? rowToSubtask(row) : null;
  }

  updateStatus(id: string, status: SubtaskStatus, changes: {
    result?: string;
    artifacts?: string[];
    verification?: Subtask['verification'];
    error?: string | null;
  } = {}): void {
    const now = new Date().toISOString();
    const hasError = Object.prototype.hasOwnProperty.call(changes, 'error');
    this.db.prepare(`
      UPDATE subtasks
      SET status = ?,
          result = COALESCE(?, result),
          artifacts_json = COALESCE(?, artifacts_json),
          verification_json = COALESCE(?, verification_json),
          error = CASE WHEN ? THEN ? ELSE error END,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      changes.result ?? null,
      changes.artifacts ? JSON.stringify(changes.artifacts) : null,
      changes.verification ? JSON.stringify(changes.verification) : null,
      hasError ? 1 : 0,
      changes.error ?? null,
      now,
      id,
    );
  }

  deleteByTask(taskId: string): void {
    this.db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(taskId);
  }
}
