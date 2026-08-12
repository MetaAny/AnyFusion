import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import type { ExecutorProgressEvent } from '../executor/adapter.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import {
  ExecutorAttemptReceiptRepo,
  type ExecutorAttemptReceipt,
  type ExecutorAttemptReceiptInsert,
} from '../storage/executor-attempt-receipt-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { ExecutionMode, Subtask } from '../core/types.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import {
  validateCompletionProtocol,
  type CompletionContractViolation,
  type CompletionHandoffV4,
} from './completion-protocol.js';
import { SubtaskExecutionContextBuilder } from './subtask-execution-context.js';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';
import { generateInteractionId } from '../utils/id.js';
import { ExecutionEvidenceToolServer } from './execution-evidence-tool-server.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import { ExecutorAttemptRuntimeRepo, type ExecutorAttemptRuntimeRecord } from '../storage/executor-attempt-runtime-repo.js';
import type {
  KernelAttemptKind,
  KernelAttemptPayload,
  KernelRecoveryMode,
} from '../kernel/control-kernel.js';
import {
  captureWorkspaceState,
  deriveWorkspaceDelta,
  deriveGitCommitDelta,
  type WorkspaceDelta,
  type WorkspaceState,
} from './workspace-change-tracker.js';
import type { WorkspaceStore, WorkspaceHandle, StoredWorkspaceCheckpoint } from './workspace-store.js';
import type { AttemptSandboxPort } from './attempt-sandbox.js';
import {
  buildPermissionRules,
  type PermissionRepositoryPort,
  type ResourceClaim,
} from '../resource/index.js';
import type { ResourceLeaseService } from './resource-lease-service.js';
import { RegisteredCapabilityResourceResolver } from './capability-resource-resolver.js';
import { PermissionWorkflowService } from './permission-workflow-service.js';
import { CapabilityRequestToolServer } from './capability-request-tool-server.js';
import type { KernelWorkflowStore } from '../kernel/kernel-workflow.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import { ManagedGitWorkspaceService, type ManagedGitWorkspace } from './managed-git-workspace.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import {
  WorkspacePublicationRepo,
  type WorkspacePublicationCompletion,
} from '../storage/workspace-publication-repo.js';
import { AttemptTerminalService } from './attempt-terminal-service.js';

