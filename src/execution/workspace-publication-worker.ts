import type Database from 'better-sqlite3';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import {
  WorkspacePublicationRepo,
  type WorkspacePublicationCompletion,
  type WorkspacePublicationRecord,
} from '../storage/workspace-publication-repo.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import type { WorkspaceStore } from './workspace-store.js';
import { ManagedGitWorkspaceService } from './managed-git-workspace.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';

export interface IntegratedWorkspacePublication {
  type: 'integrated';
  publicationId: string;
  taskId: string;
  subtaskId: string;
  sourceAttemptId: string;
  agentClassName: string;
  integrationCommit: string;
  output: string;
  warnings: string[];
}

export interface StaleWorkspacePublication {
  type: 'stale';
  publicationId: string;
  taskId: string;
  subtaskId: string;
  reason: string;
}

export interface CancelledWorkspacePublication {
  type: 'cancelled';
  publicationId: string;
  taskId: string;
  subtaskId: string;
  observedIntegrationCommit: string | null;
}

export type WorkspacePublicationOutcome =
  | IntegratedWorkspacePublication
  | StaleWorkspacePublication
  | CancelledWorkspacePublication;

export interface WorkspacePublicationWorkerDeps {
  db: Database.Database;
  sourceRoot: string;
  workspaceStore: WorkspaceStore;
  workspaceRepository: WorkspaceRepositoryPort;
  subtaskRepo: SubtaskRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  taskRuntimeService: TaskRuntimeService;
}

/** Serializes user-approved candidate promotion into the Project main branch. */
export class WorkspacePublicationWorker {
  private readonly publications: WorkspacePublicationRepo;
  private readonly handoffs: SubtaskHandoffRepo;
  private readonly git: ManagedGitWorkspaceService;
  private readonly activeDrains = new Map<string, Promise<WorkspacePublicationOutcome[]>>();

  constructor(private readonly deps: WorkspacePublicationWorkerDeps) {
    this.publications = new WorkspacePublicationRepo(deps.db);
    this.handoffs = new SubtaskHandoffRepo(deps.db);
    this.git = new ManagedGitWorkspaceService(deps.workspaceStore);
  }

  async drain(taskId: string, generationId: string): Promise<WorkspacePublicationOutcome[]> {
    const key = `${taskId}\u0000${generationId}`;
    const active = this.activeDrains.get(key);
    if (active) return active;
    const drain = this.drainSerial(taskId, generationId)
      .finally(() => this.activeDrains.delete(key));
    this.activeDrains.set(key, drain);
    return drain;
  }

