import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CapabilityGrant,
  NormalizedCapabilityRequest,
  PartitionIdentity,
  PermissionRepositoryPort,
  PermissionRequestRecord,
  PermissionRequestStatus,
  UserAuthorizationRecord,
} from '../resource/index.js';
import { partitionCanonicalKey } from '../resource/index.js';

interface PermissionRequestRow {
  id: string;
  fingerprint: string;
  task_id: string;
  generation_id: string;
  subtask_id: string;
  attempt_id: string;
  agent_class_name: string;
  permission_profile_id: NormalizedCapabilityRequest['permissionProfileId'];
  capability: NormalizedCapabilityRequest['capability'];
  resource_text: string;
  partition_json: string;
  operation: string;
  reason: string;
  suggested_scope: NormalizedCapabilityRequest['suggestedScope'];
  distinct_request_ordinal: number;
  status: PermissionRequestStatus;
  decision_id: string | null;
  decision_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface PermissionGrantRow {
  id: string;
  request_id: string;
  fingerprint: string;
  task_id: string;
  subtask_id: string;
  attempt_id: string;
  capability: CapabilityGrant['capability'];
  partition_json: string;
  operation: string;
  grant_scope: CapabilityGrant['scope'];
  expires_at: string;
  max_calls: number;
  max_bytes: number;
  calls_used: number;
  bytes_used: number;
  revoked_at: string | null;
}

function requestFromRow(row: PermissionRequestRow): PermissionRequestRecord {
  return {
    request: {
      id: row.id,
      fingerprint: row.fingerprint,
      taskId: row.task_id,
      generationId: row.generation_id,
      subtaskId: row.subtask_id,
      attemptId: row.attempt_id,
      agentClassName: row.agent_class_name,
      permissionProfileId: row.permission_profile_id,
      capability: row.capability,
      resource: row.resource_text,
      partition: JSON.parse(row.partition_json) as PartitionIdentity,
      operation: row.operation,
      reason: row.reason,
      suggestedScope: row.suggested_scope,
      distinctRequestOrdinal: row.distinct_request_ordinal,
    },
    status: row.status,
    decisionId: row.decision_id,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function grantFromRow(row: PermissionGrantRow): CapabilityGrant {
  return {
    id: row.id,
    requestId: row.request_id,
    fingerprint: row.fingerprint,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    attemptId: row.attempt_id,
    capability: row.capability,
    partition: JSON.parse(row.partition_json) as PartitionIdentity,
    operation: row.operation,
    scope: row.grant_scope,
    limits: { expiresAt: row.expires_at, maxCalls: row.max_calls, maxBytes: row.max_bytes },
    callsUsed: row.calls_used,
    bytesUsed: row.bytes_used,
    revokedAt: row.revoked_at,
  };
}

export class SqlitePermissionRepository implements PermissionRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  createRequest(request: NormalizedCapabilityRequest, createdAt: string): PermissionRequestRecord {
    this.db.prepare(`
      INSERT INTO permission_requests (
        id, fingerprint, task_id, generation_id, subtask_id, attempt_id,
        agent_class_name, permission_profile_id, capability, resource_text,
        partition_key, partition_json, operation, reason, suggested_scope,
        distinct_request_ordinal, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(attempt_id, fingerprint) DO NOTHING
    `).run(
      request.id, request.fingerprint, request.taskId, request.generationId,
      request.subtaskId, request.attemptId, request.agentClassName,
      request.permissionProfileId, request.capability, request.resource,
      partitionCanonicalKey(request.partition), JSON.stringify(request.partition), request.operation, request.reason,
      request.suggestedScope, request.distinctRequestOrdinal, createdAt,
    );
    const row = this.db.prepare(`
      SELECT * FROM permission_requests WHERE attempt_id = ? AND fingerprint = ?
    `).get(request.attemptId, request.fingerprint) as PermissionRequestRow;
    return requestFromRow(row);
  }

  findRequest(requestId: string): PermissionRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(requestId) as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findPendingForTask(taskId: string): PermissionRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM permission_requests WHERE task_id = ? AND status IN ('pending', 'escalated')
      ORDER BY created_at, id LIMIT 1
    `).get(taskId) as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findOldestPending(): PermissionRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM permission_requests WHERE status IN ('pending', 'escalated')
      ORDER BY created_at, id LIMIT 1
    `).get() as PermissionRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  listEscalated(): PermissionRequestRecord[] {
    return (this.db.prepare(`
      SELECT * FROM permission_requests WHERE status = 'escalated'
      ORDER BY created_at ASC, id ASC
    `).all() as PermissionRequestRow[]).map(requestFromRow);
  }

  countDistinctForAttempt(attemptId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM permission_requests WHERE attempt_id = ?')
      .get(attemptId) as { count: number }).count;
  }