export type ProgressCallback = (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;

export type SubtaskAttemptOutcome =
  | { outcome: 'completed'; attemptId: string; output: string; artifacts: string[]; warnings: string[]; executorName: string; durationMs: number }
  | { outcome: 'capacity_unavailable'; attemptId: string; agentClassName: string }
  | { outcome: 'contract_failed'; attemptId: string; workUnitId: string; agentClassName: string; responseBytes: number; receiptCount: number; completionContract: unknown; violations: CompletionContractViolation[] }
  | { outcome: 'executor_failed'; attemptId: string; error: string; failure: KernelFailure }
  | { outcome: 'partition_conflict'; attemptId: string; claims: ResourceClaim[]; conflictingLeaseIds: string[] }
  | { outcome: 'cancelled_or_stale'; attemptId: string; reason: string };

export interface SubtaskAttemptRunnerDeps {
  db: Database.Database;
  sessionId: string;
  taskRuntimeService: TaskRuntimeService;
  subtaskRepo: SubtaskRepo;
  workUnitClaimService: Pick<WorkUnitClaimService, 'claim' | 'isClaimCurrent'>;
  executionRuntime: ExecutionRuntime;
  agentClassService: AgentClassService;
  workspaceStore: WorkspaceStore;
  attemptSandbox: AttemptSandboxPort;
  resourceLeaseService: ResourceLeaseService;
  permissionRepository: PermissionRepositoryPort;
  kernelWorkflowStore: KernelWorkflowStore;
  workspaceRepository: WorkspaceRepositoryPort;
  sourceRoot: string;
  autoApproveRepositoryPromotions?: boolean;
}

/** Owns one Subtask attempt from claim through immutable terminal persistence. */
export class SubtaskAttemptRunner {
  private readonly contextBuilder: SubtaskExecutionContextBuilder;
  private readonly receiptRepo: ExecutorAttemptReceiptRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;
  private readonly attemptRuntimeRepo: ExecutorAttemptRuntimeRepo;
  private readonly managedGitWorkspace: ManagedGitWorkspaceService;
  private readonly dispatchItemRepo: KernelDispatchItemRepo;
  private readonly publicationRepo: WorkspacePublicationRepo;
  private readonly terminalService: AttemptTerminalService;

  constructor(private readonly deps: SubtaskAttemptRunnerDeps) {
    this.contextBuilder = new SubtaskExecutionContextBuilder(deps.db);
    this.receiptRepo = new ExecutorAttemptReceiptRepo(deps.db);
    this.handoffRepo = new SubtaskHandoffRepo(deps.db);
    this.attemptRuntimeRepo = new ExecutorAttemptRuntimeRepo(deps.db);
    this.managedGitWorkspace = new ManagedGitWorkspaceService(deps.workspaceStore);
    this.dispatchItemRepo = new KernelDispatchItemRepo(deps.db);
    this.publicationRepo = new WorkspacePublicationRepo(deps.db);
    this.terminalService = new AttemptTerminalService(deps.db);
  }

  supportsContinuation(agentClassName: string): boolean {
    return this.deps.executionRuntime.supportsContinuation(agentClassName);
  }

  landHeartbeatLost(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
  }): void {
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!subtask || subtask.status === 'done' || this.receiptRepo.findByAttemptId(input.attemptId)) return;
    const dispatch = this.dispatchItemRepo.find(input.attemptId);
    if (!dispatch) {
      throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
    }
    const now = new Date().toISOString();
    const failure = {
      kind: 'heartbeat_lost' as const,
      scope: 'agent_class' as const,
      code: 'heartbeat_lost',
      summary: 'WorkUnit lease expired before a terminal observation',
    };
    this.terminalService.land({
      receipt: buildReceipt({
        ...input,
        startedAt: now,
        terminalState: 'heartbeat_lost',
        rawResponse: '',
        errorCode: 'heartbeat_lost',
        errorDetail: 'WorkUnit lease expired before a terminal observation',
        failure,
      }, now),
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: 'WorkUnit heartbeat lost',
      event: {
        schemaVersion: 5,
        type: 'execution_outcome',
        id: `event_${dispatch.attemptId}_execution_outcome`,
        correlationId: dispatch.decisionId,
        causationId: dispatch.decisionId,
        occurredAt: now,
        sessionId: this.deps.sessionId,
        taskId: dispatch.taskId,
        subtaskId: dispatch.subtaskId,
        attemptId: dispatch.attemptId,
        terminalKind: 'failed',
        agentClassName: dispatch.agentClassName,
        attemptKind: dispatch.attemptKind,
        sourceAttemptId: dispatch.sourceAttemptId,
        failure,
      },
      now,
    });
  }

  async run(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    agentClassName: string;
    executionMode: ExecutionMode;
    attemptKind?: KernelAttemptKind;
    attemptPayload?: KernelAttemptPayload;
    sourceAttemptId?: string | null;
    recoveryMode?: KernelRecoveryMode;
    defaultResourceGrant: ResourceClaim[];
    onProgress?: ProgressCallback;
  }): Promise<SubtaskAttemptOutcome> {
    const attemptId = input.attemptId;
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const attemptKind = input.attemptKind ?? 'primary';
    const expectedStatus = attemptKind === 'primary' ? 'ready' : 'awaiting_decision';
    if (
      !task
      || task.status !== 'running'
      || !subtask
      || subtask.taskId !== input.taskId
      || subtask.status !== expectedStatus
    ) {
      return {
        outcome: 'cancelled_or_stale',
        attemptId,
        reason: `Task or ${expectedStatus} Subtask no longer matches the authorized ${attemptKind} attempt`,
      };
    }
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: input.taskId,
      subtask: { id: subtask.id, preferredAgentClassList: [input.agentClassName] },
      attemptId,
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId, agentClassName: input.agentClassName };

    const leaseToken = `attempt_lease_${randomUUID()}`;
    const resourceClaim = this.deps.resourceLeaseService.claim({
      taskId: input.taskId,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId: claim.workUnit.id,
      claims: input.defaultResourceGrant,
      leaseToken,
    });
    if (resourceClaim.type === 'conflict') {
      claim.release();
      return {
        outcome: 'partition_conflict',
        attemptId,
        claims: input.defaultResourceGrant,
        conflictingLeaseIds: resourceClaim.conflictingLeases.map(lease => lease.id),
      };
    }

    const startedAt = new Date().toISOString();
    let rawResponse = '';
    let evidenceCapability: { revoke(): void } | null = null;
    let evidenceToolServer: ExecutionEvidenceToolServer | null = null;
    let workspaceBaseline: WorkspaceState | null = null;
    let workspaceDelta: WorkspaceDelta | null = null;
    let workspace: WorkspaceHandle | null = null;
    let gitWorkspace: ManagedGitWorkspace | null = null;
    let mergeRepair: {
      publicationId: string;
      conflictChainId: string;
      conflictingPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    } | null = null;
    let capabilityToolServer: CapabilityRequestToolServer | null = null;
    let finalCheckpointReason: 'success' | 'failure' | 'cancelled' = 'failure';
    const heartbeat = setInterval(() => {
      claim.heartbeat();
      this.deps.resourceLeaseService.heartbeat(attemptId, leaseToken);
    }, 20_000);
    try {
      claim.startAttempt();
      if (attemptKind === 'merge_repair') {
        if (input.attemptPayload?.protocol !== 'metaclaw:merge-repair:v1') {
          throw new Error('merge repair attempt is missing metaclaw:merge-repair:v1 payload');
        }
        if (!this.publicationRepo.recordRepairAttempt(
          input.attemptPayload.publicationId,
          new Date().toISOString(),
        )) {
          throw new Error(`merge repair budget or publication state is stale: ${input.attemptPayload.publicationId}`);
        }
      }
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
      claim.markRunning();
      const agentClass = this.deps.agentClassService.listAgentClasses().find(item => item.name === input.agentClassName);
      if (!agentClass || claim.workUnit.agentClassName !== input.agentClassName) {
        throw new Error(`attempt AgentClass mismatch: ${input.agentClassName}`);
      }
      const activeSubtasks = this.deps.subtaskRepo.listActiveByTask(input.taskId);
      const allSubtasks = activeSubtasks.length > 0 ? activeSubtasks : this.deps.subtaskRepo.listByTask(input.taskId);
      const workspaceIdentity = {
        taskId: task.id,
        projectId: task.projectId,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
      };
      gitWorkspace = await this.managedGitWorkspace.ensure(workspaceIdentity, this.deps.sourceRoot);
      workspace = gitWorkspace;
      if (subtask.dependencies.length > 0) {
        const dependencyCommits = subtask.dependencies.map(dependency => {
          const state = this.deps.workspaceRepository.findByIdentity(
            task.id, subtask.generationId, dependency.fromSubtaskId,
          );
          if (!state?.headCommit) throw new Error(`missing direct dependency workspace_state: ${dependency.fromSubtaskId}`);
          return state.headCommit;
        });
        await this.managedGitWorkspace.applyDependencyStates(gitWorkspace, dependencyCommits);
      }
      if (attemptKind === 'merge_repair') {
        const payload = input.attemptPayload;
        if (payload?.protocol !== 'metaclaw:merge-repair:v1') {
          throw new Error('merge repair payload changed after authorization');
        }
        const publication = this.publicationRepo.find(payload.publicationId);
        if (!publication || publication.status !== 'conflicted') {
          throw new Error(`merge repair publication is no longer conflicted: ${payload.publicationId}`);
        }
        const integrationWorkspace = await this.managedGitWorkspace.ensure({
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: '__integration__',
        }, this.deps.sourceRoot);
        const description = await this.managedGitWorkspace.describeCandidate(
          integrationWorkspace,
          publication.candidateCommit,
        );
        const preparation = await this.managedGitWorkspace.prepareMergeRepair({
          candidateWorkspace: gitWorkspace,
          integrationWorkspace,
          candidateCommit: publication.candidateCommit,
          expectedConflictPaths: payload.conflictingPaths,
          filePolicy: description.filePolicy,
        });
        mergeRepair = {
          publicationId: payload.publicationId,
          conflictChainId: payload.conflictChainId,
          conflictingPaths: preparation.conflictPaths,
          filePolicy: preparation.filePolicy,
        };
      }
      const workspaceNow = new Date().toISOString();
      this.deps.workspaceRepository.upsert({
        id: workspace.id,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        kind: workspace.kind,
        rootUri: pathToFileURL(workspace.rootPath).href,
        baseline: gitWorkspace ? {
          sourceCommit: gitWorkspace.sourceCommit,
          baselineCommit: gitWorkspace.baselineCommit,
          sourceDiffHash: gitWorkspace.sourceDiffHash,
        } : {},
        managedRepositoryUri: gitWorkspace ? pathToFileURL(gitWorkspace.repositoryPath).href : null,
        managedBranch: gitWorkspace?.branch ?? null,
        headCommit: gitWorkspace?.baselineCommit ?? null,
        currentCheckpointId: null,
        status: 'active',
        cleanupAfter: null,
        createdAt: workspaceNow,
        updatedAt: workspaceNow,
      });
      await mkdir(join(workspace.filesPath, '.metaclaw', 'results'), { recursive: true });
      if (this.deps.attemptSandbox.pathMode === 'native' && process.getuid && process.getgid) {
        await this.deps.workspaceStore.prepareForSandbox(workspace, process.getuid(), process.getgid());
      } else {
        await this.deps.workspaceStore.prepareForSandbox(workspace);
      }
      const inputsPath = join(workspace.rootPath, 'inputs');
      const handoffsPath = join(workspace.rootPath, 'handoffs');
      await Promise.all([mkdir(inputsPath, { recursive: true }), mkdir(handoffsPath, { recursive: true })]);
      const startCheckpoint = await this.deps.workspaceStore.createCheckpoint(workspace, {
        reason: 'attempt_start', attemptId,
      });
      this.deps.workspaceRepository.recordCheckpoint({
        id: startCheckpoint.id,
        workspaceId: workspace.id,
        attemptId,
        reason: 'attempt_start',
        manifestUri: startCheckpoint.manifestUri,
        manifestHash: startCheckpoint.manifestHash,
        manifestSize: startCheckpoint.manifestSize,
        createdAt: startCheckpoint.manifest.createdAt,
        objects: checkpointObjects(startCheckpoint),
      });
      const targetPath = workspace.filesPath;
      workspaceBaseline = captureWorkspaceState(workspace.filesPath);
      const sourceRuntime = input.sourceAttemptId
        ? this.attemptRuntimeRepo.find(input.sourceAttemptId)
        : null;
      const sourceReceipt = input.sourceAttemptId
        ? this.receiptRepo.findByAttemptId(input.sourceAttemptId)
        : null;
      const recoveryMode: KernelRecoveryMode = input.recoveryMode === 'native_session' && !sourceRuntime?.continuationToken
        ? 'recovery_packet'
        : input.recoveryMode ?? 'fresh';
      this.attemptRuntimeRepo.start({
        attemptId,
        sourceAttemptId: input.sourceAttemptId ?? null,
        workspaceRoot: workspace.filesPath,
        workspaceBaseline: { ...workspaceBaseline },
        recoverySafety: this.deps.agentClassService.deriveRecoverySafety(subtask.requiredCapabilities),
        now: startedAt,
      });
      const evidenceToolsAvailable = this.deps.agentClassService.supportsExecutionEvidence(input.agentClassName);
      const attemptControlHost = this.deps.attemptSandbox.pathMode === 'native'
        ? '127.0.0.1'
        : process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control';
      const built = this.contextBuilder.build({
        executionId: input.executionId,
        task,
        subtask,
        allSubtasks,
        attemptId,
        workUnitId: claim.workUnit.id,
        sessionId: this.deps.sessionId,
        workspaceContext: {
          allowFilesystem: true,
          workingDirectory: workspace.filesPath,
          targetPaths: [targetPath],
        },
        evidenceToolsAvailable,
        currentSubtaskOverride: mergeRepair ? {
          title: `Repair merge conflicts for ${subtask.title}`,
          goal: buildMergeRepairGoal(
            subtask.goal,
            mergeRepair.conflictingPaths,
            gitWorkspace.filesPath,
          ),
        } : undefined,
        completionContractOverride: mergeRepair ? {
          marker: '---METACLAW-MERGE-REPAIR---',
          protocol: 'metaclaw:merge-repair:v1',
          allowedPaths: mergeRepair.conflictingPaths,
        } : undefined,
        recovery: {
          mode: recoveryMode,
          sourceAttemptId: input.sourceAttemptId ?? null,
          packet: recoveryMode === 'fresh'
            ? null
            : boundedRecoveryPacket(sourceReceipt, sourceRuntime, input.attemptPayload),
        },
      });
      evidenceCapability = built.evidenceCapability;
      if (evidenceToolsAvailable) {
        evidenceToolServer = new ExecutionEvidenceToolServer(built.evidenceCapability, {
          advertisedHost: attemptControlHost,
        });
        built.context.evidenceTools.binding = await evidenceToolServer.start();
      }
      const capabilityContext = {
        sessionId: this.deps.sessionId,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        attemptId,
        agentClassName: agentClass.name,
        permissionProfileId: agentClass.permissionProfileId ?? 'restricted-custom' as const,
        runtimeHandle: '',
        workspaceId: workspace.id,
        checkpointId: null as string | null,
      };
      const resourceRegistrations = new Map(task.resources.map((resource, index) => [
        resource,
        { kind: 'path' as const, mountId: `inputs-${task.id}`, normalizedRelativePath: `resource-${index}` },
      ]));
      const permissionWorkflow = new PermissionWorkflowService({
        context: capabilityContext,
        repository: this.deps.permissionRepository,
        resolver: new RegisteredCapabilityResourceResolver(resourceRegistrations),
        sandbox: this.deps.attemptSandbox,
        workflowStore: this.deps.kernelWorkflowStore,
        rules: buildPermissionRules({
          permissionProfileId: capabilityContext.permissionProfileId,
          additionalReadPartitions: resourceRegistrations.values(),
        }),
        hooks: {
          checkpoint: async reason => {
            if (!workspace) return null;
            const checkpoint = await this.deps.workspaceStore.createCheckpoint(workspace, { reason, attemptId });
            this.deps.workspaceRepository.recordCheckpoint({
              id: checkpoint.id,
              workspaceId: workspace.id,
              attemptId,
              reason,
              manifestUri: checkpoint.manifestUri,
              manifestHash: checkpoint.manifestHash,
              manifestSize: checkpoint.manifestSize,
              createdAt: checkpoint.manifest.createdAt,
              objects: checkpointObjects(checkpoint),
            });
            return checkpoint.id;
          },
          onEscalation: async request => {
            claim.markWaiting(`permission request ${request.id} requires Planner or user review`);
            if (capabilityContext.runtimeHandle) await this.deps.attemptSandbox.stop(capabilityContext.runtimeHandle);
          },
          onRecoveryAuthorized: async () => undefined,
        },
      });
      capabilityToolServer = new CapabilityRequestToolServer(permissionWorkflow, {
        advertisedHost: attemptControlHost,
      });
      const capabilityBinding = await capabilityToolServer.start();
      const execution = await this.deps.executionRuntime.run({
        taskId: input.taskId,
        executionId: input.executionId,
        spec: { subtask, workUnit: claim.workUnit, agentClass, acceptance: subtask.acceptance },
        executorInput: {
          context: built.context,
          sandbox: {
            attemptId,
            taskId: task.id,
            generationId: subtask.generationId,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            leaseToken,
            idempotencyKey: `dispatch:${attemptId}`,
            workspacePath: workspace.filesPath,
            workspaceId: workspace.id,
            sourcePath: this.deps.sourceRoot,
            inputsPath,
            handoffsPath,
            gitMetadataPath: gitWorkspace?.gitMetadataPath ?? null,
            capabilityBinding,
            onRuntimeStarted: runtimeHandle => {
              capabilityContext.runtimeHandle = runtimeHandle;
              this.dispatchItemRepo.markRuntime(attemptId, runtimeHandle, new Date().toISOString());
            },
          },
          recovery: {
            mode: recoveryMode,
            continuationToken: sourceRuntime?.continuationToken ?? null,
            onContinuationToken: token => this.attemptRuntimeRepo.recordContinuationToken(
              attemptId, token, new Date().toISOString(),
            ),
          },
        },
        onProgress: (event, executor) => {
          this.attemptRuntimeRepo.recordProgress(attemptId, {
            kind: event.kind,
            text: event.text.slice(0, 2_000),
          }, new Date().toISOString());
          input.onProgress?.(event, executor);
        },
      });
      rawResponse = execution.output;
      if (execution.status !== 'success') {
        const error = execution.error ?? 'Executor failed without an error message';
        const pendingPermission = this.deps.permissionRepository.findPendingForTask(task.id);
        const executionFailure = pendingPermission?.request.attemptId === attemptId
          ? {
              kind: 'permission' as const,
              scope: 'attempt' as const,
              code: 'permission_escalated',
              summary: `permission request ${pendingPermission.request.id} requires Planner or user review`,
            }
          : execution.failure;
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: agentClass.name, startedAt,
          terminalState: execution.status === 'cancelled' ? 'cancelled_or_stale' : 'executor_failed', rawResponse,
          errorCode: execution.status === 'cancelled' ? 'attempt_cancelled' : 'executor_failed', errorDetail: error,
          failure: executionFailure,
        });
        if (mergeRepair) {
          this.publicationRepo.recordRepairFailure(
            mergeRepair.publicationId,
            error,
            new Date().toISOString(),
          );
        }
        claim.markFailed(error);
        return execution.status === 'cancelled'
          ? { outcome: 'cancelled_or_stale', attemptId, reason: error }
          : {
              outcome: 'executor_failed', attemptId, error,
              failure: executionFailure ?? { kind: 'unknown', scope: 'attempt', code: 'executor_failed', summary: error },
            };
      }

      const candidate = mergeRepair
        ? null
        : await this.managedGitWorkspace.validateExecutorCandidate(gitWorkspace);
      workspaceDelta = candidate
        ? deriveGitCommitDelta(gitWorkspace.filesPath, candidate.mainCommit, candidate.candidateCommit)
        : deriveWorkspaceDelta(workspaceBaseline, captureWorkspaceState(workspace.filesPath));
      this.attemptRuntimeRepo.recordWorkspaceDelta(
        attemptId,
        workspaceDelta,
        new Date().toISOString(),
      );

      if (mergeRepair) {
        const report = parseMergeRepairReport(rawResponse);
        const repairedCommit = await this.managedGitWorkspace.commitMergeRepair({
          workspace: gitWorkspace,
          allowedPaths: mergeRepair.conflictingPaths,
          filePolicy: mergeRepair.filePolicy,
          reportedResolvedPaths: report.resolvedPaths,
        });
        const completedAt = new Date().toISOString();
        const dispatchItem = this.dispatchItemRepo.find(attemptId);
        if (!dispatchItem) {
          throw new Error(`authorized dispatch item not found: ${attemptId}`);
        }
        const landing = this.terminalService.land({
          receipt: buildReceipt({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName: agentClass.name,
            startedAt,
            terminalState: 'completed',
            rawResponse,
          }, completedAt),
          expectedSubtaskStatus: 'running',
          nextSubtaskStatus: 'awaiting_integration',
          subtaskError: null,
          repairPublication: {
            publicationId: mergeRepair.publicationId,
            candidateCommit: repairedCommit.commit,
          },
          event: {
            schemaVersion: 5,
            type: 'execution_outcome',
            id: `event_${dispatchItem.attemptId}_execution_outcome`,
            correlationId: dispatchItem.decisionId,
            causationId: dispatchItem.decisionId,
            occurredAt: completedAt,
            sessionId: this.deps.sessionId,
            taskId: dispatchItem.taskId,
            subtaskId: dispatchItem.subtaskId,
            attemptId: dispatchItem.attemptId,
            terminalKind: 'completed',
            agentClassName: dispatchItem.agentClassName,
            attemptKind: dispatchItem.attemptKind,
            sourceAttemptId: dispatchItem.sourceAttemptId,
            failure: null,
          },
          now: completedAt,
        });
        if (landing.cancellationWon) {
          finalCheckpointReason = 'cancelled';
          return {
            outcome: 'cancelled_or_stale',
            attemptId,
            reason: 'Cancellation fence won before merge-repair terminal landing',
          };
        }
        const workspaceRecord = this.deps.workspaceRepository.findByIdentity(
          task.id,
          subtask.generationId,
          subtask.id,
        );
        if (workspaceRecord) {
          this.deps.workspaceRepository.upsert({
            ...workspaceRecord,
            headCommit: repairedCommit.workspaceCommit,
            status: 'active',
            updatedAt: completedAt,
          });
        }
        finalCheckpointReason = 'success';
        return {
          outcome: 'completed',
          attemptId,
          output: report.verificationSummary,
          artifacts: [],
          warnings: [],
          executorName: execution.executorName,
          durationMs: execution.durationMs,
        };
      }

      const outgoingHandoffs = allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const completion = validateCompletionProtocol({
        rawResponse,
        subtask,
        outgoingHandoffs,
        workspaceRoot: built.context.workspaceContext.workingDirectory,
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        const contractOutcome = this.landContractFailure({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
          startedAt,
          rawResponse,
          completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
          violations: completion.violations,
          errorCode: completion.violations[0]?.code ?? 'completion_malformed',
          errorDetail: detail,
          completionContract: built.context.completionContract,
        });
        claim.markFailed(detail);
        return contractOutcome;
      }
      if (completion.envelope.status === 'failed') {
        const failure = completion.envelope.failure;
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: agentClass.name, startedAt,
          terminalState: 'executor_failed', rawResponse, completionSchemaVersion: 4,
          errorCode: failure.code, errorDetail: failure.summary,
          failure: { ...failure, scope: 'task' },
        });
        claim.markFailed(failure.summary);
        return {
          outcome: 'executor_failed', attemptId, error: failure.summary,
          failure: { ...failure, scope: 'task' },
        };
      }
      const completedEnvelope = completion.envelope;

      if (!this.isStillCurrent(task.id, subtask.id, attemptId, claim.workUnit.id)) {
        const detail = 'Task, Subtask, or WorkUnit claim changed before commit';
        this.persistNonSuccess({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
          startedAt,
          terminalState: 'cancelled_or_stale',
          rawResponse,
          errorCode: 'attempt_stale',
          errorDetail: detail,
        });
        if (this.isAttemptClaimCurrent(attemptId, claim.workUnit.id)) {
          claim.markFailed(detail);
        }
        return { outcome: 'cancelled_or_stale', attemptId, reason: 'attempt became stale before commit' };
      }

      const completedAt = new Date().toISOString();
      if (!candidate) throw new Error('Executor candidate validation was not completed');
      const permissionRequestId = await this.requestRepositoryPromotion({
        taskId: task.id,
        projectId: task.projectId,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        attemptId,
        agentClassName: agentClass.name,
        permissionProfileId: agentClass.permissionProfileId ?? 'restricted-custom',
        workspaceId: workspace.id,
        mainCommit: candidate.mainCommit,
        candidateCommit: candidate.candidateCommit,
        changedPaths: candidate.changedPaths,
      });
      const dispatchItem = this.dispatchItemRepo.find(attemptId);
      const publicationCompletion: WorkspacePublicationCompletion = {
        body: completion.body,
        artifacts: completion.normalizedArtifacts,
        warnings: completion.warnings,
        handoffs: completedEnvelope.handoffs,
        completionSchemaVersion: 4,
      };
      if (!dispatchItem) {
        throw new Error(`authorized dispatch item not found: ${attemptId}`);
      }
      let landing;
      try {
        landing = this.terminalService.land({
          receipt: buildReceipt({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
          startedAt,
          terminalState: 'completed',
          rawResponse,
          completionSchemaVersion: 4,
          warnings: completion.warnings,
        }, completedAt),
        expectedSubtaskStatus: 'running',
        nextSubtaskStatus: 'awaiting_integration',
        subtaskError: null,
        publication: {
          id: `publication_${attemptId}`,
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          sourceAttemptId: attemptId,
          agentClassName: agentClass.name,
          mainBaseCommit: candidate.mainCommit,
          candidateCommit: candidate.candidateCommit,
          permissionRequestId,
          changedPaths: candidate.changedPaths,
          completion: publicationCompletion,
          topologyLayer: deriveTopologyLayer(subtask.id, allSubtasks),
          firstDispatchOrder: dispatchItem.batchOrder,
          createdAt: completedAt,
        },
        event: {
          schemaVersion: 5,
          type: 'execution_outcome',
          id: `event_${dispatchItem.attemptId}_execution_outcome`,
          correlationId: dispatchItem.decisionId,
          causationId: dispatchItem.decisionId,
          occurredAt: completedAt,
          sessionId: this.deps.sessionId,
          taskId: dispatchItem.taskId,
          subtaskId: dispatchItem.subtaskId,
          attemptId: dispatchItem.attemptId,
          terminalKind: 'completed',
          agentClassName: dispatchItem.agentClassName,
          attemptKind: dispatchItem.attemptKind,
          sourceAttemptId: dispatchItem.sourceAttemptId,
          failure: null,
        },
          now: completedAt,
        });
      } catch (error) {
        this.withdrawRepositoryPromotion(
          permissionRequestId,
          'candidate terminal landing failed before publication became durable',
        );
        throw error;
      }
      if (landing.cancellationWon) {
        this.withdrawRepositoryPromotion(
          permissionRequestId,
          'candidate publication was cancelled before terminal landing',
        );
        finalCheckpointReason = 'cancelled';
        return {
          outcome: 'cancelled_or_stale',
          attemptId,
          reason: 'Cancellation fence won before attempt terminal landing',
        };
      }
      if (this.deps.autoApproveRepositoryPromotions) {
        this.publicationRepo.markApproved(`publication_${attemptId}`, completedAt);
      }
      if (workspace) {
        this.deps.workspaceRepository.upsert({
          id: workspace.id,
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          kind: 'git',
          rootUri: pathToFileURL(workspace.rootPath).href,
          baseline: {
            sourceCommit: gitWorkspace!.sourceCommit,
            baselineCommit: gitWorkspace!.baselineCommit,
            sourceDiffHash: gitWorkspace!.sourceDiffHash,
          },
          managedRepositoryUri: pathToFileURL(gitWorkspace!.repositoryPath).href,
          managedBranch: gitWorkspace.branch,
          headCommit: candidate.candidateCommit,
          currentCheckpointId: null,
          status: 'active',
          cleanupAfter: null,
          createdAt: completedAt,
          updatedAt: completedAt,
        });
      }
      finalCheckpointReason = 'success';
      return {
        outcome: 'completed',
        attemptId,
        output: completion.body,
        artifacts: completion.normalizedArtifacts,
        warnings: completion.warnings,
        executorName: execution.executorName,
        durationMs: execution.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mergeRepair) {
        this.publicationRepo.recordRepairFailure(
          mergeRepair.publicationId,
          message,
          new Date().toISOString(),
        );
      }
      if (!this.receiptRepo.findByAttemptId(attemptId)) {
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse, errorCode: 'attempt_exception', errorDetail: message,
        });
      }
      claim.markFailed(message);
      return {
        outcome: 'executor_failed', attemptId, error: message,
        failure: { kind: 'unknown', scope: 'attempt', code: 'attempt_exception', summary: message },
      };
    } finally {
      clearInterval(heartbeat);
      if (workspace) {
        try {
          const checkpoint = await this.deps.workspaceStore.createCheckpoint(workspace, {
            reason: finalCheckpointReason,
            attemptId,
          });
          this.deps.workspaceRepository.recordCheckpoint({
            id: checkpoint.id,
            workspaceId: workspace.id,
            attemptId,
            reason: finalCheckpointReason,
            manifestUri: checkpoint.manifestUri,
            manifestHash: checkpoint.manifestHash,
            manifestSize: checkpoint.manifestSize,
            createdAt: checkpoint.manifest.createdAt,
            objects: checkpointObjects(checkpoint),
          });
        } catch {
          // The terminal receipt remains authoritative; checkpoint recovery is best effort here.
        }
      }
      if (!workspaceDelta && workspaceBaseline && workspace) {
        try {
          this.attemptRuntimeRepo.recordWorkspaceDelta(
            attemptId,
            deriveWorkspaceDelta(workspaceBaseline, captureWorkspaceState(workspace.filesPath)),
            new Date().toISOString(),
          );
        } catch {
          // Failed attempts retain their terminal receipt even when best-effort delta capture fails.
        }
      }
      evidenceCapability?.revoke();
      await evidenceToolServer?.close();
      await capabilityToolServer?.close();
      if (this.hasSealedTerminal(attemptId)) {
        this.deps.resourceLeaseService.release(attemptId, leaseToken);
        claim.release();
      }
    }
  }

  private async requestRepositoryPromotion(input: {
    taskId: string;
    projectId: string;
    generationId: string;
    subtaskId: string;
    attemptId: string;
    agentClassName: string;
    permissionProfileId: 'workspace-engineering' | 'public-web-research' | 'restricted-custom';
    workspaceId: string;
    mainCommit: string;
    candidateCommit: string;
    changedPaths: string[];
  }): Promise<string> {
    const workflow = new PermissionWorkflowService({
      context: {
        sessionId: this.deps.sessionId,
        taskId: input.taskId,
        generationId: input.generationId,
        subtaskId: input.subtaskId,
        attemptId: input.attemptId,
        agentClassName: input.agentClassName,
        permissionProfileId: input.permissionProfileId,
        runtimeHandle: '',
        workspaceId: input.workspaceId,
        checkpointId: null,
      },
      repository: this.deps.permissionRepository,
      resolver: new RegisteredCapabilityResourceResolver(new Map([
        [this.deps.sourceRoot, { kind: 'repository' as const, repositoryId: input.projectId }],
      ])),
      sandbox: this.deps.attemptSandbox,
      workflowStore: this.deps.kernelWorkflowStore,
      rules: buildPermissionRules({
        permissionProfileId: input.permissionProfileId,
        additionalReadPartitions: [],
      }),
      hooks: {
        checkpoint: async () => null,
        onEscalation: async () => undefined,
        onRecoveryAuthorized: async () => undefined,
      },
    });
    const result = await workflow.request({
      capability: 'repository_promotion',
      resource: this.deps.sourceRoot,
      operation: `promote_commit:${input.candidateCommit}`,
      reason: [
        `Merge Subtask ${input.subtaskId} into Project main.`,
        `Approved main base: ${input.mainCommit}.`,
        `Candidate: ${input.candidateCommit}.`,
        `Changed paths (${input.changedPaths.length}): ${input.changedPaths.join(', ') || '(none)'}.`,
      ].join(' '),
      suggestedScope: 'once',
    }, { suspendAttempt: false });
    if (result.status !== 'escalated') {
      throw new Error(`repository promotion request did not enter user review: ${result.status}`);
    }
    return result.requestId;
  }

  private withdrawRepositoryPromotion(requestId: string, reason: string): void {
    const record = this.deps.permissionRepository.findRequest(requestId);
    if (!record || !['pending', 'escalated'].includes(record.status)) return;
    this.deps.permissionRepository.deny({
      decisionId: `permission_withdrawal_${requestId}`,
      request: record.request,
      reason,
      deniedAt: new Date().toISOString(),
    });
  }

  private isStillCurrent(taskId: string, subtaskId: string, attemptId: string, workUnitId: string): boolean {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const subtask = this.deps.subtaskRepo.findById(subtaskId);
    return task?.status === 'running'
      && subtask?.status === 'running'
      && this.deps.workUnitClaimService.isClaimCurrent(workUnitId, attemptId, 'running');
  }

  private isAttemptClaimCurrent(attemptId: string, workUnitId: string): boolean {
    return this.deps.workUnitClaimService.isClaimCurrent(workUnitId, attemptId);
  }

  private hasSealedTerminal(attemptId: string): boolean {
    if (!this.receiptRepo.findByAttemptId(attemptId)) return false;
    const dispatch = this.dispatchItemRepo.find(attemptId);
    return Boolean(dispatch && ['terminal', 'cancelled'].includes(dispatch.status));
  }

  private landContractFailure(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
    startedAt: string;
    rawResponse: string;
    completionSchemaVersion: number | null;
    violations: CompletionContractViolation[];
    errorCode: string;
    errorDetail: string;
    completionContract: unknown;
  }): Extract<SubtaskAttemptOutcome, { outcome: 'contract_failed' }> {
    const dispatch = this.dispatchItemRepo.find(input.attemptId);
    if (!dispatch) {
      throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
    }
    const now = new Date().toISOString();
    const receiptCount = this.receiptRepo.countByTerminal(
      input.taskId,
      input.subtaskId,
      'contract_blocked',
    ) + 1;
    const responseBytes = Buffer.byteLength(input.rawResponse, 'utf8');
    this.terminalService.land({
      receipt: buildReceipt({
        ...input,
        terminalState: 'contract_blocked',
      }, now),
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: input.errorDetail,
      event: {
        schemaVersion: 5,
        type: 'handoff_contract_failed',
        id: `event_${dispatch.attemptId}_handoff_contract_failed`,
        correlationId: dispatch.decisionId,
        causationId: dispatch.decisionId,
        occurredAt: now,
        sessionId: this.deps.sessionId,
        taskId: dispatch.taskId,
        subtaskId: dispatch.subtaskId,
        attemptId: dispatch.attemptId,
        workUnitId: input.workUnitId,
        agentClassName: input.agentClassName,
        contract: input.completionContract as never,
        violations: input.violations,
        receiptCount,
        responseBytes,
      },
      now,
    });
    return {
      outcome: 'contract_failed',
      attemptId: input.attemptId,
      workUnitId: input.workUnitId,
      agentClassName: input.agentClassName,
      responseBytes,
      receiptCount,
      completionContract: input.completionContract,
      violations: input.violations,
    };
  }

  private persistNonSuccess(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
    startedAt: string;
    terminalState: ExecutorAttemptReceipt['terminalState'];
    rawResponse: string;
    completionSchemaVersion?: number | null;
    errorCode: string;
    errorDetail: string;
    failure?: KernelFailure | null;
  }): void {
    const dispatch = this.dispatchItemRepo.find(input.attemptId);
    if (!dispatch) {
      throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
    }
    const now = new Date().toISOString();
    const failure = input.terminalState === 'cancelled_or_stale'
      ? {
          kind: 'stale' as const,
          scope: 'attempt' as const,
          code: input.errorCode,
          summary: input.errorDetail,
        }
      : input.failure ?? {
          kind: 'unknown' as const,
          scope: 'attempt' as const,
          code: input.errorCode,
          summary: input.errorDetail,
        };
    this.terminalService.land({
      receipt: buildReceipt(input, now),
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: input.errorDetail,
      event: {
        schemaVersion: 5,
        type: 'execution_outcome',
        id: `event_${dispatch.attemptId}_execution_outcome`,
        correlationId: dispatch.decisionId,
        causationId: dispatch.decisionId,
        occurredAt: now,
        sessionId: this.deps.sessionId,
        taskId: dispatch.taskId,
        subtaskId: dispatch.subtaskId,
        attemptId: dispatch.attemptId,
        terminalKind: 'failed',
        agentClassName: dispatch.agentClassName,
        attemptKind: dispatch.attemptKind,
        sourceAttemptId: dispatch.sourceAttemptId,
        failure,
      },
      now,
    });
  }
}

