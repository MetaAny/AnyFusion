// SQLite FTS adapter for indexing and searching task, snapshot, artifact, and memory-card text.
import type Database from 'better-sqlite3';
import type { Task, TaskSnapshot } from '../core/types.js';
import type { TaskMemoryCardRecord } from './task-memory-card-repo.js';

export type TaskSearchSourceKind = 'task' | 'snapshot' | 'memory_card' | 'artifact' | 'interaction';

export interface TaskSearchIndexRecord {
  taskId: string;
  sourceKind: TaskSearchSourceKind;
  sourceId: string;
  title: string;
  body: string;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSearchResult {
  taskId: string;
  sourceKind: TaskSearchSourceKind;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  createdAt: string;
  updatedAt: string;
}

interface TaskSearchIndexRow {
  task_id: string;
  source_kind: TaskSearchSourceKind;
  source_id: string;
  title: string;
  snippet: string;
  score: number;
  created_at: string;
  updated_at: string;
}

const MAX_INDEX_BODY_LENGTH = 4000;

function truncateIndexText(value: string): string {
  return value.length > MAX_INDEX_BODY_LENGTH ? value.slice(0, MAX_INDEX_BODY_LENGTH) : value;
}

function normalizeList(values: string[]): string[] {
  return values
    .map(value => value.trim())
    .filter(Boolean);
}

function buildSnapshotBody(snapshot: TaskSnapshot): string {
  return [
    ...snapshot.done.map(item => `done: ${item}`),
    ...snapshot.pending.map(item => `pending: ${item}`),
    `nextStep: ${snapshot.nextStep}`,
    `pauseReason: ${snapshot.pauseReason}`,
  ].join('\n');
}

function rowToResult(row: TaskSearchIndexRow): TaskSearchResult {
  return {
    taskId: row.task_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    title: row.title,
    snippet: row.snippet,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildSafeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean)
    .map(term => `"${term.replace(/"/g, '""')}"`)
    .join(' ');
}

export class TaskSearchIndexRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(record: TaskSearchIndexRecord): void {
    this.db.prepare(`
      DELETE FROM task_search_index
      WHERE source_kind = ? AND source_id = ?
    `).run(record.sourceKind, record.sourceId);

