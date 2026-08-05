import type {
  AccessMode,
  PartitionIdentity,
  ResourceClaim,
  CapabilityGrant,
  NormalizedCapabilityRequest,
} from './types.js';

export interface ResourceLeaseRecord extends ResourceClaim {
  id: string;
  partitionKey: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  workUnitId: string;
  leaseToken: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  revocationRequestedAt?: string | null;
  revocationReason?: string | null;
  createdAt: string;
}

export interface ResourceWaitRecord {
  id: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  partition: PartitionIdentity;
  partitionKey: string;
  access: AccessMode;
  conflictingLeaseIds: string[];
  status: 'waiting' | 'resolved' | 'cancelled';
  requestedAt: string;
  resolvedAt: string | null;
}

export interface ClaimResourceLeasesInput {
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  workUnitId: string;
  leaseToken: string;
  claims: ResourceClaim[];
  now: string;
  expiresAt: string;
}

export type ClaimResourceLeasesResult =
  | { type: 'claimed'; leases: ResourceLeaseRecord[] }
  | { type: 'conflict'; waits: ResourceWaitRecord[]; conflictingLeases: ResourceLeaseRecord[] };

export interface ResourceLeaseRepositoryPort {
  claim(input: ClaimResourceLeasesInput): ClaimResourceLeasesResult;
  heartbeat(attemptId: string, leaseToken: string, now: string, expiresAt: string): number;
  releaseAttempt(attemptId: string, leaseToken: string, releasedAt: string): number;
  releaseReconciledAttempt(attemptId: string, releasedAt: string): number;
  findActive(now: string): ResourceLeaseRecord[];
  findWaits(attemptId: string): ResourceWaitRecord[];
  requestRevocation?(
    taskId: string,
    generationId: string | null,
    subtaskIds: readonly string[] | null,
    reason: string,
    now: string,
  ): number;
  cancelWaits?(
    taskId: string,
    generationId: string | null,
    subtaskIds: readonly string[] | null,
    now: string,
  ): number;
  releaseRevokedAttempt?(attemptId: string, now: string): number;
}

export type PermissionRequestStatus = 'pending' | 'granted' | 'denied' | 'escalated' | 'expired';

export interface PermissionRequestRecord {
  request: NormalizedCapabilityRequest;
  status: PermissionRequestStatus;
  decisionId: string | null;
  decisionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface UserAuthorizationRecord {
  id: string;
  requestId: string;
  fingerprint: string;
  taskId: string;
  resolution: 'approve' | 'deny';
  source: 'command' | 'button' | 'planner';
  plannerPlanId: string | null;
  receivedEventId: string;
  createdAt: string;
}

export interface PermissionRepositoryPort {
  createRequest(request: NormalizedCapabilityRequest, createdAt: string): PermissionRequestRecord;
  findRequest(requestId: string): PermissionRequestRecord | null;
  findPendingForTask(taskId: string): PermissionRequestRecord | null;
  findOldestPending(): PermissionRequestRecord | null;
  listEscalated(): PermissionRequestRecord[];
  countDistinctForAttempt(attemptId: string): number;
  listGrants(attemptId: string): CapabilityGrant[];
  listDeniedFingerprints(attemptId: string): string[];
  listApprovedFingerprints(taskId: string): string[];
  consumeGrant(grantId: string, attemptId: string, bytes: number, at: string): CapabilityGrant | null;
  grant(input: {
    decisionId: string;
    request: NormalizedCapabilityRequest;
    limits: CapabilityGrant['limits'];
    grantedAt: string;
    authorization?: Omit<UserAuthorizationRecord, 'id' | 'requestId' | 'fingerprint' | 'taskId' | 'createdAt'>;
  }): CapabilityGrant;
  deny(input: {
    decisionId: string;
    request: NormalizedCapabilityRequest;
    reason: string;
    deniedAt: string;
    authorization?: Omit<UserAuthorizationRecord, 'id' | 'requestId' | 'fingerprint' | 'taskId' | 'createdAt'>;
  }): void;
  escalate(requestId: string, decisionId: string, reason: string, at: string): void;
  recordAuthorization(
    request: NormalizedCapabilityRequest,
    authorization: Omit<UserAuthorizationRecord, 'id' | 'requestId' | 'fingerprint' | 'taskId' | 'createdAt'>,
    at: string,
  ): void;
}