function summarizeHandoffUsage(handoffs: Array<{ items: CompletionHandoffV4['items'] }>): {
  textCharacters: number;
  artifactPaths: number;
} {
  let textCharacters = 0;
  let artifactPaths = 0;
  for (const handoff of handoffs) {
    for (const item of handoff.items) {
      if (item.type === 'text') textCharacters += item.value.length;
      else artifactPaths += item.paths.length;
    }
  }
  return { textCharacters, artifactPaths };
}

function deriveTopologyLayer(subtaskId: string, subtasks: Subtask[]): number {
  const byId = new Map(subtasks.map(subtask => [subtask.id, subtask]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`cyclic Subtask dependency while deriving topology layer: ${id}`);
    visiting.add(id);
    const subtask = byId.get(id);
    const layer = subtask
      ? subtask.dependencies.reduce((maximum, dependency) => (
          Math.max(maximum, visit(dependency.fromSubtaskId) + 1)
        ), 0)
      : 0;
    visiting.delete(id);
    memo.set(id, layer);
    return layer;
  };
  return visit(subtaskId);
}

function buildMergeRepairGoal(
  originalGoal: string,
  conflictingPaths: string[],
  workspacePath: string,
): string {
  return [
    'Resolve only the authorized Git merge conflicts. Do not change the original acceptance criteria, handoffs, or unrelated paths.',
    `Original Subtask goal (context only): ${originalGoal}`,
    `Writable conflict paths: ${conflictingPaths.join(', ')}`,
    `Read-only base/ours/theirs materials: ${join(workspacePath, '.metaclaw', 'merge-repair')}`,
    'For binary conflicts, regenerate exactly one target file from the supplied read-only versions.',
    'Runtime owns Git operations. Do not run git merge, git add, git commit, checkout, reset, or edit .git.',
    'Finish with Markdown followed by exactly one ---METACLAW-MERGE-REPAIR--- trailer.',
    'The trailer JSON must be {"protocol":"metaclaw:merge-repair:v1","resolvedPaths":["..."],"verification":{"summary":"..."}}.',
  ].join('\n');
}

