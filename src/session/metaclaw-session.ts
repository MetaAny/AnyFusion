// Session facade that wires MetaClaw's task OS modules and exposes the user-facing session snapshot.
import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type {
  Config,
  GuidanceProposal,
  RuntimeState,
  Subtask,
  Task,
  TaskRecoveryTrigger,
} from '../core/types.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import { NoopNotificationService, type NotificationService } from '../notifications/types.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import { MemoryContextService } from '../memory/memory-context-service.js';
import { SessionPersistenceService } from './session-persistence-service.js';
import { createDefaultCommandCatalog } from '../commands/command-tree.js';
import { CommandReadServices } from '../commands/command-read-services.js';
import type { CommandCatalog, CommandCompletion, CommandContext } from '../commands/catalog.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import { TaskRuntimeService } from '../task/task-runtime-service.js';
import { ExecutionRuntime, ExecutorRegistry } from '../execution/execution-runtime.js';
import { ExecutorRecoveryRefreshService } from '../execution/executor-recovery-refresh-service.js';
import { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import { AgentClassService } from '../executor/agent-class-service.js';
import { ExecutorAdminService } from '../executor/executor-admin-service.js';
import { ExecutionProgressService } from '../execution/execution-progress-service.js';
import { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import { WorkspaceStore } from '../execution/workspace-store.js';
import { WorkspaceRetentionService } from '../execution/workspace-retention-service.js';
import { DockerCliAttemptSandboxAdapter } from '../execution/docker-cli-attempt-sandbox-adapter.js';
import type { AttemptSandboxPort } from '../execution/attempt-sandbox.js';
import { ResourceLeaseService } from '../execution/resource-lease-service.js';
import { WorkspacePublicationWorker } from '../execution/workspace-publication-worker.js';
import { SqliteResourceLeaseRepository } from '../storage/resource-lease-repo.js';
import { SqlitePermissionRepository } from '../storage/permission-repo.js';
import { SqliteAttemptSandboxRepository } from '../storage/attempt-sandbox-repo.js';
import { SqliteWorkspaceRepository } from '../storage/workspace-repo.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import {
  isPermissionRequestActive,
  permissionRequestExpiresAt,
  PermissionWorkflowService,
} from '../execution/permission-workflow-service.js';
import { RegisteredCapabilityResourceResolver } from '../execution/capability-resource-resolver.js';
import { buildPermissionRules } from '../resource/index.js';
import { AttemptSandboxReconciler } from '../execution/attempt-sandbox-reconciler.js';
import { InputController } from './input-controller.js';
import { SessionPresentationService, type GuidanceState } from './session-presentation-service.js';
import { KernelExecutionRuntime } from '../execution/kernel-execution-runtime.js';
import { SessionTaskExecutionApplicationService } from './session-task-execution-application-service.js';
import { type QueuedExecutionRequest } from './session-helpers.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { TaskExecutionEvidenceRepo } from '../execution/execution-evidence-port.js';
import { SubtaskAttemptRunner } from '../execution/subtask-attempt-runner.js';
import { contextRefKey } from '../work-graph/index.js';
import { isEligibleInteractionRef } from './assistant-reference-eligibility.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { PlanningAgent } from '../planning/planning-agent.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import { createDefaultPlanningAgent } from '../planning/anyfusion-planning-agent.js';
import { validatePlanningAgentPlan } from '../planning/planning-agent-plan-validator.js';
import { PlanningAgentPlanSchema } from '../planning/planning-agent-plan-schema.js';
import { normalizePlanningAgentPlanInput } from '../planning/planning-agent-plan-normalizer.js';
import type { PlanningAgentPlan, PlanningContext } from '../planning/planning-types.js';
import type { KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';
import { ControlKernel, type KernelDecision, type KernelEvent, type KernelSnapshot } from '../kernel/control-kernel.js';
import { DurableKernelWorkflow } from '../kernel/kernel-workflow.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import { TaskCancellationCoordinator } from '../execution/task-cancellation-coordinator.js';
import { SessionKernelRuntime } from './session-kernel-runtime.js';
import { PlannerRunRepo } from '../storage/planner-run-repo.js';
import { PlannerProposalRepo } from '../storage/planner-proposal-repo.js';
import {
  createPlannerProposalSubmissionId,
  plannerProposalFingerprint,
  type PlannerProposalPurpose,
  type PlannerProposalResult,
  type PlannerProposalSubmission,
} from '../planning/planner-proposal.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import { generateInteractionId } from '../utils/id.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';

export interface PlannerHostRegistrar {
  registerSession(sessionId: string, session: MetaclawSession): () => void;
}

export interface MetaclawSessionDeps {
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  db: Database.Database;
  config: Config;
  sessionId: string;
  contextRecaller: ContextRecaller;
  planningAgent?: PlanningAgent;
  notifier?: NotificationService;
  sourceRoot?: string;
  attemptSandbox?: AttemptSandboxPort;
  plannerHost?: PlannerHostRegistrar;
}

function boundedKernelRequestText(value: string): string {
  return redactSensitiveText(value).slice(0, 24_000);
}

function startupOrphanEvent(input: {
  sessionId: string;
  task: Task;
  subtaskId: string;
  attemptId: string;
  agentClassName: string;
  occurredAt: string;
}): Extract<KernelEvent, { type: 'execution_outcome' }> {
  return {
    schemaVersion: 5,
    type: 'execution_outcome',
    id: `startup_orphan_${input.attemptId}`,
    correlationId: input.task.id,
    causationId: input.attemptId,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    taskId: input.task.id,
    subtaskId: input.subtaskId,
    attemptId: input.attemptId,
    terminalKind: 'failed',
    agentClassName: input.agentClassName,
    attemptKind: 'primary',
    sourceAttemptId: null,
    failure: {
      kind: 'heartbeat_lost',
      scope: 'agent_class',
      code: 'startup_orphaned_work',
      summary: 'Metaclaw restarted with orphaned active work; explicit recovery is required',
    },
  };
}

export interface SessionSnapshot {
  output: string[];
  currentTaskId: string | null;
  currentTask: {
    id: string;
    title: string;
    status: Task['status'];
  } | null;
  runtimeState: RuntimeState;
  plannerState: {
    status: 'idle' | 'running';
  };
  latestGuidance: GuidanceState | null;
}

/** A bounded, read-only projection for the native Planner TUI bridge. */
export interface PlannerTuiSnapshot {
  schemaVersion: 1;
  session: {
    id: string;
    focusedTask: SessionSnapshot['currentTask'];
    runtimeState: RuntimeState;
    plannerState: SessionSnapshot['plannerState'];
    recentOutput: string[];
  };
  taskPool: Array<{
    id: string;
    title: string;
    goal: string;
    status: Task['status'];
    blockingReason: string | null;
    subtasks: Array<{
      id: string;
      title: string;
      status: Subtask['status'];
      preferredAgentClassList: string[];
    }>;
  }>;
  executorStatuses: KernelExecutorStatusProjection[];
}

/** A durable, presentation-only result projected from an integrated workspace publication. */
export interface PlannerTuiExecutorResult {
  schemaVersion: 1;
  publicationId: string;
  taskId: string;
  taskTitle: string;
  subtaskId: string;
  subtaskTitle: string;
  attemptId: string;
  executorName: string;
  report: string;
  artifacts: string[];
  warnings: string[];
  integrationCommit: string | null;
  completedAt: string;
  reportTruncated: boolean;
}

export interface PlannerTuiPermissionRequest {
  schemaVersion: 1;
  permissionRequestId: string;
  taskId: string;
  taskTitle: string;
  generationId: string;
  subtaskId: string;
  subtaskTitle: string;
  attemptId: string;
  executorName: string;
  permissionProfileId: string;
  capability: string;
  resource: string;
  operation: string;
  reason: string;
  suggestedScope: 'once' | 'attempt';
  escalationReason: string;
  createdAt: string;
  expiresAt: string;
}

export type PlannerTuiPermissionResolutionResult =
  | { status: 'resolved' | 'replayed'; resolution: 'approve' | 'deny'; message: string }
  | { status: 'conflict'; resolution: null; message: string };

export interface PlannerTuiCommandSubmissionResult {
  exitRequested: boolean;
  output: string[];
}

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

const DEFAULT_PLANNER_TIMEOUT_MS = 60_000;

/** Wires the session-facing services and exposes the imperative API used by TUI, CLI, gateway, and scripted runs. */
export class MetaclawSession {
  private output: string[] = [];
  private runtimeState: RuntimeState = {
    runningTaskId: null,
    runningExecutorName: null,
    readyTaskIds: [],
    blockedTaskIds: [],
    parkedTaskIds: [],
    lastEvent: null,
  };
  private latestGuidance: GuidanceState | null = null;
  private activePlannerRuns = 0;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private runningExecutorsByAttempt = new Map<string, {
    taskId: string;
    subtaskId: string;
    name: string;
  }>();
  private lastReminderAt: number | null = null;
  private lastReminderFingerprint: string | null = null;
  private lastTaskPoolWatchdogReminderAt: number | null = null;
  private lastTaskPoolWatchdogFingerprint: string | null = null;
  private lastBlockedRecheckAt: number | null = null;
  private blockedRecheckInFlight = false;
  private backgroundWork = new Set<Promise<void>>();
  private currentTaskId: string | null = null;
  private focusContext: FocusContext | null = null;
  private readonly memoryContextService: MemoryContextService;
  private readonly commandCatalog: CommandCatalog;
  private readonly sessionStateRepo: SessionStateRepo;
  private readonly notifier: NotificationService;
  private readonly inputController: InputController;
  private readonly taskRuntimeService: TaskRuntimeService;
  private readonly executionRuntime: ExecutionRuntime;
  private readonly commandReadServices: CommandReadServices;
  private readonly verificationAndDeliveryService: VerificationAndDeliveryService;
  private readonly persistenceService: SessionPersistenceService;
  private readonly presentation: SessionPresentationService;
  private readonly agentClassService: AgentClassService;
  private readonly executorAdminService: ExecutorAdminService;
  private readonly executionProgressService: ExecutionProgressService;
  private readonly planningContextBuilder: PlanningContextBuilder;
  private readonly planningAgent: PlanningAgent;
  private readonly controlKernel: ControlKernel;
  private readonly kernelDecisionRepo: KernelDecisionRepo;
  private readonly kernelWorkflowRepo: KernelWorkflowRepo;
  private readonly workGraphRuntimeService: WorkGraphRuntimeService;
  private readonly workGraphRevisionRepo: WorkGraphRevisionRepo;
  private readonly effectOutboxRepo: KernelEffectOutboxRepo;
  private readonly taskExecutionEvidenceRepo: TaskExecutionEvidenceRepo;
  private readonly attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  private readonly subtaskRepo: SubtaskRepo;
  private readonly taskEventRepo: TaskEventRepo;
  private readonly workUnitClaimService: WorkUnitClaimService;
  private readonly attemptRunner: SubtaskAttemptRunner;
  private readonly workspaceStore: WorkspaceStore;
  private readonly workspaceRetentionService: WorkspaceRetentionService;
  private workspaceRetentionSweep: Promise<void> | null = null;
  private readonly attemptSandbox: AttemptSandboxPort;
  private readonly permissionRepository: SqlitePermissionRepository;
  private readonly attemptSandboxRepository: SqliteAttemptSandboxRepository;
  private readonly workspaceRepository: SqliteWorkspaceRepository;
  private readonly kernelExecutionRuntime: KernelExecutionRuntime;
  private readonly taskExecutionApplicationService: SessionTaskExecutionApplicationService;
  private readonly sessionKernelRuntime: SessionKernelRuntime;
  private readonly kernelExecutorStatusRepo: KernelExecutorStatusRepo;
  private readonly executorRecoveryRefreshService: ExecutorRecoveryRefreshService;
  private readonly plannerProposalRepo: PlannerProposalRepo;
  private readonly publicationRepo: WorkspacePublicationRepo;
  private unregisterPlannerHost: (() => void) | null = null;

  constructor(private deps: MetaclawSessionDeps) {
    this.notifier = deps.notifier ?? new NoopNotificationService();
    this.sessionStateRepo = new SessionStateRepo(deps.db);
    this.plannerProposalRepo = new PlannerProposalRepo(deps.db);
    this.taskRuntimeService = new TaskRuntimeService({
      taskEngine: deps.taskEngine,
      taskRepo: deps.taskEngine.getTaskRepo(),
    });
    this.agentClassService = new AgentClassService({ db: deps.db });
    this.attemptSandbox = deps.attemptSandbox ?? new DockerCliAttemptSandboxAdapter();
    this.permissionRepository = new SqlitePermissionRepository(deps.db);
    this.attemptSandboxRepository = new SqliteAttemptSandboxRepository(deps.db);
    this.workspaceRepository = new SqliteWorkspaceRepository(deps.db);
    this.workspaceStore = new WorkspaceStore(resolve(resolveMetaclawDir(), 'workspace-store'));
    this.workspaceRetentionService = new WorkspaceRetentionService(
      this.workspaceRepository,
      this.workspaceStore,
    );
    const executorRegistry = new ExecutorRegistry({
      agentClassLookup: this.agentClassService,
      attemptSandbox: this.attemptSandbox,
      attemptSandboxRepository: this.attemptSandboxRepository,
      controlNetwork: process.env.METACLAW_CONTROL_NETWORK ?? 'metaclaw-control',
    });
    this.executionRuntime = new ExecutionRuntime(executorRegistry);
    this.commandReadServices = new CommandReadServices(deps.db, this.executionRuntime);
    this.verificationAndDeliveryService = new VerificationAndDeliveryService();
    this.persistenceService = new SessionPersistenceService(deps.db);
    this.presentation = new SessionPresentationService();
    this.executorAdminService = new ExecutorAdminService({
      agentClassService: this.agentClassService,
      presentation: this.presentation,
    });
    this.executionProgressService = new ExecutionProgressService(deps.db);
    this.subtaskRepo = new SubtaskRepo(deps.db);
    this.taskEventRepo = new TaskEventRepo(deps.db);
    this.workGraphRevisionRepo = new WorkGraphRevisionRepo(deps.db);
    this.effectOutboxRepo = new KernelEffectOutboxRepo(deps.db);
    this.taskExecutionEvidenceRepo = new TaskExecutionEvidenceRepo(deps.db);
    this.attemptReceiptRepo = new ExecutorAttemptReceiptRepo(deps.db);
    this.workGraphRuntimeService = new WorkGraphRuntimeService(
      this.subtaskRepo,
      this.taskEventRepo,
      this.workGraphRevisionRepo,
      this.taskExecutionEvidenceRepo,
    );
    this.kernelExecutorStatusRepo = new KernelExecutorStatusRepo(deps.db);
    const kernelExecutorStatusProjector = new KernelExecutorStatusProjector(this.kernelExecutorStatusRepo);
    this.workUnitClaimService = new WorkUnitClaimService(
      new WorkUnitRepo(deps.db),
      60_000,
      async (name, mode) => {
        const result = await this.executionRuntime.probeExecutor(name);
        if (mode === 'claim' && !result.available && result.failure) {
          kernelExecutorStatusProjector.recordExecutionOutcome({
            agentClassName: name,
            attemptId: `claim_probe_${generateInteractionId()}`,
            outcome: 'failed',
            failure: result.failure,
          });
        }
        return result.available;
      },
    );
    this.executorRecoveryRefreshService = new ExecutorRecoveryRefreshService({
      statusRepo: this.kernelExecutorStatusRepo,
      statusProjector: kernelExecutorStatusProjector,
      probe: (name, previousFailure) => this.executionRuntime.probeExecutor(name, previousFailure),
      onRecovered: (name, checkId) => this.kernelExecutionRuntime.executorRecovered(name, checkId),
    });
    this.memoryContextService = new MemoryContextService({
      memoryEngine: deps.memoryEngine,
      contextRecaller: deps.contextRecaller,
    });
    this.planningContextBuilder = new PlanningContextBuilder({
      sessionId: deps.sessionId,
      requestSource: 'session',
      getTimeoutMs: () => this.getPlannerTimeoutMs(),
    });
    this.planningAgent = deps.planningAgent ?? createDefaultPlanningAgent({
      audit: new PlannerRunRepo(deps.db),
    });
    this.controlKernel = new ControlKernel();
    this.kernelDecisionRepo = new KernelDecisionRepo(deps.db);
    this.kernelWorkflowRepo = new KernelWorkflowRepo(deps.db);
    this.commandCatalog = createDefaultCommandCatalog();
    this.inputController = new InputController({
      appendUserInput: (input: string) => this.appendUserInput(input),
      hasPendingExecutorRegisterWizard: () => this.executorAdminService.hasPendingWizard(),
      handlePendingExecutorRegisterWizard: (input: string) => this.handlePendingExecutorRegisterWizardInput(input),
      handleCommand: (input: string) => this.handleCommand(input),
      handleNaturalLanguageInput: (input: string) => this.handleNaturalLanguageInput(input),
      waitForAsyncWork: () => this.waitForAsyncWork(),
      handleSubmitError: (error: unknown) => this.appendOutput(`错误: ${(error as Error).message}`),
    });
    const sourceRoot = deps.sourceRoot
      ?? (process.env.NODE_ENV === 'test'
        ? resolve(process.cwd(), 'tests', 'fixtures', 'workspace-source')
        : process.cwd());
    const resourceLeaseService = new ResourceLeaseService(new SqliteResourceLeaseRepository(deps.db));
    const dispatchItemRepo = new KernelDispatchItemRepo(deps.db);
    this.publicationRepo = new WorkspacePublicationRepo(deps.db);
    const generationReplanRepo = new GenerationReplanRequestRepo(deps.db);
    const cancellationCoordinator = new TaskCancellationCoordinator({
      db: deps.db,
      taskRuntimeService: this.taskRuntimeService,
      subtaskRepo: this.subtaskRepo,
      taskEventRepo: this.taskEventRepo,
      workGraphRevisionRepo: this.workGraphRevisionRepo,
      dispatchItemRepo,
      publicationRepo: this.publicationRepo,
      generationReplanRepo,
      resourceLeaseService,
      workUnitClaimService: this.workUnitClaimService,
      activeExecutions: this.executionRuntime,
      attemptSandbox: this.attemptSandbox,
      attemptSandboxRepository: this.attemptSandboxRepository,
    });
    this.attemptRunner = new SubtaskAttemptRunner({
      db: deps.db,
      sessionId: deps.sessionId,
      taskRuntimeService: this.taskRuntimeService,
      subtaskRepo: this.subtaskRepo,
      workUnitClaimService: this.workUnitClaimService,
      executionRuntime: this.executionRuntime,
      agentClassService: this.agentClassService,
      workspaceStore: this.workspaceStore,
      attemptSandbox: this.attemptSandbox,
      resourceLeaseService,
      permissionRepository: this.permissionRepository,
      kernelWorkflowStore: this.kernelWorkflowRepo,
      workspaceRepository: this.workspaceRepository,
      sourceRoot,
      controlNetwork: process.env.METACLAW_CONTROL_NETWORK ?? 'metaclaw-control',
    });
    this.kernelExecutionRuntime = new KernelExecutionRuntime({
      sessionId: deps.sessionId,
      orchestration: deps.orchestration,
      notifier: this.notifier,
      taskRuntimeService: this.taskRuntimeService,
      agentClassService: this.agentClassService,
      workGraphRuntimeService: this.workGraphRuntimeService,
      subtaskRepo: this.subtaskRepo,
      workGraphRevisionRepo: this.workGraphRevisionRepo,
      effectOutboxRepo: this.effectOutboxRepo,
      attemptReceiptRepo: this.attemptReceiptRepo,
      subtaskHandoffRepo: new SubtaskHandoffRepo(deps.db),
      taskEventRepo: this.taskEventRepo,
      workUnitClaimService: this.workUnitClaimService,
      attemptRunner: this.attemptRunner,
      controlKernel: this.controlKernel,
      kernelWorkflowStore: this.kernelWorkflowRepo,
      dispatchItemRepo,
      maxConcurrentAttempts: deps.config.orchestration.max_concurrent_attempts,
      publicationWorker: new WorkspacePublicationWorker({
        db: deps.db,
        sessionId: deps.sessionId,
        sourceRoot,
        workspaceStore: this.workspaceStore,
        workspaceRepository: this.workspaceRepository,
        subtaskRepo: this.subtaskRepo,
        attemptReceiptRepo: this.attemptReceiptRepo,
        resourceLeaseService,
        dispatchItemRepo,
        taskRuntimeService: this.taskRuntimeService,
      }),
      publicationRepo: this.publicationRepo,
      generationReplanRepo,
      cancellationCoordinator,
      executionProgressService: this.executionProgressService,
      verificationAndDeliveryService: this.verificationAndDeliveryService,
      persistenceService: this.persistenceService,
      kernelExecutorStatusProjector,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        appendTaskQueueSnapshot: trigger => this.appendTaskQueueSnapshot(trigger),
        setFocusContext: focus => this.setFocusContext(focus),
        setRunningExecutorName: (taskId, subtaskId, attemptId, name) => (
          this.setRunningExecutorName(taskId, subtaskId, attemptId, name)
        ),
        clearRunningExecutorName: (taskId, attemptId) => this.clearRunningExecutorName(taskId, attemptId),
        persistSessionState: changes => this.persistSessionState(changes),
        setLatestGuidance: (scene, suggestion) => this.setLatestGuidance(scene, suggestion),
        queueProposal: (scene, proposal) => this.queueProposal(scene, proposal),
        requestReplan: decision => this.requestKernelReplan(decision),
        requestMergeReplan: decision => this.requestKernelMergeReplan(decision),
        buildPlanAdmissionSnapshot: event => this.buildPlanAdmissionSnapshot(event),
      },
    });
    this.taskExecutionApplicationService = new SessionTaskExecutionApplicationService({
      taskRuntimeService: this.taskRuntimeService,
      kernelExecutionRuntime: this.kernelExecutionRuntime,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        appendGuidance: (scene, suggestion) => this.appendGuidance(scene, suggestion),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        startBackgroundExecution: (taskId, work) => this.startBackgroundExecution(taskId, work),
      },
    });
    this.sessionKernelRuntime = new SessionKernelRuntime({
      sessionId: deps.sessionId,
      taskRuntimeService: this.taskRuntimeService,
      memoryContextService: this.memoryContextService,
      orchestration: deps.orchestration,
      activeExecutions: this.executionRuntime,
      presentation: this.presentation,
      callbacks: {
        appendOutput: (...lines: string[]) => this.appendOutput(...lines),
        deliverDirectReply: (userInput, reply) => this.deliverDirectReply(userInput, reply),
        prepareTaskExecution: (taskId, request) => this.prepareTaskExecution(taskId, request),
        refreshRuntimeState: () => this.refreshRuntimeState(),
        setCurrentTaskId: taskId => this.setCurrentTaskId(taskId),
        getCurrentTaskId: () => this.getCurrentTaskId(),
        setFocusContext: focus => this.setFocusContext(focus),
        resolveRequestText: eventId => {
          const event = this.kernelWorkflowRepo.findEvent(eventId);
          return event?.type === 'plan_proposed' ? event.requestText : '';
        },
        cancelTask: async (taskId, reason) => {
          await this.kernelExecutionRuntime.cancelTask(taskId, reason);
        },
      },
    });

    // AgentClass records are startup catalog data. Constructing a session must
    // make the catalog readable even for non-UI hosts that do not call the
    // optional dashboard-oriented initialize() lifecycle hook.
    this.seedAgentRuntime();
    this.unregisterPlannerHost = deps.plannerHost?.registerSession(deps.sessionId, this) ?? null;
  }

  dispose(): void {
    this.unregisterPlannerHost?.();
    this.unregisterPlannerHost = null;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    this.reconcileLatestGuidance();
    const currentTaskId = this.getCurrentTaskId();
    const currentTask = currentTaskId ? this.taskRuntimeService.findTask(currentTaskId) : null;
    return {
      output: [...this.output],
      currentTaskId,
      currentTask: currentTask
        ? {
            id: currentTask.id,
            title: currentTask.title,
            status: currentTask.status,
          }
        : null,
      runtimeState: this.runtimeState,
      plannerState: {
        status: this.activePlannerRuns > 0 ? 'running' : 'idle',
      },
      latestGuidance: this.latestGuidance
        ? {
            ...this.latestGuidance,
            reasons: [...this.latestGuidance.reasons],
          }
        : null,
    };
  }

  completeCommand(text: string, cursor = text.length): CommandCompletion {
    return this.commandCatalog.complete({ text, cursor, context: this.getCommandContext() });
  }

  /**
   * Returns presentation-only state for the native Planner TUI. This deliberately
   * reads through existing Session services; the bridge has no repository, Kernel,
   * scheduling, or executor write surface.
   */
  getPlannerTuiSnapshot(): PlannerTuiSnapshot {
    const snapshot = this.getSnapshot();
    return {
      schemaVersion: 1,
      session: {
        id: this.deps.sessionId,
        focusedTask: snapshot.currentTask ? { ...snapshot.currentTask } : null,
        runtimeState: {
          ...snapshot.runtimeState,
          readyTaskIds: [...snapshot.runtimeState.readyTaskIds],
          blockedTaskIds: [...snapshot.runtimeState.blockedTaskIds],
          parkedTaskIds: [...snapshot.runtimeState.parkedTaskIds],
        },
        plannerState: { ...snapshot.plannerState },
        recentOutput: snapshot.output.slice(-100),
      },
      taskPool: this.taskRuntimeService.listTasks().slice(0, 100).map(task => ({
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        blockingReason: (task.lastInterruptionReason
          || task.dependencies.find(dependency => dependency.status === 'waiting')?.description
          || '').slice(0, 500) || null,
        subtasks: this.subtaskRepo.listByTask(task.id).slice(0, 100).map(subtask => ({
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
          preferredAgentClassList: [...subtask.preferredAgentClassList],
        })),
      })),
      executorStatuses: this.kernelExecutorStatusRepo.list(),
    };
  }

  getPlannerTuiExecutorResults(): PlannerTuiExecutorResult[] {
    const taskIds = [...new Set(
      this.kernelDecisionRepo.listBySession(this.deps.sessionId)
        .map(decision => decision.taskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
    )];
    return this.publicationRepo.listIntegratedByTaskIds(taskIds).map(publication => {
      const task = this.taskRuntimeService.findTask(publication.taskId);
      const subtask = this.subtaskRepo.findById(publication.subtaskId);
      return {
        schemaVersion: 1,
        publicationId: publication.id,
        taskId: publication.taskId,
        taskTitle: task?.title ?? publication.taskId,
        subtaskId: publication.subtaskId,
        subtaskTitle: subtask?.title ?? publication.subtaskId,
        attemptId: publication.sourceAttemptId,
        executorName: publication.agentClassName,
        report: publication.originalCompletion.body,
        artifacts: [...publication.originalCompletion.artifacts],
        warnings: [...publication.originalCompletion.warnings],
        integrationCommit: publication.integrationCommit,
        completedAt: publication.updatedAt,
        reportTruncated: false,
      };
    });
  }

  getPlannerTuiPermissionRequests(): PlannerTuiPermissionRequest[] {
    const now = new Date().toISOString();
    const decisions = this.kernelDecisionRepo.listBySession(this.deps.sessionId);
    const appliedEscalations = new Map(decisions
      .filter(record => record.action === 'escalate_capability'
        && this.kernelWorkflowRepo.isDecisionApplied(record.id))
      .map(record => [record.correlationId, record]));
    return this.permissionRepository.listEscalated()
      .filter(record => appliedEscalations.has(record.request.id))
      .filter(record => !this.kernelDecisionRepo.listByCorrelation(record.request.id)
        .some(decision => decision.event.type === 'permission_resolution_received'
          && this.kernelWorkflowRepo.isDecisionApplied(decision.id)))
      .filter(record => isPermissionRequestActive(record.createdAt, now))
      .map(record => {
        const escalation = appliedEscalations.get(record.request.id)!;
        return {
          schemaVersion: 1,
          permissionRequestId: record.request.id,
          taskId: record.request.taskId,
          taskTitle: this.taskRuntimeService.findTask(record.request.taskId)?.title ?? record.request.taskId,
          generationId: record.request.generationId,
          subtaskId: record.request.subtaskId,
          subtaskTitle: this.subtaskRepo.findById(record.request.subtaskId)?.title ?? record.request.subtaskId,
          attemptId: record.request.attemptId,
          executorName: record.request.agentClassName,
          permissionProfileId: record.request.permissionProfileId,
          capability: record.request.capability,
          resource: record.request.resource,
          operation: record.request.operation,
          reason: record.request.reason,
          suggestedScope: record.request.suggestedScope,
          escalationReason: escalation.reason,
          createdAt: record.createdAt,
          expiresAt: permissionRequestExpiresAt(record.createdAt)!,
        };
      });
  }

  async resolvePlannerTuiPermission(
    permissionRequestId: string,
    resolution: 'approve' | 'deny',
  ): Promise<PlannerTuiPermissionResolutionResult> {
    await this.initialization;
    const decisions = this.kernelDecisionRepo.listByCorrelation(permissionRequestId);
    const escalation = decisions.find(record => record.sessionId === this.deps.sessionId
      && record.action === 'escalate_capability'
      && this.kernelWorkflowRepo.isDecisionApplied(record.id));
    if (!escalation) {
      return { status: 'conflict', resolution: null, message: 'Permission request does not belong to this session.' };
    }
    const appliedResolution = decisions.find(record => record.event.type === 'permission_resolution_received'
      && this.kernelWorkflowRepo.isDecisionApplied(record.id));
    if (appliedResolution?.event.type === 'permission_resolution_received') {
      if (appliedResolution.sessionId === this.deps.sessionId
        && appliedResolution.event.resolution === resolution
        && appliedResolution.event.source === 'button') {
        return { status: 'replayed', resolution, message: 'Permission resolution was already recorded.' };
      }
      return { status: 'conflict', resolution: null, message: 'Permission request was already resolved.' };
    }
    const record = this.permissionRepository.findRequest(permissionRequestId);
    if (!record || record.status !== 'escalated') {
      return { status: 'conflict', resolution: null, message: 'Permission request is no longer escalated.' };
    }
    if (!isPermissionRequestActive(record.createdAt, new Date().toISOString())) {
      return { status: 'conflict', resolution: null, message: 'Permission request has expired.' };
    }
    await this.resolvePermission({ requestId: permissionRequestId, resolution, source: 'button' });
    this.notify();
    return { status: 'resolved', resolution, message: 'Permission resolution recorded.' };
  }

  /**
   * Executes an explicit slash command from the native Planner TUI through the
   * existing Application-Shell command path. The Pi process only transports the
   * user's command; CommandCatalog and MetaclawSession retain all validation and
   * state-changing authority.
   */
  async submitPlannerTuiCommand(rawCommand: string): Promise<PlannerTuiCommandSubmissionResult> {
    await this.initialization;
    const command = rawCommand.trim();
    if (!/^\/\S/u.test(command)) {
      throw new Error('Planner TUI commands must start with /');
    }
    const outputStart = this.output.length;
    const result = await this.inputController.submit(command, { awaitAsyncWork: true });
    return {
      exitRequested: result.exitRequested,
      output: this.output.slice(outputStart),
    };
  }

  /**
   * Accepts a Planner proposal emitted by the AnyFusion-Pi host protocol. The Planner
   * remains untrusted with respect to state: schema and semantic validation happen
   * here, then the existing plan_proposed -> DurableKernelWorkflow path remains the
   * only state-changing route.
   */
  async submitPlannerProposal(
    submission: PlannerProposalSubmission,
    purpose: PlannerProposalPurpose = 'kernel',
  ): Promise<PlannerProposalResult> {
    await this.initialization;
    const normalizedInput = submission.userInput.trim();
    const normalizedSessionId = submission.sessionId.trim();
    const normalizedTurnId = submission.turnId.trim();
    if (!normalizedInput || !normalizedSessionId || !normalizedTurnId) {
      return {
        status: 'rejected',
        turnId: normalizedTurnId || submission.turnId,
        submissionId: submission.submissionId,
        planId: null,
        rejectionType: 'validation',
        issues: ['sessionId, turnId, and userInput must not be empty'],
        kernel: null,
      };
    }
    if (normalizedSessionId !== this.deps.sessionId) {
      return {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal session does not match the bound MetaClaw session.',
      };
    }
    const expectedSubmissionId = createPlannerProposalSubmissionId(
      normalizedSessionId, normalizedTurnId, submission.plan,
    );
    if (submission.submissionId !== expectedSubmissionId) {
      return {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal submissionId does not match the runtime-derived plan fingerprint.',
      };
    }

    const normalizedPlan = normalizePlanningAgentPlanInput(submission.plan);
    if (submission.runtimeMode === 'interactive'
      && typeof normalizedPlan === 'object' && normalizedPlan !== null
      && 'action' in normalizedPlan && normalizedPlan.action === 'authorization_resolution') {
      return {
        status: 'rejected',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        planId: 'id' in normalizedPlan && typeof normalizedPlan.id === 'string' ? normalizedPlan.id : null,
        rejectionType: 'validation',
        issues: ['Interactive permission decisions must use the host permission selector.'],
        kernel: null,
      };
    }

    const turn = this.plannerProposalRepo.ensureTurn(normalizedSessionId, normalizedTurnId, normalizedInput);
    if (turn.conflict) {
      return {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: null,
        message: 'Planner proposal turnId was already bound to different user input.',
      };
    }
    if (turn.created && purpose === 'kernel'
      && submission.runtimeMode !== 'rpc' && submission.runtimeMode !== 'session') {
      this.appendUserInput(normalizedInput);
    }

    const context = this.buildPlanningContext(normalizedInput);
    const validation = validatePlanningAgentPlan(
      normalizedPlan,
      context.executorCatalog,
      context.pendingAuthorizationRequest
        ? {
            requestId: context.pendingAuthorizationRequest.requestId,
            taskId: context.pendingAuthorizationRequest.taskId,
          }
        : null,
    );
    const parsedPlan = PlanningAgentPlanSchema.safeParse(normalizedPlan);
    const planId = parsedPlan.success ? parsedPlan.data.id : null;
    const eventId = parsedPlan.success && purpose === 'kernel'
      ? `plan_event_${submission.submissionId}`
      : null;
    const reservation = this.plannerProposalRepo.reserveSubmission({
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      submissionId: submission.submissionId,
      planFingerprint: plannerProposalFingerprint(submission.plan),
      planId,
      eventId,
    });
    if (reservation.kind === 'replay') return reservation.result;
    if (reservation.kind === 'in_flight') {
      const latest = this.plannerProposalRepo.getSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId,
      );
      if (latest?.result) return latest.result;
      return {
        status: 'transport_uncertain',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        retryableByReplay: true,
        message: 'The same Planner proposal is still being durably applied; replay the identical submission.',
      };
    }
    if (reservation.kind === 'conflict') {
      return {
        status: 'conflict',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        acceptedSubmissionId: reservation.acceptedSubmissionId,
        message: 'This Planner turn already has a different authoritative submission.',
      };
    }

    if (!validation.valid || !parsedPlan.success) {
      const issues = !validation.valid
        ? validation.errors
        : !parsedPlan.success
          ? parsedPlan.error.issues.map(issue => issue.message)
          : ['PlanningAgentPlan v7 validation failed'];
      const rejected: PlannerProposalResult & { status: 'rejected' } = {
        status: 'rejected',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        planId,
        rejectionType: 'validation',
        issues,
        kernel: null,
      };
      this.plannerProposalRepo.completeSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId, rejected,
      );
      return rejected;
    }

    const plan = parsedPlan.data as PlanningAgentPlan;
    if (purpose === 'validation') {
      const accepted: PlannerProposalResult & { status: 'accepted' } = {
        status: 'accepted',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        planId: plan.id,
        outcome: 'proposal_validated',
        displayText: 'PlanningAgentPlan v7 proposal validated by MetaClaw.',
        taskId: plan.task.taskId,
        kernel: null,
      };
      this.plannerProposalRepo.completeSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId, accepted,
      );
      return accepted;
    }

    const outputStart = this.output.length;
    try {
      const kernelResult = await this.submitValidatedPlanningAgentPlan(
        normalizedInput, plan, context, eventId!,
      );
      const application = kernelResult.decision
        ? this.kernelWorkflowRepo.findApplicationByDecisionId(kernelResult.decision.id)
        : null;
      if (!kernelResult.decision || application?.status !== 'applied') {
        this.plannerProposalRepo.markUncertain(
          normalizedSessionId, normalizedTurnId, submission.submissionId,
        );
        return {
          status: 'transport_uncertain',
          turnId: normalizedTurnId,
          submissionId: submission.submissionId,
          retryableByReplay: true,
          message: 'MetaClaw has not yet confirmed the authoritative Kernel application; replay the same submission.',
        };
      }
      if (kernelResult.decision.action.type === 'reject_request') {
        const rejected: PlannerProposalResult & { status: 'rejected' } = {
          status: 'rejected',
          turnId: normalizedTurnId,
          submissionId: submission.submissionId,
          planId: plan.id,
          rejectionType: 'kernel',
          issues: [kernelResult.decision.reason],
          kernel: {
            decisionId: kernelResult.decision.id,
            action: 'reject_request',
            reason: kernelResult.decision.reason,
          },
        };
        this.plannerProposalRepo.completeSubmission(
          normalizedSessionId, normalizedTurnId, submission.submissionId, rejected,
        );
        return rejected;
      }
      const accepted = this.toAcceptedPlannerProposalResult(
        normalizedTurnId, submission.submissionId, plan, kernelResult.decision,
        this.output.slice(outputStart),
      );
      this.plannerProposalRepo.completeSubmission(
        normalizedSessionId, normalizedTurnId, submission.submissionId, accepted,
      );
      return accepted;
    } catch (error) {
      this.plannerProposalRepo.markUncertain(
        normalizedSessionId, normalizedTurnId, submission.submissionId,
      );
      return {
        status: 'transport_uncertain',
        turnId: normalizedTurnId,
        submissionId: submission.submissionId,
        retryableByReplay: true,
        message: `MetaClaw proposal transport is uncertain: ${(error as Error).message}`,
      };
    }
  }

  private reconcileLatestGuidance(): void {
    if (!this.latestGuidance) {
      return;
    }

    const task = this.taskRuntimeService.findTask(this.latestGuidance.taskId);
    if (!task || !['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)) {
      this.latestGuidance = null;
      return;
    }

    if (this.latestGuidance.taskTitle !== task.title) {
      this.latestGuidance = {
        ...this.latestGuidance,
        taskTitle: task.title,
      };
    }
  }

  initialize(options: { resumeStartupTasks?: boolean; showDashboard?: boolean } = {}): void {
    if (this.initialized) return;

    this.seedAgentRuntime();

    const resumeStartupTasks = options.resumeStartupTasks ?? true;
    const showDashboard = options.showDashboard ?? true;
    const recoveredRunningTasks: Task[] = [];

    if (showDashboard && this.deps.config.ui.dashboard_on_start) {
      const dashboard = this.deps.orchestration.getDashboard();
      this.output = [
        '┌─ Metaclaw v1.0 ─────────────────────────────────┐',
        `│ 你有 ${dashboard.summary.active} 个活跃任务，${dashboard.summary.blocked} 个 Blocked。`,
      ];

      if (dashboard.priorityTask) {
        this.output.push(`│ 建议优先：#${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
        dashboard.priorityTask.reasons.forEach(reason => this.output.push(`│   → ${reason}`));
      }

      this.output.push('└──────────────────────────────────────────────────┘');

      if (dashboard.priorityTask) {
        this.appendGuidance('启动建议', {
          taskId: dashboard.priorityTask.id,
          recommendedAction: `优先处理任务 #${dashboard.priorityTask.id}: ${dashboard.priorityTask.title}`,
          reasons: dashboard.priorityTask.reasons,
        });
      }
    }

    if (recoveredRunningTasks.length > 0) {
      for (const task of recoveredRunningTasks) {
        this.output.push(
          `→ 检测到上次异常退出，任务 #${task.id} 已安全阻塞`,
          `→ 可执行 /task resume ${task.id} 提交显式恢复请求`,
        );
      }
    }

    const startupProposal = resumeStartupTasks ? this.deps.orchestration.generateProposals('startup')[0] : null;
    if (startupProposal) {
      this.queueProposal('启动建议', startupProposal);
    }

    this.initialized = true;
    this.initialization = resumeStartupTasks
      ? this.recoverDurableStartup().then(async recovered => {
          for (const task of recovered) {
            this.appendOutput(
              `→ 检测到上次异常退出，任务 #${task.id} 已安全阻塞（由 Kernel 持久恢复收敛）`,
              `→ 可执行 /task recovery ${task.id} 查看不确定项`,
            );
          }
          await this.executorRecoveryRefreshService.refresh({ trigger: 'session_start' });
        })
      : this.executorRecoveryRefreshService.refresh({ trigger: 'session_start' }).then(() => undefined);
    this.refreshRuntimeState();
    this.notify();
  }

  async submit(
    rawInput: string,
    options: { awaitAsyncWork?: boolean } = {},
  ): Promise<{ exitRequested: boolean }> {
    await this.initialization;
    return this.inputController.submit(rawInput, options);
  }

  async waitForAsyncWork(): Promise<void> {
    await this.initialization;
    while (this.backgroundWork.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundWork));
    }
  }

  appendSystemMessage(...lines: string[]): void {
    this.appendOutput(...lines);
  }

  private appendUserInput(userInput: string): void {
    this.appendOutput('', `> ${userInput}`);
  }

  maybeEmitIdleGuidance(nowMs = Date.now()): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const suggestions = this.deps.orchestration.generateSuggestions();
    if (suggestions.length === 0) {
      return false;
    }

    const suggestion = suggestions[0];
    const fingerprint = `${suggestion.type}:${suggestion.taskId}:${suggestion.reasons.join('|')}`;
    const throttleMs = this.deps.config.orchestration.reminder_throttle * 1000;

    if (
      this.lastReminderFingerprint === fingerprint
      && this.lastReminderAt !== null
      && nowMs - this.lastReminderAt < throttleMs
    ) {
      return false;
    }

    this.lastReminderAt = nowMs;
    this.lastReminderFingerprint = fingerprint;
    this.setLatestGuidance('空闲提醒', suggestion);
    this.appendOutput(
      '',
      `💡 提醒：${suggestion.recommendedAction}`,
      `   → 目标任务：#${suggestion.taskId}${this.buildSuggestionTaskTitleSuffix(suggestion.taskId)}`,
      ...suggestion.reasons.map(reason => `   → ${reason}`),
    );
    return true;
  }

  async maybeReconcileBlockedTasksOnTimer(nowMs = Date.now()): Promise<boolean> {
    if (this.blockedRecheckInFlight) {
      return false;
    }

    const orchestrationConfig = this.deps.config.orchestration;
    if (orchestrationConfig.blocked_recheck_enabled === false) {
      return false;
    }

    const intervalMs = Math.max(orchestrationConfig.blocked_recheck_interval ?? 60, 5) * 1000;
    if (
      this.lastBlockedRecheckAt !== null
      && nowMs - this.lastBlockedRecheckAt < intervalMs
    ) {
      return false;
    }

    const candidates = this.kernelDecisionRepo.listCurrentByAction('wait_for_capacity');
    if (candidates.length === 0) {
      this.lastBlockedRecheckAt = nowMs;
      return false;
    }

    this.lastBlockedRecheckAt = nowMs;
    this.blockedRecheckInFlight = true;
    try {
      const target = candidates[0];
      if (!target?.taskId || !target.subtaskId) return false;
      return this.kernelExecutionRuntime.recheckCapacity({
        taskId: target.taskId,
        subtaskId: target.subtaskId,
        blockedDecisionId: target.id,
        blockedAt: target.createdAt,
        recheckAfterMs: intervalMs,
        occurredAt: new Date(nowMs).toISOString(),
      });
    } finally {
      this.blockedRecheckInFlight = false;
      this.refreshRuntimeState();
    }
  }

  getBlockedRecheckIntervalMs(): number {
    const seconds = this.deps.config.orchestration.blocked_recheck_interval ?? 60;
    return Math.max(seconds, 5) * 1000;
  }

  async maybeReviewTaskPoolOnTimer(nowMs = Date.now()): Promise<boolean> {
    for (const task of this.taskRuntimeService.listTasksByStatus('blocked')) {
      if (await this.kernelExecutionRuntime.recoverDue(task.id, 'timer durable recovery drain')) return true;
    }
    if (await this.maybeReconcileBlockedTasksOnTimer(nowMs)) {
      return true;
    }

    this.refreshRuntimeState();
    return this.maybeEmitTaskPoolWatchdogReminder(nowMs);
  }

  private getWaitingBlockReason(task: Task): string {
    return task.dependencies
      .filter(dependency => dependency.status === 'waiting')
      .map(dependency => dependency.description)
      .filter(Boolean)
      .join('；');
  }

  private buildRecoveryTrigger(
    task: Task,
    input: {
      kind: TaskRecoveryTrigger['kind'];
      triggerReason: string;
      sourceInput?: string;
      blockedReason?: string;
      newlyProvidedResources?: string[];
    },
  ): TaskRecoveryTrigger {
    return {
      kind: input.kind,
      blockedReason: input.blockedReason || this.getWaitingBlockReason(task) || '未知原因',
      triggerReason: input.triggerReason,
      sourceInputExcerpt: input.sourceInput ? this.excerptInput(input.sourceInput) : undefined,
      newlyProvidedResources: input.newlyProvidedResources,
    };
  }

  private excerptInput(input: string, maxLength = 80): string {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private maybeEmitTaskPoolWatchdogReminder(nowMs: number): boolean {
    if (!this.deps.config.orchestration.reminder_enabled) {
      return false;
    }

    const blockedTasks = this.taskRuntimeService.listTasks()
      .filter(task => task.status === 'blocked');
    const parkedTasks = this.taskRuntimeService.listTasks()
      .filter(task => task.status === 'parked');
    if (blockedTasks.length === 0 && parkedTasks.length === 0) {
      return false;
    }

    const fingerprint = [
      ...blockedTasks.map(task => `b:${task.id}:${this.getWaitingBlockReason(task)}`),
      ...parkedTasks.map(task => `p:${task.id}:${task.lastInterruptionReason}:${task.snapshots.at(-1)?.nextStep ?? ''}`),
    ].join('|');
    const throttleMs = this.deps.config.orchestration.reminder_throttle * 1000;
    if (
      this.lastTaskPoolWatchdogFingerprint === fingerprint
      && this.lastTaskPoolWatchdogReminderAt !== null
      && nowMs - this.lastTaskPoolWatchdogReminderAt < throttleMs
    ) {
      return false;
    }

    this.lastTaskPoolWatchdogFingerprint = fingerprint;
    this.lastTaskPoolWatchdogReminderAt = nowMs;
    this.appendOutput(...this.presentation.formatTaskPoolWatchdogReminder({
      blockedTasks,
      parkedTasks,
      getWaitingBlockReason: task => this.getWaitingBlockReason(task),
    }));
    return true;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  private buildSuggestionTaskTitleSuffix(taskId: string): string {
    const task = this.taskRuntimeService.findTask(taskId);
    if (!task?.title) {
      return '';
    }

    return ` ${task.title}`;
  }

  private setLatestGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): GuidanceState {
    this.latestGuidance = this.presentation.buildGuidanceState(
      scene,
      suggestion,
      this.taskRuntimeService.findTask(suggestion.taskId)?.title ?? '',
    );
    return this.latestGuidance;
  }

  private appendGuidance(
    scene: string,
    suggestion: { taskId: string; recommendedAction: string; reasons: string[] },
  ): void {
    this.setLatestGuidance(scene, suggestion);
    this.appendOutput(
      ...this.presentation.formatGuidanceBlock(scene, suggestion, this.latestGuidance?.taskTitle ?? ''),
    );
  }

  private queueProposal(scene: string, proposal: GuidanceProposal): void {
    this.appendOutput(...this.presentation.formatProposalBlock(
      scene,
      proposal,
      proposal.taskId ? this.taskRuntimeService.findTask(proposal.taskId)?.title ?? '' : '',
    ));
    this.appendOutput('→ 操作提案已记录，不等待用户确认；满足执行条件的任务由调度器自动处理');
  }

  private seedAgentRuntime(): void {
    this.agentClassService.seedDefaults();
  }

  private async runPlanningAgent(context: PlanningContext): Promise<PlanningAgentPlan> {
    this.activePlannerRuns += 1;
    this.notify();
    try {
      return await this.planningAgent.plan(context);
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.notify();
    }
  }

  private buildPlanningContext(userInput: string): PlanningContext {
    const pendingPermission = this.permissionRepository.findOldestPending();
    return this.planningContextBuilder.build({
      userInput,
      pendingAuthorizationRequest: pendingPermission ? {
        requestId: pendingPermission.request.id,
        taskId: pendingPermission.request.taskId,
        capability: pendingPermission.request.capability,
        resource: pendingPermission.request.resource,
        operation: pendingPermission.request.operation,
        reason: pendingPermission.request.reason,
      } : null,
    });
  }

  private async submitValidatedPlanningAgentPlan(
    userInput: string,
    plan: PlanningAgentPlan,
    context: PlanningContext,
    eventId = `plan_event_${plan.id}_${generateInteractionId()}`,
  ): Promise<{ decision: KernelDecision | null }> {
    const event: KernelEvent = {
      schemaVersion: 5,
      type: 'plan_proposed',
      id: eventId,
      correlationId: plan.id,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: plan.task.taskId ?? undefined,
      proposal: plan,
      requestText: boundedKernelRequestText(userInput),
      generationId: `generation_${eventId}`,
      proposalSource: 'initial',
      targetGraphRevision: 1,
    };
    const snapshot = this.buildPlanAdmissionSnapshot(event, context.executorCatalog, userInput);
    const workflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: () => snapshot,
      store: this.kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: this.sessionKernelRuntime.forInput(userInput),
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: [
        'reject_request', 'request_clarification', 'deliver_direct_reply', 'no_op',
        'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
        'record_permission_resolution',
      ],
    });
    const workflowResult = await workflow.submit(event);
    const decision = workflowResult.decisions.find(candidate => candidate.eventId === eventId)
      ?? this.kernelDecisionRepo.findByEventId(eventId)?.decision
      ?? null;
    if (plan.action === 'authorization_resolution' && plan.authorizationResolution) {
      await this.resolvePermission({
        requestId: plan.authorizationResolution.requestId,
        resolution: plan.authorizationResolution.resolution,
        source: 'planner',
        plannerPlanId: plan.id,
      });
    }
    return { decision };
  }

  private toAcceptedPlannerProposalResult(
    turnId: string,
    submissionId: string,
    plan: PlanningAgentPlan,
    decision: KernelDecision,
    outputLines: string[],
  ): Extract<PlannerProposalResult, { status: 'accepted' }> {
    const outcome = decision.action.type === 'authorize_task_plan'
      ? 'task_authorized'
      : decision.action.type === 'authorize_task_control'
        ? 'task_control_authorized'
        : decision.action.type === 'deliver_direct_reply'
          ? 'direct_reply_delivered'
          : decision.action.type === 'request_clarification'
            ? 'clarification_requested'
            : decision.action.type === 'record_permission_resolution'
              ? 'authorization_recorded'
              : 'no_action';
    const displayText = outputLines.join('\n').trim() || (
      decision.action.type === 'deliver_direct_reply'
        ? decision.action.response
        : decision.action.type === 'request_clarification'
          ? decision.action.question
          : decision.action.type === 'authorize_task_plan'
            ? `规划已通过 MetaClaw 授权，任务 ${decision.action.taskId} 已创建。`
            : '规划提案已由 MetaClaw 接受。'
    );
    return {
      status: 'accepted',
      turnId,
      submissionId,
      planId: plan.id,
      outcome,
      displayText,
      taskId: 'taskId' in decision.action ? decision.action.taskId : plan.task.taskId,
      kernel: { decisionId: decision.id, action: decision.action.type, reason: decision.reason },
    };
  }

  private async handlePlanningKernelDecision(userInput: string): Promise<boolean> {
    this.appendOutput('【MetaClaw｜理解用户请求】');
    const context = this.buildPlanningContext(userInput);
    const turnId = `turn_${generateInteractionId()}`;
    this.activePlannerRuns += 1;
    this.notify();
    let result: PlannerProposalResult;
    try {
      result = await this.planningAgent.submit(context, {
        submit: plan => this.submitPlannerProposal({
          sessionId: this.deps.sessionId,
          turnId,
          userInput,
          submissionId: createPlannerProposalSubmissionId(this.deps.sessionId, turnId, plan),
          plan,
          runtimeMode: 'session',
        }),
      });
    } finally {
      this.activePlannerRuns = Math.max(0, this.activePlannerRuns - 1);
      this.notify();
    }
    if (result.status === 'accepted') return true;
    if (result.status === 'rejected') {
      this.appendOutput(this.presentation.formatKernelRejection(result.issues.join('; ')));
      return true;
    }
    if (result.status === 'conflict') {
      this.appendOutput(`规划回合冲突：${result.message}`);
      return true;
    }
    this.appendOutput(`Warning: 规划提案传输状态不确定；请重放同一请求。${result.message}`);
    return true;
  }

  private async requestKernelReplan(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
    },
  ): Promise<Extract<KernelEvent, { type: 'plan_proposed' }>> {
    const task = this.taskRuntimeService.findTask(decision.action.taskId);
    if (!task) throw new Error(`replan Task not found: ${decision.action.taskId}`);
    this.workGraphRuntimeService.materializeCompletedEvidence(task.id, decision.action.sourceRevision);
    const evidence = this.taskExecutionEvidenceRepo.listTaskEvidenceByGeneration(
      task.id,
      decision.action.generationId,
    );
    const failures = this.attemptReceiptRepo.listByTask(task.id)
      .filter(item =>
        item.generationId === decision.action.generationId
        && item.graphRevision === decision.action.sourceRevision
        && item.terminalState !== 'completed'
      )
      .sort((left, right) =>
        left.completedAt.localeCompare(right.completedAt)
        || left.attemptId.localeCompare(right.attemptId)
      );
    const request = [
      'Produce a replan for the remaining work of the existing Task. Return plan_work_graph only.',
      `Task id: ${task.id}`,
      `Task goal: ${task.goal}`,
      `Generation: ${decision.action.generationId}`,
      `Superseded revision: ${decision.action.sourceRevision}`,
      'The new graph must describe only remaining work and may reference the task_evidence IDs below.',
      `Completed evidence: ${JSON.stringify(evidence.map(item => ({
        evidenceId: item.id,
        title: item.title,
        summary: item.content.slice(0, 2_000),
      })))}`,
      `Structured failures and attempted candidates: ${JSON.stringify(failures.map(item => ({
        attemptId: item.attemptId,
        agentClassName: item.agentClassName,
        terminalState: item.terminalState,
        failure: item.failure,
        code: item.errorCode,
        summary: String(item.errorDetail ?? '').slice(0, 1_000),
      })))}`,
      'Bind the proposal to the exact existing Task id. Do not include raw Executor responses.',
    ].join('\n\n').slice(0, 24_000);
    const context = this.planningContextBuilder.build({
      userInput: request,
    });
    const plan = await this.runPlanningAgent(context);
    return {
      schemaVersion: 5,
      type: 'plan_proposed',
      id: `replan_event_${decision.id}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: task.id,
      proposal: plan,
      requestText: boundedKernelRequestText(request),
      generationId: decision.action.generationId,
      proposalSource: 'replan',
      targetGraphRevision: decision.action.sourceRevision + 1,
      availabilityExplanation: null,
    };
  }

  private async requestKernelMergeReplan(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
    },
  ): Promise<Extract<KernelEvent, { type: 'plan_proposed' }> | null> {
    const task = this.taskRuntimeService.findTask(decision.action.taskId);
    const revision = this.workGraphRevisionRepo.findActive(decision.action.taskId);
    if (!task || !revision) return null;
    const request = [
      'Replan only the remaining semantic work after a Git publication conflict.',
      'Do not create a dedicated conflict-resolution Subtask.',
      'Return plan_work_graph bound to the exact existing Task and preserve completed facts.',
      `Task id: ${task.id}`,
      `Task goal: ${task.goal}`,
      `Conflicted Subtask id: ${decision.action.subtaskId}`,
      `Publication id: ${decision.action.publicationId}`,
      `Conflict chain id: ${decision.action.conflictChainId}`,
      'The revised remaining work must let the original delivery intent publish without choosing or silently overwriting a conflicting version.',
    ].join('\n\n').slice(0, 24_000);
    const context = this.planningContextBuilder.build({
      userInput: request,
    });
    const plan = await this.runPlanningAgent(context);
    return {
      schemaVersion: 5,
      type: 'plan_proposed',
      id: `merge_replan_event_${decision.id}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: task.id,
      proposal: plan,
      requestText: boundedKernelRequestText(request),
      generationId: revision.generationId,
      proposalSource: 'conflict_replan',
      targetGraphRevision: revision.revision + 1,
      availabilityExplanation: null,
    };
  }

  private buildPlanAdmissionSnapshot(
    event: Extract<KernelEvent, { type: 'plan_proposed' }>,
    executorCatalog = this.planningContextBuilder.getExecutorCatalog(),
    userInput = event.proposal.task.goal ?? '',
  ): Extract<KernelSnapshot, { type: 'plan_admission' }> {
    return {
      schemaVersion: 5,
      type: 'plan_admission',
      tasks: this.taskRuntimeService.listTasks().map(task => ({ id: task.id, status: task.status })),
      runningTaskId: this.kernelExecutionRuntime.getSingleActiveTaskId(),
      executorCatalog,
      executorStatuses: this.kernelExecutorStatusRepo.list(),
      v5WorkGraphTaskIds: this.subtaskRepo.listTaskIds(),
      eligibleContextRefKeys: this.buildEligibleContextRefKeys(event.proposal as PlanningAgentPlan, userInput),
      pendingAuthorizationRequest: (() => {
        const pending = this.permissionRepository.findOldestPending();
        return pending ? { requestId: pending.request.id, taskId: pending.request.taskId } : null;
      })(),
    };
  }

  private buildEligibleContextRefKeys(plan: PlanningAgentPlan, userInput: string): string[] {
    const refs = (plan.workGraph?.subtasks ?? []).flatMap(subtask => subtask.contextRefs);
    const targetTask = plan.task.taskId ? this.taskRuntimeService.findTask(plan.task.taskId) : null;
    const eligible = new Set<string>();
    for (const ref of refs) {
      if (ref.kind === 'current_user_input') {
        eligible.add(contextRefKey(ref));
        continue;
      }
      if (ref.kind === 'task_resource') {
        if (targetTask?.resources.includes(ref.locator) || (!targetTask && userInput.includes(ref.locator))) {
          eligible.add(contextRefKey(ref));
        }
        continue;
      }
      if (ref.kind === 'preference') {
        const row = this.deps.db.prepare('SELECT status FROM preferences WHERE id = ?').get(ref.preferenceId) as { status: string } | undefined;
        if (row?.status === 'confirmed') eligible.add(contextRefKey(ref));
        continue;
      }
      if (ref.kind === 'task_evidence') {
        const row = this.deps.db.prepare(`
          SELECT id FROM task_execution_evidence WHERE id = ? AND task_id = ? AND kind = 'task_evidence'
        `).get(ref.evidenceId, targetTask?.id ?? '') as { id: string } | undefined;
        if (row) eligible.add(contextRefKey(ref));
        continue;
      }
      if (isEligibleInteractionRef({
        db: this.deps.db,
        sessionId: this.deps.sessionId,
        ref,
        targetTaskId: targetTask?.id ?? null,
        userInput,
      })) {
        eligible.add(contextRefKey(ref));
      }
    }
    return [...eligible];
  }

  private appendPlanningClarification(plan: PlanningAgentPlan): void {
    this.appendOutput(
      plan.clarificationQuestion
        || '我不确定你是想继续聊天、创建新任务，还是恢复某个已有任务。请明确说明下一步动作。',
    );
  }

  private prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
  ): void {
    return this.taskExecutionApplicationService.prepareTaskExecution(taskId, request);
  }

  private startBackgroundExecution(taskId: string, launch: () => Promise<void>): void {
    const scheduled = new Promise<void>(resolveWork => {
      setTimeout(() => {
        void launch().catch(error => {
          this.appendOutput(`Executor background failure for ${taskId}: ${(error as Error).message}`);
          this.refreshRuntimeState();
        }).finally(resolveWork);
      }, 0);
    });
    this.trackBackgroundWork(scheduled);
  }

  private appendOutput(...lines: string[]): void {
    if (lines.length === 0) return;
    this.output.push(...lines);
    this.notify();
  }

  private setCurrentTaskId(taskId: string | null): void {
    this.currentTaskId = taskId;
    this.notify();
  }

  private getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  private refreshRuntimeState(): void {
    const tasks = this.taskRuntimeService.listTasks();
    this.workspaceRetentionService.reconcileTaskStatuses(tasks);
    this.triggerWorkspaceRetentionSweep();
    const runningTask = tasks.find(task => task.status === 'running') ?? null;
    const schedulerState: RuntimeState = {
      runningTaskId: runningTask?.id ?? this.kernelExecutionRuntime.getSingleActiveTaskId(),
      runningExecutorName: null,
      readyTaskIds: tasks.filter(task => task.status === 'ready').map(task => task.id),
      blockedTaskIds: tasks.filter(task => task.status === 'blocked').map(task => task.id),
      parkedTaskIds: tasks.filter(task => task.status === 'parked').map(task => task.id),
      lastEvent: this.runtimeState.lastEvent,
    };
    this.runtimeState = {
      ...schedulerState,
      runningExecutorName: schedulerState.runningTaskId
        ? this.formatRunningExecutors(schedulerState.runningTaskId)
        : null,
    };
    this.notify();
  }

  private appendTaskQueueSnapshot(trigger: string): void {
    const entries = this.buildTaskQueueSnapshotEntries();
    if (entries.length === 0) {
      return;
    }

    this.appendOutput(...this.presentation.formatTaskQueueSnapshot({
      trigger,
      runtimeState: this.runtimeState,
      entries,
    }));
  }

  private buildTaskQueueSnapshotEntries() {
    return this.presentation.buildTaskQueueSnapshotEntries({
      tasks: this.taskRuntimeService.listTasks(),
      runningTaskId: this.runtimeState.runningTaskId,
      evaluateTask: task => this.deps.orchestration.evaluateTask(task),
    });
  }

  private persistSessionState(changes: {
    lastFocusedTaskId?: string | null;
    lastCompletedTaskId?: string | null;
    lastSessionId?: string | null;
  }): void {
    this.sessionStateRepo.upsert(changes);
  }

  private async handleCommand(userInput: string): Promise<boolean> {
    if (/^\/task\s+(resume|recover|recovery)\b/iu.test(userInput)) {
      await this.executorRecoveryRefreshService.refresh({ trigger: 'task_recovery' });
    }
    const result = await this.commandCatalog.execute(userInput, this.getCommandContext());
    this.appendOutput(result.content);
    if (/^\/executor\s+(register|unregister)\b/iu.test(userInput)) {
      await this.executorRecoveryRefreshService.refresh({ trigger: 'executor_changed' });
    }

    if (result.type === 'directive' && result.directive.kind === 'start-executor-register-wizard') {
      this.appendOutput(...this.executorAdminService.startWizard());
    }

    if (result.type === 'exit') {
      this.persistSessionState({ lastSessionId: this.deps.sessionId });
      return true;
    }

    if (result.type === 'directive' && result.directive.kind === 'resume-task') {
      const directive = result.directive;
      const resumedTask = this.taskRuntimeService.findTask(directive.taskId);
      if (resumedTask) {
        this.setCurrentTaskId(resumedTask.id);
        await this.prepareTaskExecution(resumedTask.id, {
          userPrompt: resumedTask.goal,
          contextTaskId: resumedTask.id,
          executionMode: directive.mode,
          schedulingReason: directive.mode === 'resume-blocked' ? '解除阻塞' : '恢复已暂停任务',
          newlyProvidedResources: directive.newlyProvidedResources,
          recoveryTrigger: directive.mode === 'resume-blocked'
            ? this.buildRecoveryTrigger(resumedTask, {
                kind: 'explicit-task-command',
                blockedReason: directive.blockedReason,
                triggerReason: directive.newlyProvidedResources?.length
                  ? '显式解除阻塞并补充材料'
                  : '显式解除阻塞',
                sourceInput: userInput,
                newlyProvidedResources: directive.newlyProvidedResources,
              })
            : undefined,
        });
      }
    }

    if (result.type === 'directive' && result.directive.kind === 'show-task-recovery') {
      this.appendOutput(this.formatTaskRecovery(result.directive.taskId));
    }

    if (result.type === 'directive' && result.directive.kind === 'resolve-task-recovery') {
      await this.resolveTaskRecovery(result.directive);
    }

    return false;
  }

  private triggerWorkspaceRetentionSweep(): void {
    if (this.workspaceRetentionSweep) return;
    const sweep = this.workspaceRetentionService.sweepDue()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.workspaceRetentionSweep = null;
      });
    this.workspaceRetentionSweep = sweep;
    this.trackBackgroundWork(sweep);
  }

  private async resolvePermission(input: {
    requestId: string;
    resolution: 'approve' | 'deny';
    source: 'button' | 'planner';
    plannerPlanId?: string | null;
  }): Promise<void> {
    const record = this.permissionRepository.findRequest(input.requestId);
    if (!record) throw new Error(`permission request not found: ${input.requestId}`);
    const sandbox = this.attemptSandboxRepository.find(record.request.attemptId);
    const workspaceId = sandbox?.workspaceId
      ?? `workspace:${record.request.taskId}:${record.request.generationId}:${record.request.subtaskId}`;
    const task = this.taskRuntimeService.findTask(record.request.taskId);
    const resourceRegistrations = new Map((task?.resources ?? []).map((resource, index) => [
      resource,
      { kind: 'path' as const, mountId: `inputs-${record.request.taskId}`, normalizedRelativePath: `resource-${index}` },
    ]));
    const workflow = new PermissionWorkflowService({
      context: {
        sessionId: this.deps.sessionId,
        taskId: record.request.taskId,
        generationId: record.request.generationId,
        subtaskId: record.request.subtaskId,
        attemptId: record.request.attemptId,
        agentClassName: record.request.agentClassName,
        permissionProfileId: record.request.permissionProfileId,
        containerId: sandbox?.containerId ?? '',
        workspaceId,
        checkpointId: null,
      },
      repository: this.permissionRepository,
      resolver: new RegisteredCapabilityResourceResolver(resourceRegistrations),
      sandbox: this.attemptSandbox,
      workflowStore: this.kernelWorkflowRepo,
      kernel: this.controlKernel,
      rules: buildPermissionRules({
        permissionProfileId: record.request.permissionProfileId,
        additionalReadPartitions: resourceRegistrations.values(),
      }),
      hooks: {
        checkpoint: async () => null,
        onEscalation: async () => undefined,
        onRecoveryAuthorized: async ({ request }) => {
          if (!task || !request) return;
          await this.prepareTaskExecution(task.id, {
            userPrompt: task.goal,
            contextTaskId: task.id,
            executionMode: 'resume-blocked',
            schedulingReason: `permission ${input.requestId} approved; recover persistent workspace`,
          });
        },
      },
    });
    await workflow.resolve({
      requestId: input.requestId,
      resolution: input.resolution,
      source: input.source,
      plannerPlanId: input.plannerPlanId ?? null,
    });
  }

  private formatTaskRecovery(taskId: string): string {
    const applications = this.kernelWorkflowRepo.listRecoveryItems(taskId).map(item =>
      `- ${item.id} [application/${item.status}] ${item.decision.action.type}: ${item.errorSummary ?? 'no error summary'}`
    );
    const effects = this.effectOutboxRepo.listRecoveryItems(taskId).map(item =>
      `- ${item.id} [effect/${item.status}] ${item.effectType}: ${item.errorSummary ?? 'no error summary'}`
    );
    const items = [...applications, ...effects];
    return items.length > 0
      ? `Task #${taskId} recovery items:\n${items.join('\n')}`
      : `Task #${taskId} has no uncertain or failed recovery items.`;
  }

  private async resolveTaskRecovery(input: {
    taskId: string;
    recoveryItemId: string;
    resolution: 'assume_applied' | 'retry';
  }): Promise<void> {
    const event: Extract<KernelEvent, { type: 'recovery_resolution_requested' }> = {
      schemaVersion: 5,
      type: 'recovery_resolution_requested',
      id: `recovery_event_${input.recoveryItemId}_${generateInteractionId()}`,
      correlationId: input.taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId: input.taskId,
      recoveryItemId: input.recoveryItemId,
      resolution: input.resolution,
    };
    const workflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: () => this.buildRecoverySnapshot(input.taskId, input.recoveryItemId),
      store: this.kernelWorkflowRepo,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'resolve_recovery') {
            const now = new Date().toISOString();
            if (this.kernelWorkflowRepo.findRecoveryItem(decision.action.recoveryItemId)) {
              this.kernelWorkflowRepo.resolveRecoveryItem(
                decision.action.recoveryItemId, decision.action.resolution, now,
              );
            } else {
              this.effectOutboxRepo.resolve(
                decision.action.recoveryItemId, decision.action.resolution, now,
              );
            }
            return null;
          }
          if (decision.action.type === 'block_work') {
            this.appendOutput(`Recovery blocked: ${decision.reason}`);
            return null;
          }
          throw new Error(`manual recovery Runtime cannot apply ${decision.action.type}`);
        },
      },
      acceptedEventTypes: ['recovery_resolution_requested'],
      acceptedActions: ['resolve_recovery', 'block_work'],
      taskId: input.taskId,
    });
    await workflow.submit(event);
    this.appendOutput(this.formatTaskRecovery(input.taskId));
  }

  private buildRecoverySnapshot(
    taskId: string,
    recoveryItemId: string,
  ): Extract<KernelSnapshot, { type: 'recovery' }> {
    const task = this.taskRuntimeService.findTask(taskId);
    const application = this.kernelWorkflowRepo.findRecoveryItem(recoveryItemId);
    const effect = this.effectOutboxRepo.find(recoveryItemId);
    return {
      schemaVersion: 5,
      type: 'recovery',
      task: task ? { id: task.id, status: task.status } : null,
      item: application
        ? { id: application.id, kind: 'application', status: application.status as 'uncertain' | 'failed', retrySafe: true }
        : effect && (effect.status === 'uncertain' || effect.status === 'failed')
          ? { id: effect.id, kind: 'effect', status: effect.status, retrySafe: false }
          : null,
    };
  }

  private getCommandContext(): CommandContext {
    return {
      taskEngine: this.deps.taskEngine,
      memoryEngine: this.deps.memoryEngine,
      orchestration: this.deps.orchestration,
      activeExecutions: this.executionRuntime,
      taskControl: this.kernelExecutionRuntime,
      readServices: this.commandReadServices,
      refreshExecutors: agentClassNames => this.executorRecoveryRefreshService.refresh({
        trigger: 'manual',
        agentClassNames,
      }),
      currentTaskId: this.getCurrentTaskId(),
      db: this.deps.db,
      config: this.deps.config,
    };
  }

  private async handlePendingExecutorRegisterWizardInput(userInput: string): Promise<boolean> {
    const result = await this.executorAdminService.handlePendingWizardInput(userInput);
    this.appendOutput(...result.lines);
    if (result.handled) {
      await this.executorRecoveryRefreshService.refresh({ trigger: 'executor_changed' });
    }
    return result.handled;
  }

  private async handleNaturalLanguageInput(userInput: string): Promise<void> {
    if (await this.handlePlanningKernelDecision(userInput)) {
      return;
    }

    this.appendOutput(
      '-> ControlKernel did not produce a runtime action.',
      'Please clarify whether you want to chat, create a new task, resume an existing task, or dispatch an executor.',
    );
  }

  private getPlannerTimeoutMs(): number {
    const configured = Number(process.env.METACLAW_PLANNER_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_PLANNER_TIMEOUT_MS;
  }

  // Delivers the PlanningAgent's own answer for a direct_reply turn. The planner
  // runs read-only and already produced the user-visible reply, so we surface it
  // directly and record the interaction — no second (writable) executor call.
  // While the reply is being delivered we surface the planner as the active
  // executor in runtimeState (mirrors the conversation-runtime status main kept
  // for TUI/Feishu), then restore the scheduler-backed state afterwards.
  private deliverDirectReply(userInput: string, reply: string): void {
    this.setDirectReplyRuntimeState('planning-agent');
    try {
      this.appendOutput(reply);
      this.persistenceService.recordInteraction({
        taskId: null,
        sessionId: this.deps.sessionId,
        userInput,
        systemOutput: reply,
        executorUsed: 'planning-agent',
      });
      this.setFocusContext({ kind: 'conversation', taskId: null });
    } finally {
      this.setDirectReplyRuntimeState(null);
    }
  }

  // Sets/clears the runtime state for a direct-reply turn. When a durable task
  // is running we leave its state untouched (refresh only); otherwise we pin the
  // replying executor name and a descriptive lastEvent so the TUI status bar and
  // Feishu can show who is answering. Clearing passes null to restore.
  private setDirectReplyRuntimeState(executorName: string | null): void {
    this.refreshRuntimeState();
    const schedulerState = this.runtimeState;
    if (schedulerState.runningTaskId) {
      this.refreshRuntimeState();
      return;
    }

    this.runtimeState = {
      ...schedulerState,
      runningExecutorName: executorName,
      lastEvent: executorName
        ? `普通对话由 ${executorName} 生成回答`
        : schedulerState.lastEvent,
    };
    this.notify();
  }

  private setFocusContext(focus: FocusContext | null): void {
    this.focusContext = focus ? { ...focus } : null;
    if (focus?.kind === 'task' && focus.taskId) {
      this.persistSessionState({ lastFocusedTaskId: focus.taskId });
    }
  }

  private getFocusContext(): FocusContext | null {
    return this.focusContext ? { ...this.focusContext } : null;
  }

  private async recoverDurableStartup(): Promise<Task[]> {
    const now = new Date().toISOString();
    const sandboxLossAttemptIds = new Set<string>();
    const claimedOrphans = this.workUnitClaimService.listOrphanedClaims();
    const dispatchItems = new KernelDispatchItemRepo(this.deps.db);
    const requiresAttemptReconciliation = claimedOrphans.length > 0
      || this.attemptSandboxRepository.listActive().length > 0
      || this.taskRuntimeService.listTasksByStatus('running').some(task =>
        dispatchItems.listByTask(task.id).some(item =>
          ['launching', 'running', 'cancelling', 'uncertain'].includes(item.status)
        )
      );
    let recoveryBlockedReason: string | null = null;
    try {
      if (requiresAttemptReconciliation) {
        const checkpointIds = new Map<string, string | null>();
        const reconciliation = await new AttemptSandboxReconciler(
          this.attemptSandbox,
          this.attemptSandboxRepository,
        ).reconcile({
          checkpoint: async record => {
            const persisted = this.workspaceRepository.find(record.workspaceId);
            if (!persisted) {
              checkpointIds.set(record.attemptId, null);
              return;
            }
            const workspace = await this.workspaceStore.ensureWorkspace({
              taskId: persisted.taskId,
              generationId: persisted.generationId,
              subtaskId: persisted.subtaskId,
            }, persisted.kind);
            const checkpoint = await this.workspaceStore.createCheckpoint(workspace, {
              reason: 'failure', attemptId: record.attemptId, now,
            });
            this.workspaceRepository.recordCheckpoint({
              id: checkpoint.id,
              workspaceId: workspace.id,
              attemptId: record.attemptId,
              reason: 'failure',
              manifestUri: checkpoint.manifestUri,
              manifestHash: checkpoint.manifestHash,
              manifestSize: checkpoint.manifestSize,
              createdAt: checkpoint.manifest.createdAt,
              objects: checkpoint.manifest.entries.flatMap(entry => (
                entry.type === 'file' && entry.hash && entry.objectUri
                  ? [{ hash: entry.hash, uri: entry.objectUri, size: entry.size, mediaType: null }]
                  : []
              )),
            });
            checkpointIds.set(record.attemptId, checkpoint.id);
          },
        });
        for (const record of [...reconciliation.lostAttempts, ...reconciliation.exitedAttempts]) {
          if (sandboxLossAttemptIds.has(record.attemptId)) continue;
          sandboxLossAttemptIds.add(record.attemptId);
          const dispatchItem = dispatchItems.find(record.attemptId);
          if (dispatchItem && ['cancelling', 'cancelled'].includes(dispatchItem.status)) {
            continue;
          }
          dispatchItems.markUncertain(
            record.attemptId,
            `sandbox ${record.containerId} was reconciled during startup`,
            now,
          );
          this.kernelWorkflowRepo.enqueue({
            schemaVersion: 5,
            type: 'sandbox_lost',
            id: `sandbox_lost_${record.attemptId}`,
            correlationId: record.taskId,
            causationId: record.attemptId,
            occurredAt: now,
            sessionId: this.deps.sessionId,
            taskId: record.taskId,
            subtaskId: record.subtaskId,
            attemptId: record.attemptId,
            containerId: record.containerId,
            workspaceId: record.workspaceId,
            checkpointId: checkpointIds.get(record.attemptId) ?? null,
          });
        }
      }
      await this.kernelExecutionRuntime.recoverCancellations();
    } catch (error) {
      recoveryBlockedReason = error instanceof Error ? error.message : String(error);
    }
    if (recoveryBlockedReason) {
      const blocked: Task[] = [];
      for (const task of this.taskRuntimeService.listTasksByStatus('running')) {
        try {
          this.taskRuntimeService.blockTask(task.id, {
            taskId: task.id,
            type: 'manual',
            description: `startup recovery blocked: ${recoveryBlockedReason}`,
            status: 'waiting',
          });
        } catch {
          // Keep the in-memory recovery fence even if persistence is unavailable.
        }
        const current = this.taskRuntimeService.findTask(task.id);
        if (current) blocked.push(current);
      }
      this.appendOutput(
        `恢复阻塞：无法安全对账 Docker、Git 或持久状态（${recoveryBlockedReason}）。`,
        '已保留现有 sandbox、WorkUnit claim 与 resource lease；恢复对账成功前不会启动 attempt。',
      );
      return blocked;
    }
    this.effectOutboxRepo.reconcileSending(now);
    this.kernelWorkflowRepo.reconcileProcessing();
    for (const effect of this.effectOutboxRepo.listPending(now)) {
      if (effect.effectType !== 'task_completion_notification') continue;
      await this.effectOutboxRepo.deliver(effect.id, async record => {
        await this.verificationAndDeliveryService.deliverTaskCompletion(
          this.notifier,
          record.payload as unknown as Parameters<VerificationAndDeliveryService['deliverTaskCompletion']>[1],
        );
        return effect.id;
      }, () => new Date().toISOString());
    }

    const planningWorkflow = new DurableKernelWorkflow({
      kernel: this.controlKernel,
      buildSnapshot: event => this.buildPlanAdmissionSnapshot(
        event as Extract<KernelEvent, { type: 'plan_proposed' }>,
      ),
      store: this.kernelWorkflowRepo,
      runtime: this.sessionKernelRuntime.forInput(),
      clock: { now: () => new Date().toISOString() },
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: [
        'reject_request', 'request_clarification', 'deliver_direct_reply', 'no_op',
        'authorize_task_plan', 'authorize_task_control', 'block_work', 'park_for_replan',
      ],
    });
    await planningWorkflow.recover();

    const reconciledLeases = new ResourceLeaseService(
      new SqliteResourceLeaseRepository(this.deps.db),
    );
    const recovered: Task[] = [];
    try {
      for (const task of this.taskRuntimeService.listTasksByStatus('running')) {
      const activeSubtasks = this.subtaskRepo.listActiveByTask(task.id);
      const subtasks = activeSubtasks.length > 0 ? activeSubtasks : this.subtaskRepo.listByTask(task.id);
      const taskClaims = claimedOrphans.filter(workUnit => workUnit.claimedTaskId === task.id);
      for (const workUnit of taskClaims) {
        if (!workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
        this.attemptRunner.landHeartbeatLost({
          attemptId: workUnit.claimedAttemptId,
          executionId: `startup_${workUnit.claimedAttemptId}`,
          taskId: task.id,
          subtaskId: workUnit.claimedSubtaskId,
          workUnitId: workUnit.id,
          agentClassName: workUnit.agentClassName,
        });
        reconciledLeases.releaseReconciledAttempt(workUnit.claimedAttemptId, now);
        this.workUnitClaimService.releaseReconciledClaim({
          workUnitId: workUnit.id,
          taskId: task.id,
          subtaskId: workUnit.claimedSubtaskId,
          attemptId: workUnit.claimedAttemptId,
        });
        if (!sandboxLossAttemptIds.has(workUnit.claimedAttemptId)) {
          this.kernelWorkflowRepo.enqueue(startupOrphanEvent({
            sessionId: this.deps.sessionId,
            task,
            subtaskId: workUnit.claimedSubtaskId,
            attemptId: workUnit.claimedAttemptId,
            agentClassName: workUnit.agentClassName,
            occurredAt: now,
          }));
        }
      }
      if (taskClaims.length === 0 && !this.kernelWorkflowRepo.hasRecoverableWork(task.id)) {
        const orphan = subtasks.find(subtask => !['done', 'cancelled'].includes(subtask.status));
        if (orphan) {
          this.kernelWorkflowRepo.enqueue(startupOrphanEvent({
            sessionId: this.deps.sessionId,
            task,
            subtaskId: orphan.id,
            attemptId: `startup_missing_${task.id}_${orphan.id}`,
            agentClassName: orphan.preferredAgentClassList[0] ?? 'unknown',
            occurredAt: now,
          }));
        }
      }
      await this.kernelExecutionRuntime.recoverDue(task.id, 'startup durable recovery');
      const current = this.taskRuntimeService.findTask(task.id);
      if (current) recovered.push(current);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const blocked: Task[] = [];
      for (const task of this.taskRuntimeService.listTasksByStatus('running')) {
        try {
          this.taskRuntimeService.blockTask(task.id, {
            taskId: task.id,
            type: 'manual',
            description: `startup recovery blocked: ${reason}`,
            status: 'waiting',
          });
        } catch {
          // Preserve durable attempt ownership if even the diagnostic Task update fails.
        }
        const current = this.taskRuntimeService.findTask(task.id);
        if (current) blocked.push(current);
      }
      this.appendOutput(
        `恢复阻塞：无法安全封口 attempt terminal 事实（${reason}）。`,
        '已保留尚未安全封口的 WorkUnit claim 与 resource lease；修复持久状态后可重试启动恢复。',
      );
      return blocked;
    }
    for (const task of this.taskRuntimeService.listTasksByStatus('blocked')) {
      if (recovered.some(item => item.id === task.id)) continue;
      await this.kernelExecutionRuntime.recoverDue(task.id, 'startup due-event drain');
    }
    return recovered;
  }

  private setRunningExecutorName(
    taskId: string,
    subtaskId: string,
    attemptId: string,
    name: string,
  ): void {
    this.runningExecutorsByAttempt.set(attemptId, { taskId, subtaskId, name });
    this.runtimeState = {
      ...this.runtimeState,
      lastEvent: `Kernel dispatched ${name} for ${taskId}/${subtaskId}/${attemptId}`,
    };
    this.refreshRuntimeState();
  }

  private clearRunningExecutorName(taskId: string, attemptId?: string): void {
    if (attemptId) {
      this.runningExecutorsByAttempt.delete(attemptId);
    } else {
      for (const [activeAttemptId, active] of this.runningExecutorsByAttempt) {
        if (active.taskId === taskId) this.runningExecutorsByAttempt.delete(activeAttemptId);
      }
    }
    this.runtimeState = { ...this.runtimeState, lastEvent: `Kernel execution settled for ${taskId}` };
    this.refreshRuntimeState();
  }

  private formatRunningExecutors(taskId: string): string | null {
    const names = [...this.runningExecutorsByAttempt.values()]
      .filter(active => active.taskId === taskId)
      .map(active => active.name)
      .sort();
    if (names.length === 0) return null;
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => count === 1 ? name : `${name} ×${count}`).join(', ');
  }

  private trackBackgroundWork(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.finally(() => {
      this.backgroundWork.delete(work);
    });
  }

}
