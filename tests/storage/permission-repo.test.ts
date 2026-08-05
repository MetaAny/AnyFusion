import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import type { NormalizedCapabilityRequest } from '../../src/resource/index.js';

function request(id = 'request-1'): NormalizedCapabilityRequest {
  return {
    id, fingerprint: `fingerprint-${id}`, taskId: 'task-1', generationId: 'gen-1',
    subtaskId: 'subtask-1', attemptId: 'attempt-1', agentClassName: 'codex-cli',
    permissionProfileId: 'workspace-engineering', capability: 'network_target',
    resource: 'https://example.com/data', partition: {
      kind: 'external_object', provider: 'https', account: 'public', collection: 'example.com', objectId: '/data',
    },
    operation: 'GET', reason: 'read public input', suggestedScope: 'attempt', distinctRequestOrdinal: 1,
  };
}

describe('SqlitePermissionRepository grant budgets', () => {
  it('atomically enforces attempt, TTL, call, and byte bounds', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = OFF');
    const repo = new SqlitePermissionRepository(db);
    const normalized = request();
    repo.createRequest(normalized, '2026-07-22T00:00:00.000Z');
    const grant = repo.grant({
      decisionId: 'decision-1', request: normalized, grantedAt: '2026-07-22T00:00:01.000Z',
      limits: { expiresAt: '2026-07-22T00:05:00.000Z', maxCalls: 2, maxBytes: 10 },
    });

    expect(repo.consumeGrant(grant.id, 'wrong-attempt', 1, '2026-07-22T00:00:02.000Z')).toBeNull();
    expect(repo.consumeGrant(grant.id, 'attempt-1', 6, '2026-07-22T00:00:02.000Z')).toMatchObject({ callsUsed: 1, bytesUsed: 6 });
    expect(repo.consumeGrant(grant.id, 'attempt-1', 5, '2026-07-22T00:00:03.000Z')).toBeNull();
    expect(repo.consumeGrant(grant.id, 'attempt-1', 4, '2026-07-22T00:00:03.000Z')).toMatchObject({ callsUsed: 2, bytesUsed: 10 });
    expect(repo.consumeGrant(grant.id, 'attempt-1', 0, '2026-07-22T00:00:04.000Z')).toBeNull();
    expect(repo.consumeGrant(grant.id, 'attempt-1', 0, '2026-07-22T00:06:00.000Z')).toBeNull();
  });

  it('lists only escalated requests in stable created-at and request-id order', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = OFF');
    const repo = new SqlitePermissionRepository(db);
    for (const [id, createdAt] of [
      ['request-b', '2026-08-04T00:00:01.000Z'],
      ['request-c', '2026-08-04T00:00:00.000Z'],
      ['request-a', '2026-08-04T00:00:00.000Z'],
    ] as const) {
      const normalized = request(id);
      repo.createRequest(normalized, createdAt);
      repo.escalate(id, `decision-${id}`, 'approval required', createdAt);
    }
    repo.createRequest(request('request-pending'), '2026-08-03T00:00:00.000Z');

    expect(repo.listEscalated().map(record => record.request.id)).toEqual([
      'request-a', 'request-c', 'request-b',
    ]);
  });
});