function parseMergeRepairReport(rawResponse: string): {
  resolvedPaths: string[];
  verificationSummary: string;
} {
  const marker = '---METACLAW-MERGE-REPAIR---';
  const markerIndex = rawResponse.lastIndexOf(marker);
  if (markerIndex < 0 || rawResponse.indexOf(marker) !== markerIndex) {
    throw new Error('merge repair response must contain exactly one protocol trailer');
  }
  const payloadText = rawResponse.slice(markerIndex + marker.length).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('merge repair trailer is not valid JSON');
  }
  if (!payload || typeof payload !== 'object') throw new Error('merge repair trailer must be an object');
  const record = payload as Record<string, unknown>;
  if (record.protocol !== 'metaclaw:merge-repair:v1') {
    throw new Error('merge repair trailer protocol is invalid');
  }
  if (!Array.isArray(record.resolvedPaths)
    || record.resolvedPaths.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new Error('merge repair trailer resolvedPaths must contain non-empty strings');
  }
  const verification = record.verification;
  if (!verification || typeof verification !== 'object') {
    throw new Error('merge repair trailer verification is required');
  }
  const summary = (verification as Record<string, unknown>).summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('merge repair verification.summary must be non-empty');
  }
  return {
    resolvedPaths: record.resolvedPaths as string[],
    verificationSummary: summary.trim(),
  };
}

