import type Database from 'better-sqlite3';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { generateInteractionId } from '../utils/id.js';

export type ExecutionEvidenceKind = 'user_input' | 'task_resource' | 'task_evidence' | 'preference' | 'assistant_ref';

export interface EvidenceDescriptor {
  evidenceId: string;
  kind: ExecutionEvidenceKind;
  title: string;
  length: number;
  createdAt: string;
}

export interface EvidencePage {
  items: EvidenceDescriptor[];
  nextCursor: string | null;
}

export interface EvidenceChunk {
  evidenceId: string;
  content: string;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
}

export interface ExecutionEvidencePort {
  list(input: { cursor?: string; limit?: number }): EvidencePage;
  search(input: { query: string; cursor?: string; limit?: number }): EvidencePage;
  get(input: { evidenceId: string; offset?: number }): EvidenceChunk;
}

interface EvidenceRow {
  id: string;
  task_id: string;
  kind: ExecutionEvidenceKind;
  source_id: string | null;
  title: string;
  content: string;
  exact_only: number;
  created_at: string;
}

export interface TaskEvidenceRecord {
  id: string;
  taskId: string;
  sourceId: string;
  title: string;
  content: string;
  createdAt: string;
}

export class TaskExecutionEvidenceRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: {
    id: string;
    taskId: string;
    kind: ExecutionEvidenceKind;
    sourceId?: string | null;
    title: string;
    content: string;
    exactOnly?: boolean;
    createdAt?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO task_execution_evidence (
        id, task_id, kind, source_id, title, content, exact_only, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content
    `).run(
      input.id,
      input.taskId,
      input.kind,
      input.sourceId ?? null,
      input.title,
      input.content,
      input.exactOnly ? 1 : 0,
      input.createdAt ?? new Date().toISOString(),
    );
  }

  findForTask(taskId: string, evidenceId: string): EvidenceRow | null {
    return this.db.prepare(`
      SELECT * FROM task_execution_evidence WHERE task_id = ? AND id = ?
    `).get(taskId, evidenceId) as EvidenceRow | undefined ?? null;
  }

  listGeneral(taskId: string): EvidenceRow[] {
    return this.db.prepare(`
      SELECT * FROM task_execution_evidence
      WHERE task_id = ? AND exact_only = 0
      ORDER BY created_at ASC, id ASC
    `).all(taskId) as EvidenceRow[];
  }

  listTaskEvidenceByGeneration(taskId: string, generationId: string): TaskEvidenceRecord[] {
    const rows = this.db.prepare(`
      SELECT evidence.id, evidence.task_id, evidence.source_id, evidence.title,
        evidence.content, evidence.created_at
      FROM task_execution_evidence evidence
      INNER JOIN subtasks subtask
        ON subtask.id = evidence.source_id
       AND subtask.task_id = evidence.task_id
      WHERE evidence.task_id = ?
        AND evidence.kind = 'task_evidence'
        AND subtask.generation_id = ?
      ORDER BY evidence.created_at ASC, evidence.id ASC
    `).all(taskId, generationId) as Array<{
      id: string;
      task_id: string;
      source_id: string;
      title: string;
      content: string;
      created_at: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      taskId: row.task_id,
      sourceId: row.source_id,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  materializeInteraction(input: {
    taskId: string;
    sessionId: string;
    interactionId: string;
    side: 'user' | 'assistant';
  }): string {
    const row = this.db.prepare(`
      SELECT id, user_input, system_output, created_at
      FROM interactions WHERE id = ? AND session_id = ?
    `).get(input.interactionId, input.sessionId) as {
      id: string;
      user_input: string;
      system_output: string;
      created_at: string;
    } | undefined;
    if (!row) throw new Error(`interaction_not_authorized: ${input.interactionId}`);
    const evidenceId = createEvidenceId(`${input.side}_interaction`, row.id);
    this.upsert({
      id: evidenceId,
      taskId: input.taskId,
      kind: input.side === 'assistant' ? 'assistant_ref' : 'user_input',
      sourceId: row.id,
      title: `${input.side} interaction ${row.id}`,
      content: input.side === 'user' ? row.user_input : row.system_output,
      exactOnly: input.side === 'assistant',
      createdAt: row.created_at,
    });
    return evidenceId;
  }
}

/** Attempt-lifetime capability: task identity is closed over and cannot be supplied by callers. */
export class ScopedExecutionEvidencePort implements ExecutionEvidencePort {
  private active = true;

  constructor(
    private readonly repo: TaskExecutionEvidenceRepo,
    private readonly events: TaskEventRepo,
    private readonly scope: {
      taskId: string;
      subtaskId: string;
      attemptId: string;
      exactEvidenceIds: Set<string>;
    },
  ) {}

  revoke(): void {
    this.active = false;
  }

  list(input: { cursor?: string; limit?: number }): EvidencePage {
    this.assertActive();
    const result = paginate(this.repo.listGeneral(this.scope.taskId), input.cursor, input.limit);
    this.audit('list', input.cursor ?? null, result.items.length);
    return result;
  }

  search(input: { query: string; cursor?: string; limit?: number }): EvidencePage {
    this.assertActive();
    const query = input.query.trim().toLocaleLowerCase();
    if (!query) throw new Error('evidence search query must be non-empty');
    const rows = this.repo.listGeneral(this.scope.taskId).filter(row =>
      row.title.toLocaleLowerCase().includes(query) || row.content.toLocaleLowerCase().includes(query)
    );
    const result = paginate(rows, input.cursor, input.limit);
    this.audit('search', input.query, result.items.length);
    return result;
  }

  get(input: { evidenceId: string; offset?: number }): EvidenceChunk {
    this.assertActive();
    const row = this.repo.findForTask(this.scope.taskId, input.evidenceId);
    if (!row || (row.exact_only === 1 && !this.scope.exactEvidenceIds.has(row.id))) {
      this.audit('get_denied', input.evidenceId, 0);
      throw new Error('evidence_not_authorized');
    }
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const content = row.content.slice(offset, offset + 12_000);
    const nextOffset = offset + content.length < row.content.length ? offset + content.length : null;
    this.audit('get', input.evidenceId, content ? 1 : 0);
    return {
      evidenceId: row.id,
      content,
      offset,
      nextOffset,
      truncated: nextOffset !== null,
    };
  }

  private assertActive(): void {
    if (!this.active) throw new Error('evidence_capability_expired');
  }

  private audit(queryType: string, reference: string | null, resultCount: number): void {
    this.events.record({
      taskId: this.scope.taskId,
      subtaskId: this.scope.subtaskId,
      eventType: 'executor_evidence_accessed',
      message: queryType,
      payload: { attemptId: this.scope.attemptId, queryType, reference, resultCount },
    });
  }
}

function paginate(rows: EvidenceRow[], cursor: string | undefined, requestedLimit: number | undefined): EvidencePage {
  const limit = Math.max(1, Math.min(20, Math.floor(requestedLimit ?? 20)));
  const offset = decodeCursor(cursor);
  const selected = rows.slice(offset, offset + limit);
  return {
    items: selected.map(row => ({
      evidenceId: row.id,
      kind: row.kind,
      title: row.title,
      length: row.content.length,
      createdAt: row.created_at,
    })),
    nextCursor: offset + selected.length < rows.length ? encodeCursor(offset + selected.length) : null,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_evidence_cursor');
  return value;
}

export function createEvidenceId(kind: string, sourceId: string): string {
  return `evidence_${kind}_${sourceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || generateInteractionId()}`;
}
