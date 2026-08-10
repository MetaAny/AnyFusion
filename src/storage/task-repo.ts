import type Database from 'better-sqlite3';
import type { Task, TaskSnapshot, TaskStatus, PrioritySignals, Dependency } from '../core/types.js';
import type { TaskSearchIndexRepo } from './task-search-index-repo.js';

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  source: Task['source'];
  smoke_run_id: string | null;
  status: string;
  summary: string;
  snapshot_json: string;
  resources_json: string;
  artifacts_json: string | null;
  dependencies_json: string;
  priority_json: string | null;
  injected_prefs_json: string;
  last_scheduling_reason: string | null;
  last_interruption_reason: string | null;
  interruption_count: number | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    source: row.source,
    smokeRunId: row.smoke_run_id,
    status: row.status as TaskStatus,
    summary: row.summary,
    snapshots: JSON.parse(row.snapshot_json),
    resources: JSON.parse(row.resources_json),
    artifacts: JSON.parse(row.artifacts_json ?? '[]'),
    dependencies: JSON.parse(row.dependencies_json),
    prioritySignals: row.priority_json
      ? JSON.parse(row.priority_json)
      : { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: JSON.parse(row.injected_prefs_json),
    lastSchedulingReason: row.last_scheduling_reason ?? '',
    lastInterruptionReason: row.last_interruption_reason ?? '',
    interruptionCount: row.interruption_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskRepo {
  constructor(
    private db: Database.Database,
    private readonly taskSearchIndexRepo?: TaskSearchIndexRepo,
  ) {}

  insert(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (id, project_id, title, goal, source, smoke_run_id, status, summary, snapshot_json, resources_json, artifacts_json,
        dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.projectId, task.title, task.goal, task.source, task.smokeRunId, task.status, task.summary,
      JSON.stringify(task.snapshots), JSON.stringify(task.resources),
      JSON.stringify(task.artifacts),
      JSON.stringify(task.dependencies), JSON.stringify(task.prioritySignals),
      JSON.stringify(task.injectedPreferences), task.lastSchedulingReason,
      task.lastInterruptionReason, task.interruptionCount, task.createdAt, task.updatedAt,
    );
    this.taskSearchIndexRepo?.indexTask(task);
  }

  findById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  findByStatus(status: TaskStatus, options: { includeSystemSmoke?: boolean } = {}): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = ? ${options.includeSystemSmoke ? '' : "AND source <> 'system_smoke'"}
      ORDER BY updated_at DESC
    `).all(status) as TaskRow[];
    return rows.map(rowToTask);
  }

  findActive(options: { includeSystemSmoke?: boolean } = {}): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks
       WHERE status IN ('created', 'ready', 'running', 'parked', 'blocked')
       ${options.includeSystemSmoke ? '' : "AND source <> 'system_smoke'"}
       ORDER BY updated_at DESC`
    ).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  findAll(options: { includeSystemSmoke?: boolean } = {}): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      ${options.includeSystemSmoke ? '' : "WHERE source <> 'system_smoke'"}
      ORDER BY updated_at DESC
    `).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  update(id: string, changes: Partial<Task>): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (changes.title !== undefined) { sets.push('title = ?'); values.push(changes.title); }
    if (changes.goal !== undefined) { sets.push('goal = ?'); values.push(changes.goal); }
    if (changes.source !== undefined) { sets.push('source = ?'); values.push(changes.source); }
    if (changes.smokeRunId !== undefined) { sets.push('smoke_run_id = ?'); values.push(changes.smokeRunId); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.summary !== undefined) { sets.push('summary = ?'); values.push(changes.summary); }
    if (changes.snapshots !== undefined) { sets.push('snapshot_json = ?'); values.push(JSON.stringify(changes.snapshots)); }
    if (changes.resources !== undefined) { sets.push('resources_json = ?'); values.push(JSON.stringify(changes.resources)); }
    if (changes.artifacts !== undefined) { sets.push('artifacts_json = ?'); values.push(JSON.stringify(changes.artifacts)); }
    if (changes.dependencies !== undefined) { sets.push('dependencies_json = ?'); values.push(JSON.stringify(changes.dependencies)); }
    if (changes.prioritySignals !== undefined) { sets.push('priority_json = ?'); values.push(JSON.stringify(changes.prioritySignals)); }
    if (changes.injectedPreferences !== undefined) { sets.push('injected_prefs_json = ?'); values.push(JSON.stringify(changes.injectedPreferences)); }
    if (changes.lastSchedulingReason !== undefined) { sets.push('last_scheduling_reason = ?'); values.push(changes.lastSchedulingReason); }
    if (changes.lastInterruptionReason !== undefined) { sets.push('last_interruption_reason = ?'); values.push(changes.lastInterruptionReason); }
    if (changes.interruptionCount !== undefined) { sets.push('interruption_count = ?'); values.push(changes.interruptionCount); }

    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const updatedTask = this.findById(id);
    if (updatedTask) {
      this.taskSearchIndexRepo?.indexTask(updatedTask);
    }
  }

  updateStatus(id: string, status: TaskStatus): void {
    this.update(id, { status });
  }

  appendSnapshot(id: string, snapshot: TaskSnapshot): void {
    const task = this.findById(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    const snapshots = [...task.snapshots, snapshot];
    this.update(id, { snapshots });
  }
}