function checkpointObjects(checkpoint: StoredWorkspaceCheckpoint) {
  return checkpoint.manifest.entries.flatMap(entry => (
    entry.type === 'file' && entry.hash && entry.objectUri
      ? [{ hash: entry.hash, uri: entry.objectUri, size: entry.size, mediaType: null }]
      : []
  ));
}

function buildReceipt(input: {
  attemptId: string;
  executionId: string;
  taskId: string;
  subtaskId: string;
  workUnitId: string;
  agentClassName: string;
  startedAt: string;
  terminalState: ExecutorAttemptReceipt['terminalState'];
  rawResponse: string;
  completionSchemaVersion?: number | null;
  warnings?: string[];
  violations?: CompletionContractViolation[];
  errorCode?: string | null;
  errorDetail?: string | null;
  failure?: KernelFailure | null;
}, completedAt = new Date().toISOString()): ExecutorAttemptReceiptInsert {
  return {
    attemptId: input.attemptId,
    executionId: input.executionId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    workUnitId: input.workUnitId,
    agentClassName: input.agentClassName,
    startedAt: input.startedAt,
    completedAt,
    terminalState: input.terminalState,
    rawResponse: input.rawResponse,
    completionSchemaVersion: input.completionSchemaVersion ?? null,
    parsing: { completionMarker: input.completionSchemaVersion ? 'parsed' : 'unavailable' },
    verification: { warnings: input.warnings ?? [], violations: input.violations ?? [] },
    errorCode: input.errorCode ?? null,
    errorDetail: input.errorDetail ?? null,
    failure: input.failure ?? null,
  };
}