  listGrants(attemptId: string): CapabilityGrant[] {
    return (this.db.prepare('SELECT * FROM permission_grants WHERE attempt_id = ? ORDER BY created_at, id')
      .all(attemptId) as PermissionGrantRow[]).map(grantFromRow);
  }

  listDeniedFingerprints(attemptId: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT fingerprint FROM permission_requests WHERE attempt_id = ? AND status = 'denied'
    `).all(attemptId) as Array<{ fingerprint: string }>).map(row => row.fingerprint);
  }

  listApprovedFingerprints(taskId: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT fingerprint FROM user_authorizations WHERE task_id = ? AND resolution = 'approve'
    `).all(taskId) as Array<{ fingerprint: string }>).map(row => row.fingerprint);
  }

  consumeGrant(grantId: string, attemptId: string, bytes: number, at: string): CapabilityGrant | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('grant byte usage must be a non-negative safe integer');
    const transaction = this.db.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE permission_grants
        SET calls_used = calls_used + 1, bytes_used = bytes_used + ?
        WHERE id = ? AND attempt_id = ? AND revoked_at IS NULL AND expires_at > ?
          AND calls_used < max_calls AND bytes_used + ? <= max_bytes
      `).run(bytes, grantId, attemptId, at, bytes).changes;
      if (changed !== 1) return null;
      return grantFromRow(this.db.prepare('SELECT * FROM permission_grants WHERE id = ?').get(grantId) as PermissionGrantRow);
    });
    return transaction.immediate();
  }

  grant(input: Parameters<PermissionRepositoryPort['grant']>[0]): CapabilityGrant {
    const transaction = this.db.transaction(() => {
      this.insertAuthorization(input.request, input.authorization, input.grantedAt);
      const id = `permission_grant_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO permission_grants (
          id, request_id, fingerprint, decision_id, task_id, subtask_id,
          attempt_id, capability, partition_key, partition_json, operation,
          grant_scope, expires_at, max_calls, calls_used, max_bytes, bytes_used,
          revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, NULL, ?)
        ON CONFLICT(request_id) DO NOTHING
      `).run(
        id, input.request.id, input.request.fingerprint, input.decisionId,
        input.request.taskId, input.request.subtaskId, input.request.attemptId,
        input.request.capability, partitionCanonicalKey(input.request.partition), JSON.stringify(input.request.partition),
        input.request.operation, input.request.suggestedScope, input.limits.expiresAt,
        input.limits.maxCalls, input.limits.maxBytes, input.grantedAt,
      );
      this.db.prepare(`
        UPDATE permission_requests SET status = 'granted', decision_id = ?,
          decision_reason = 'granted', resolved_at = ? WHERE id = ?
      `).run(input.decisionId, input.grantedAt, input.request.id);
      return grantFromRow(this.db.prepare('SELECT * FROM permission_grants WHERE request_id = ?')
        .get(input.request.id) as PermissionGrantRow);
    });
    return transaction.immediate();
  }

  deny(input: Parameters<PermissionRepositoryPort['deny']>[0]): void {
    const transaction = this.db.transaction(() => {
      this.insertAuthorization(input.request, input.authorization, input.deniedAt);
      this.db.prepare(`
        UPDATE permission_requests SET status = 'denied', decision_id = ?,
          decision_reason = ?, resolved_at = ? WHERE id = ?
      `).run(input.decisionId, input.reason, input.deniedAt, input.request.id);
    });
    transaction.immediate();
  }

  escalate(requestId: string, decisionId: string, reason: string, at: string): void {
    this.db.prepare(`
      UPDATE permission_requests SET status = 'escalated', decision_id = ?, decision_reason = ?, resolved_at = NULL
      WHERE id = ? AND status IN ('pending', 'escalated')
    `).run(decisionId, reason, requestId);
  }

  recordAuthorization(
    request: NormalizedCapabilityRequest,
    authorization: Omit<UserAuthorizationRecord, 'id' | 'requestId' | 'fingerprint' | 'taskId' | 'createdAt'>,
    at: string,
  ): void {
    this.insertAuthorization(request, authorization, at);
  }

  private insertAuthorization(
    request: NormalizedCapabilityRequest,
    authorization: Parameters<PermissionRepositoryPort['grant']>[0]['authorization'],
    createdAt: string,
  ): void {
    if (!authorization) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO user_authorizations (
        id, request_id, fingerprint, task_id, resolution, source,
        planner_plan_id, received_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `user_authorization_${randomUUID()}`, request.id, request.fingerprint,
      request.taskId, authorization.resolution, authorization.source,
      authorization.plannerPlanId, authorization.receivedEventId, createdAt,
    );
  }
}