  private async drainSerial(taskId: string, generationId: string): Promise<WorkspacePublicationOutcome[]> {
    this.publications.recoverApplying(taskId, generationId, new Date().toISOString());
    const outcomes: WorkspacePublicationOutcome[] = [];
    while (true) {
      const publication = this.publications.findNextBlocking(taskId, generationId);
      if (!publication || publication.status !== 'pending') break;
      const outcome = await this.publish(publication);
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async publish(publication: WorkspacePublicationRecord): Promise<WorkspacePublicationOutcome | null> {
    const task = this.deps.taskRuntimeService.findTask(publication.taskId);
    const subtask = this.deps.subtaskRepo.findById(publication.subtaskId);
    if (!task || task.status === 'cancelled' || !subtask || subtask.status === 'cancelled') {
      this.publications.requestCancellation({
        taskId: publication.taskId,
        generationId: publication.generationId,
        subtaskIds: [publication.subtaskId],
        decisionId: `publication_fence_${publication.id}`,
        now: new Date().toISOString(),
      });
      return {
        type: 'cancelled',
        publicationId: publication.id,
        taskId: publication.taskId,
        subtaskId: publication.subtaskId,
        observedIntegrationCommit: null,
      };
    }
    if (!this.deps.attemptReceiptRepo.findByAttemptId(publication.sourceAttemptId)) {
      throw new Error(`missing immutable source receipt ${publication.sourceAttemptId}`);
    }
    if (!this.publications.markApplying(publication.id, new Date().toISOString())) return null;

    const workspace = await this.git.ensure({
      taskId: publication.taskId,
      generationId: publication.generationId,
      subtaskId: publication.subtaskId,
    }, this.deps.sourceRoot);

    let promoted: { integrationCommit: string; changedPaths: string[] };
    try {
      promoted = await this.git.promoteCandidate({
        workspace,
        candidateCommit: publication.candidateCommit,
        approvedMainCommit: publication.mainBaseCommit,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes('changed after publication approval')) {
        const now = new Date().toISOString();
        this.publications.markParked(publication.id, reason, now);
        this.deps.subtaskRepo.updateStatus(publication.subtaskId, 'ready', { error: reason });
        return {
          type: 'stale',
          publicationId: publication.id,
          taskId: publication.taskId,
          subtaskId: publication.subtaskId,
          reason,
        };
      }
      this.publications.markPending(publication.id, reason, new Date().toISOString());
      throw error;
    }

    const now = new Date().toISOString();
    const completion = rebaseCompletionArtifacts(
      publication.originalCompletion,
      workspace.filesPath,
      workspace.projectRoot,
    );
    this.deps.db.transaction(() => {
      for (const handoff of completion.handoffs) {
        this.handoffs.insert({
          taskId: publication.taskId,
          fromSubtaskId: publication.subtaskId,
          toSubtaskId: handoff.toSubtaskId,
          attemptId: publication.sourceAttemptId,
          items: handoff.items,
          completionSchemaVersion: completion.completionSchemaVersion,
          createdAt: now,
        });
      }
      this.deps.subtaskRepo.updateStatus(publication.subtaskId, 'done', {
        result: completion.body,
        artifacts: completion.artifacts,
        verification: {
          warnings: completion.warnings,
          completionSchemaVersion: completion.completionSchemaVersion,
        },
        error: null,
      });
      if (!this.publications.markIntegrated(publication.id, promoted.integrationCommit, now)) {
        throw new Error(`publication did not become integrated: ${publication.id}`);
      }
      const record = this.deps.workspaceRepository.findByIdentity(
        publication.taskId,
        publication.generationId,
        publication.subtaskId,
      );
      if (record) {
        this.deps.workspaceRepository.upsert({
          ...record,
          headCommit: promoted.integrationCommit,
          status: 'done',
          updatedAt: now,
        });
      }
    })();

    await this.git.removePublishedWorkspace(workspace);
    return {
      type: 'integrated',
      publicationId: publication.id,
      taskId: publication.taskId,
      subtaskId: publication.subtaskId,
      sourceAttemptId: publication.sourceAttemptId,
      agentClassName: publication.agentClassName,
      integrationCommit: promoted.integrationCommit,
      output: completion.body,
      warnings: completion.warnings,
    };
  }
}

function rebaseCompletionArtifacts(
  completion: WorkspacePublicationCompletion,
  worktreeRoot: string,
  projectRoot: string,
): WorkspacePublicationCompletion {
  const rebase = (artifact: string) => {
    const absolute = isAbsolute(artifact) ? resolve(artifact) : resolve(worktreeRoot, artifact);
    const pathFromWorktree = relative(worktreeRoot, absolute);
    if (
      pathFromWorktree === '..'
      || pathFromWorktree.startsWith(`..${sep}`)
      || isAbsolute(pathFromWorktree)
    ) {
      return artifact;
    }
    return resolve(projectRoot, pathFromWorktree);
  };
  return {
    ...completion,
    artifacts: completion.artifacts.map(rebase),
    handoffs: completion.handoffs.map(handoff => ({
      ...handoff,
      items: handoff.items.map(item => item.type === 'artifact'
        ? { ...item, paths: item.paths.map(rebase) }
        : item),
    })),
  };
}
