export interface AttemptSandboxPersistenceRecord {
  attemptId: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  workUnitId: string;
  workspaceId: string;
  runtimeHandle: string;
  processId: number | null;
  status: 'created' | 'running' | 'paused' | 'exited' | 'removed' | 'lost';
  leaseToken: string;
  labels: Record<string, string>;
  exitCode: number | null;
  resultCollectedAt: string | null;
  cleanupStatus: string | null;
  cleanupError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptSandboxRepositoryPort {
  create(record: AttemptSandboxPersistenceRecord): AttemptSandboxPersistenceRecord;
  find(attemptId: string): AttemptSandboxPersistenceRecord | null;
  findByRuntimeHandle(runtimeHandle: string): AttemptSandboxPersistenceRecord | null;
  listActive(): AttemptSandboxPersistenceRecord[];
  update(attemptId: string, changes: Partial<Pick<
    AttemptSandboxPersistenceRecord,
    'processId' | 'status' | 'exitCode' | 'resultCollectedAt' | 'cleanupStatus' | 'cleanupError' | 'updatedAt'
  >>): void;
}

export interface WorkspacePersistenceRecord {
  id: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  kind: 'git' | 'directory';
  rootUri: string;
  baseline: Record<string, unknown>;
  managedRepositoryUri: string | null;
  managedBranch: string | null;
  headCommit: string | null;
  currentCheckpointId: string | null;
  status: 'active' | 'done' | 'archived' | 'cancelled';
  cleanupAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCleanupResult {
  workspaceId: string;
  rootUri: string;
  unreferencedObjectUris: string[];
  unreferencedManagedRepositoryUris: string[];
}

export interface WorkspaceRepositoryPort {
  upsert(record: WorkspacePersistenceRecord): WorkspacePersistenceRecord;
  find(id: string): WorkspacePersistenceRecord | null;
  findByIdentity(taskId: string, generationId: string, subtaskId: string): WorkspacePersistenceRecord | null;
  scheduleTaskCleanup(taskId: string, status: 'archived' | 'cancelled', cleanupAfter: string, updatedAt: string): number;
  listCleanupDue(now: string): WorkspacePersistenceRecord[];
  deleteWorkspace(workspaceId: string): WorkspaceCleanupResult | null;
  recordCheckpoint(input: {
    id: string;
    workspaceId: string;
    attemptId: string | null;
    reason: string;
    manifestUri: string;
    manifestHash: string;
    manifestSize: number;
    createdAt: string;
    objects?: Array<{ hash: string; uri: string; size: number; mediaType?: string | null }>;
  }): void;
}
