import type Database from 'better-sqlite3';

export interface WorkspacePublicationCompletion {
  body: string;
  artifacts: string[];
  warnings: string[];
  handoffs: Array<{
    toSubtaskId: string;
    items: Array<
      | { key: string; type: 'text'; value: string }
      | { key: string; type: 'artifact'; paths: string[] }
    >;
  }>;
  completionSchemaVersion: 3;
}

export type WorkspacePublicationStatus =
  | 'pending'
  | 'applying'
  | 'conflicted'
  | 'integrated'
  | 'parked'
  | 'cancelling'
  | 'cancelled'
  | 'uncertain';

export interface WorkspacePublicationRecord {
  id: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  sourceAttemptId: string;
  agentClassName: string;
  candidateCommit: string;
  originalCompletion: WorkspacePublicationCompletion;
  topologyLayer: number;
  firstDispatchOrder: number;
  repairAttemptsUsed: number;
  conflictReplansUsed: number;
  conflictChainId: string | null;
  integrationCommit: string | null;
  observedIntegrationCommit: string | null;
  status: WorkspacePublicationStatus;
  cancellationDecisionId: string | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PublicationRow {
  id: string;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  source_attempt_id: string;
  agent_class_name: string;
  candidate_commit: string;
  original_completion_json: string;
  topology_layer: number;
  first_dispatch_order: number;
  repair_attempts_used: number;
  conflict_replans_used: number;
  conflict_chain_id: string | null;
  integration_commit: string | null;
  observed_integration_commit: string | null;
  status: WorkspacePublicationStatus;
  cancellation_decision_id: string | null;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMergeAttemptInput {
  id: string;
  publicationId: string;
  decisionId: string;
  attemptId: string | null;
  ordinal: number;
  attemptKind: 'automatic' | 'repair';
  baseCommit: string;
  oursCommit: string;
  theirsCommit: string;
  conflictPaths: string[];
  filePolicy: Record<string, 'text' | 'binary'>;
  result: 'integrated' | 'conflicted' | 'failed' | 'uncertain';
  integrationCommit: string | null;
  errorSummary: string | null;
  createdAt: string;
}

export class WorkspacePublicationRepo {
  constructor(private readonly db: Database.Database) {}

  insertCandidate(input: {
    id: string;
    taskId: string;
    generationId: string;
    subtaskId: string;
    sourceAttemptId: string;
    agentClassName: string;
    candidateCommit: string;
    completion: WorkspacePublicationCompletion;
    topologyLayer: number;
    firstDispatchOrder: number;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO workspace_publications (
        id, task_id, generation_id, subtask_id, source_attempt_id, agent_class_name,
        candidate_commit, original_completion_json, topology_layer, first_dispatch_order,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.id,
      input.taskId,
      input.generationId,
      input.subtaskId,
      input.sourceAttemptId,
      input.agentClassName,
      input.candidateCommit,
      JSON.stringify(input.completion),
      input.topologyLayer,
      input.firstDispatchOrder,
      input.createdAt,
      input.createdAt,
    );
  }

  find(id: string): WorkspacePublicationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_publications WHERE id = ?
    `).get(id) as PublicationRow | undefined;
    return row ? rowToPublication(row) : null;
  }

  findBySubtask(taskId: string, generationId: string, subtaskId: string): WorkspacePublicationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_publications
      WHERE task_id = ? AND generation_id = ? AND subtask_id = ?
    `).get(taskId, generationId, subtaskId) as PublicationRow | undefined;
    return row ? rowToPublication(row) : null;
  }

  findNextBlocking(taskId: string, generationId: string): WorkspacePublicationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_publications
      WHERE task_id = ? AND generation_id = ?
        AND status IN ('pending', 'applying', 'conflicted', 'cancelling', 'uncertain')
      ORDER BY topology_layer ASC, first_dispatch_order ASC, subtask_id ASC
      LIMIT 1
    `).get(taskId, generationId) as PublicationRow | undefined;
    return row ? rowToPublication(row) : null;
  }

  recoverApplying(taskId: string, generationId: string, now: string): number {
    return this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'pending',
          error_summary = 'publication application recovered after an interrupted process',
          updated_at = ?
      WHERE task_id = ? AND generation_id = ? AND status = 'applying'
        AND EXISTS (
          SELECT 1 FROM tasks
          INNER JOIN subtasks ON subtasks.id = workspace_publications.subtask_id
          WHERE tasks.id = workspace_publications.task_id
            AND tasks.status <> 'cancelled'
            AND subtasks.status <> 'cancelled'
        )
    `).run(now, taskId, generationId).changes;
  }

  markApplying(id: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'applying', applying_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, now, id).changes === 1;
  }

  markPending(id: string, errorSummary: string | null, now: string): void {
    this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'pending', error_summary = ?, updated_at = ?
      WHERE id = ? AND status = 'applying'
    `).run(errorSummary, now, id);
  }

  markIntegrated(id: string, integrationCommit: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'integrated', integration_commit = ?, integrated_at = ?,
          error_summary = NULL, updated_at = ?
      WHERE id = ? AND status = 'applying'
    `).run(integrationCommit, now, now, id).changes === 1;
  }

  markConflicted(id: string, conflictChainId: string, errorSummary: string, now: string): void {
    this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'conflicted', conflict_chain_id = COALESCE(conflict_chain_id, ?),
          error_summary = ?, updated_at = ?
      WHERE id = ? AND status = 'applying'
    `).run(conflictChainId, errorSummary, now, id);
  }

  markPendingAfterRepair(id: string, candidateCommit: string, now: string): void {
    this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'pending', candidate_commit = ?,
          error_summary = NULL, updated_at = ?
      WHERE id = ? AND status = 'conflicted'
    `).run(candidateCommit, now, id);
  }

  recordRepairAttempt(id: string, now: string): boolean {
    return this.db.prepare(`
      UPDATE workspace_publications
      SET repair_attempts_used = repair_attempts_used + 1, updated_at = ?
      WHERE id = ? AND status = 'conflicted' AND repair_attempts_used < 3
    `).run(now, id).changes === 1;
  }

  recordRepairFailure(id: string, errorSummary: string, now: string): void {
    this.db.prepare(`
      UPDATE workspace_publications
      SET error_summary = ?, updated_at = ?
      WHERE id = ? AND status = 'conflicted'
    `).run(errorSummary, now, id);
  }

  incrementConflictReplan(id: string, now: string): void {
    this.db.prepare(`
      UPDATE workspace_publications
      SET conflict_replans_used = conflict_replans_used + 1, updated_at = ?
      WHERE id = ? AND conflict_replans_used < 1
    `).run(now, id);
  }

  markParkedForConflictReplan(id: string, now: string): void {
    this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'parked', updated_at = ?
      WHERE id = ? AND status = 'conflicted'
    `).run(now, id);
  }

  requestCancellation(input: {
    taskId: string;
    generationId?: string | null;
    subtaskIds?: readonly string[] | null;
    decisionId: string;
    now: string;
  }): WorkspacePublicationRecord[] {
    const request = this.db.transaction(() => {
      const filters = ['task_id = ?'];
      const parameters: unknown[] = [input.taskId];
      if (input.generationId) {
        filters.push('generation_id = ?');
        parameters.push(input.generationId);
      }
      if (input.subtaskIds) {
        if (input.subtaskIds.length === 0) return [];
        filters.push(`subtask_id IN (${input.subtaskIds.map(() => '?').join(', ')})`);
        parameters.push(...input.subtaskIds);
      }
      const where = filters.join(' AND ');
      this.db.prepare(`
        UPDATE workspace_publications
        SET status = 'cancelled',
            cancellation_decision_id = ?,
            cancel_requested_at = ?,
            cancelled_at = ?,
            updated_at = ?
        WHERE ${where} AND status IN ('pending', 'conflicted', 'parked')
      `).run(input.decisionId, input.now, input.now, input.now, ...parameters);
      this.db.prepare(`
        UPDATE workspace_publications
        SET status = 'cancelling',
            cancellation_decision_id = ?,
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            updated_at = ?
        WHERE ${where} AND status IN ('applying', 'uncertain')
      `).run(input.decisionId, input.now, input.now, ...parameters);
      return (this.db.prepare(`
        SELECT * FROM workspace_publications
        WHERE ${where}
          AND cancellation_decision_id = ?
          AND status IN ('cancelling', 'cancelled')
        ORDER BY topology_layer, first_dispatch_order, subtask_id
      `).all(...parameters, input.decisionId) as PublicationRow[]).map(rowToPublication);
    });
    return request();
  }

  listCancelling(taskId?: string): WorkspacePublicationRecord[] {
    const filter = taskId ? ' AND task_id = ?' : '';
    return (this.db.prepare(`
      SELECT * FROM workspace_publications
      WHERE status = 'cancelling'${filter}
      ORDER BY topology_layer, first_dispatch_order, subtask_id
    `).all(...(taskId ? [taskId] : [])) as PublicationRow[]).map(rowToPublication);
  }

  markCancelled(
    id: string,
    observedIntegrationCommit: string | null,
    now: string,
  ): boolean {
    return this.db.prepare(`
      UPDATE workspace_publications
      SET status = 'cancelled',
          observed_integration_commit = COALESCE(?, observed_integration_commit),
          cancelled_at = COALESCE(cancelled_at, ?),
          updated_at = ?
      WHERE id = ? AND status = 'cancelling'
    `).run(observedIntegrationCommit, now, now, id).changes === 1;
  }

  hasBlockingResidue(taskId: string, generationId?: string): boolean {
    const generationFilter = generationId ? ' AND generation_id = ?' : '';
    return Boolean(this.db.prepare(`
      SELECT 1 FROM workspace_publications
      WHERE task_id = ?${generationFilter}
        AND status IN ('pending', 'applying', 'conflicted', 'cancelling', 'uncertain')
      LIMIT 1
    `).get(taskId, ...(generationId ? [generationId] : [])));
  }

  countMergeAttempts(publicationId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_merge_attempts WHERE publication_id = ?
    `).get(publicationId) as { count: number };
    return row.count;
  }

  recordMergeAttempt(input: WorkspaceMergeAttemptInput): void {
    this.db.prepare(`
      INSERT INTO workspace_merge_attempts (
        id, publication_id, decision_id, attempt_id, ordinal, attempt_kind,
        base_commit, ours_commit, theirs_commit, conflict_paths_json,
        file_policy_json, result, integration_commit, error_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.publicationId,
      input.decisionId,
      input.attemptId,
      input.ordinal,
      input.attemptKind,
      input.baseCommit,
      input.oursCommit,
      input.theirsCommit,
      JSON.stringify(input.conflictPaths),
      JSON.stringify(input.filePolicy),
      input.result,
      input.integrationCommit,
      input.errorSummary,
      input.createdAt,
    );
  }
}

function rowToPublication(row: PublicationRow): WorkspacePublicationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    sourceAttemptId: row.source_attempt_id,
    agentClassName: row.agent_class_name,
    candidateCommit: row.candidate_commit,
    originalCompletion: JSON.parse(row.original_completion_json) as WorkspacePublicationCompletion,
    topologyLayer: row.topology_layer,
    firstDispatchOrder: row.first_dispatch_order,
    repairAttemptsUsed: row.repair_attempts_used,
    conflictReplansUsed: row.conflict_replans_used,
    conflictChainId: row.conflict_chain_id,
    integrationCommit: row.integration_commit,
    observedIntegrationCommit: row.observed_integration_commit,
    status: row.status,
    cancellationDecisionId: row.cancellation_decision_id,
    cancelRequestedAt: row.cancel_requested_at,
    cancelledAt: row.cancelled_at,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