    this.db.prepare(`
      INSERT INTO task_search_index (
        task_id, source_kind, source_id, title, body, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.sourceKind,
      record.sourceId,
      record.title,
      truncateIndexText(record.body),
      record.tags,
      record.createdAt,
      record.updatedAt,
    );
  }

  deleteBySource(sourceKind: TaskSearchSourceKind, sourceId: string): void {
    this.db.prepare(`
      DELETE FROM task_search_index
      WHERE source_kind = ? AND source_id = ?
    `).run(sourceKind, sourceId);
  }

  deleteByTaskId(taskId: string): void {
    this.db.prepare('DELETE FROM task_search_index WHERE task_id = ?').run(taskId);
  }

  deleteByTaskAndSourceKinds(taskId: string, sourceKinds: TaskSearchSourceKind[]): void {
    if (sourceKinds.length === 0) {
      return;
    }
    const placeholders = sourceKinds.map(() => '?').join(', ');
    this.db.prepare(`
      DELETE FROM task_search_index
      WHERE task_id = ? AND source_kind IN (${placeholders})
    `).run(taskId, ...sourceKinds);
  }

  clear(): void {
    this.db.prepare('DELETE FROM task_search_index').run();
  }

  indexTask(task: Task): void {
    this.deleteByTaskAndSourceKinds(task.id, ['task', 'snapshot', 'artifact']);

    this.upsert({
      taskId: task.id,
      sourceKind: 'task',
      sourceId: task.id,
      title: task.title,
      body: [
        task.goal,
        task.summary,
        ...normalizeList(task.resources).map(resource => `resource: ${resource}`),
        ...normalizeList(task.artifacts).map(artifact => `artifact: ${artifact}`),
        ...task.dependencies.map(dep => `dependency: ${dep.description} ${dep.status}`),
      ].join('\n'),
      tags: [
        'task',
        task.status,
        ...normalizeList(task.resources),
        ...normalizeList(task.artifacts),
      ].join(' '),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });

    task.snapshots.forEach((snapshot, index) => {
      this.upsert({
        taskId: task.id,
        sourceKind: 'snapshot',
        sourceId: `${task.id}:snapshot:${index}:${snapshot.createdAt}`,
        title: `${task.title} snapshot`,
        body: buildSnapshotBody(snapshot),
        tags: 'snapshot task-progress',
        createdAt: snapshot.createdAt,
        updatedAt: task.updatedAt,
      });
    });

    for (const artifact of normalizeList(task.artifacts)) {
      this.upsert({
        taskId: task.id,
        sourceKind: 'artifact',
        sourceId: `${task.id}:artifact:${artifact}`,
        title: task.title,
        body: artifact,
        tags: 'artifact',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }
  }

  indexMemoryCard(card: TaskMemoryCardRecord): void {
    this.deleteByTaskAndSourceKinds(card.taskId, ['memory_card']);

    this.upsert({
      taskId: card.taskId,
      sourceKind: 'memory_card',
      sourceId: card.id,
      title: card.title,
      body: [
        card.goal,
        card.summary,
        ...card.keyDecisions.map(item => `decision: ${item}`),
        ...card.changedFiles.map(item => `changedFile: ${item}`),
        ...card.verificationCommands.map(item => `verification: ${item}`),
        ...card.pitfalls.map(item => `pitfall: ${item}`),
        ...card.artifacts.map(item => `artifact: ${item}`),
        `outcome: ${card.outcome}`,
      ].join('\n'),
      tags: [
        'memory-card',
        card.outcome,
        ...card.changedFiles,
        ...card.artifacts,
      ].join(' '),
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    });
  }

  rebuild(): number {
    const transaction = this.db.transaction(() => {
      this.clear();

      const tasks = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as Array<{
        id: string;
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
      }>;

      for (const row of tasks) {
        if (row.source === 'system_smoke') continue;
        this.indexTask({
          id: row.id,
          title: row.title,
          goal: row.goal,
          source: row.source,
          smokeRunId: row.smoke_run_id,
          status: row.status as Task['status'],
          summary: row.summary,
          snapshots: JSON.parse(row.snapshot_json || '[]'),
          resources: JSON.parse(row.resources_json || '[]'),
          artifacts: JSON.parse(row.artifacts_json ?? '[]'),
          dependencies: JSON.parse(row.dependencies_json || '[]'),
          prioritySignals: row.priority_json
            ? JSON.parse(row.priority_json)
            : { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
          injectedPreferences: JSON.parse(row.injected_prefs_json || '[]'),
          lastSchedulingReason: row.last_scheduling_reason ?? '',
          lastInterruptionReason: row.last_interruption_reason ?? '',
          interruptionCount: row.interruption_count ?? 0,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }

      const cards = this.db.prepare('SELECT * FROM task_memory_cards ORDER BY updated_at DESC').all() as Array<{
        id: string;
        task_id: string;
        title: string;
        goal: string;
        summary: string;
        key_decisions_json: string;
        changed_files_json: string;
        verification_commands_json: string;
        pitfalls_json: string;
        artifacts_json: string;
        outcome: TaskMemoryCardRecord['outcome'];
        source_candidate_id: string | null;
        created_at: string;
        updated_at: string;
      }>;

      for (const row of cards) {
        this.indexMemoryCard({
          id: row.id,
          taskId: row.task_id,
          title: row.title,
          goal: row.goal,
          summary: row.summary,
          keyDecisions: JSON.parse(row.key_decisions_json || '[]'),
          changedFiles: JSON.parse(row.changed_files_json || '[]'),
          verificationCommands: JSON.parse(row.verification_commands_json || '[]'),
          pitfalls: JSON.parse(row.pitfalls_json || '[]'),
          artifacts: JSON.parse(row.artifacts_json || '[]'),
          outcome: row.outcome,
          sourceCandidateId: row.source_candidate_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }

      const interactions = this.db.prepare(`
        SELECT id, task_id, user_input, system_output, created_at
        FROM interactions
        WHERE task_id IS NOT NULL
        ORDER BY created_at DESC
      `).all() as Array<{
        id: string;
        task_id: string;
        user_input: string | null;
        system_output: string | null;
        created_at: string;
      }>;

      for (const interaction of interactions) {
        this.upsert({
          taskId: interaction.task_id,
          sourceKind: 'interaction',
          sourceId: interaction.id,
          title: '',
          body: [interaction.user_input ?? '', interaction.system_output ?? ''].join('\n'),
          tags: 'interaction',
          createdAt: interaction.created_at,
          updatedAt: interaction.created_at,
        });
      }
    });

    transaction();
    return this.count();
  }

  search(query: string, limit = 20): TaskSearchResult[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT
        task_id,
        source_kind,
        source_id,
        title,
        snippet(task_search_index, 4, '[', ']', ' ... ', 64) AS snippet,
        bm25(task_search_index) * -1 AS score,
        created_at,
        updated_at
      FROM task_search_index
      WHERE task_search_index MATCH ?
      ORDER BY bm25(task_search_index), updated_at DESC
      LIMIT ?
    `).all(buildSafeFtsQuery(normalizedQuery), limit) as TaskSearchIndexRow[];

    return rows.map(rowToResult);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM task_search_index').get() as { count: number };
    return row.count;
  }
}