function boundedRecoveryPacket(
  receipt: ExecutorAttemptReceipt | null,
  runtime: ExecutorAttemptRuntimeRecord | null,
  attemptPayload: KernelAttemptPayload | undefined,
): Record<string, unknown> {
  const completionRetry = attemptPayload?.protocol === 'completion-correction-v2'
    ? {
        protocol: attemptPayload.protocol,
        violations: attemptPayload.violations.slice(0, 10).map(violation => ({
          code: violation.code.slice(0, 64),
          path: violation.path.slice(0, 256),
          message: violation.message.slice(0, 512),
        })),
        instructions: [
          'Inspect the existing worktree and preserve correct work from the source attempt.',
          'Complete every remaining acceptance criterion and verify the resulting files before finishing.',
          'Return a non-empty Markdown result followed by exactly one Completion Protocol marker and one strict JSON object.',
          'The marker must precede the JSON object; do not use a JSON code fence; the JSON object must be the final response bytes.',
        ],
      }
    : null;
  const packet = {
    sourceAttemptId: receipt?.attemptId ?? runtime?.attemptId ?? null,
    failure: receipt ? {
      terminalState: receipt.terminalState,
      code: receipt.errorCode,
      summary: receipt.errorDetail?.slice(0, 1_000) ?? null,
    } : null,
    knownProgress: runtime?.progress ?? {},
    workspaceDelta: runtime?.workspaceDelta ?? {},
    confirmedCompleted: [] as string[],
    unknownItems: ['Verify the current workspace and remaining acceptance criteria before making changes.'],
    completionRetry,
  };
  const serialized = JSON.stringify(packet);
  return serialized.length <= 16_000
    ? packet
    : { ...packet, knownProgress: {}, workspaceDelta: {}, truncated: true };
}
