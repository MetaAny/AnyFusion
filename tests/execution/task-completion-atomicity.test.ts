import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { KernelEffectOutboxRepo } from '../../src/storage/kernel-effect-outbox-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import type { KernelDecision } from '../../src/kernel/control-kernel.js';
import type { Subtask } from '../../src/core/types.js';

describe('Task completion atomicity', () => {
  it('rolls back revision completion with Task and outbox when the completion effect cannot persist', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-completion-atomicity');
    const taskRuntimeService = new TaskRuntimeService({ taskEngine, taskRepo });
    const task = taskEngine.create({
      id: 'task-completion-atomicity',
      title: 'Atomic completion',
      goal: 'Complete everything or nothing',
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    const subtaskRepo = new SubtaskRepo(db);
    const subtask: Subtask = {
      id: 'subtask-completion-atomicity',
      taskId: task.id,
      graphRevision: 1,
      generationId: 'generation-completion-atomicity',
      title: 'Done node',
      goal: 'Produce a result',
      status: 'done',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      preferredAgentClassList: ['codex-cli'],
      deliveryKind: 'report',
      acceptance: [],
      riskLevel: 'low',
      result: 'durable result',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: 3 },
      error: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    };
    subtaskRepo.upsert(subtask);
    const revisions = new WorkGraphRevisionRepo(db);
    revisions.activate({
      id: 'revision-completion-atomicity',
      taskId: task.id,
      revision: 1,
      generationId: subtask.generationId,
      authorizedDecisionId: null,
      proposalSource: 'initial',
      automaticReplan: false,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const effects = new KernelEffectOutboxRepo(db);
    db.exec(`
      CREATE TRIGGER reject_task_completion_effect
      BEFORE INSERT ON kernel_effect_outbox
      WHEN NEW.id = 'effect_decision-complete_task_completion'
      BEGIN
        SELECT RAISE(ABORT, 'injected completion outbox failure');
      END
    `);
    const runtime = new KernelExecutionRuntime({
      sessionId: 'session-completion-atomicity',
      taskRuntimeService,
      subtaskRepo,
      workGraphRevisionRepo: revisions,
      effectOutboxRepo: effects,
      taskEventRepo: new TaskEventRepo(db),
      dispatchItemRepo: { listPending: vi.fn().mockReturnValue([]) },
      maxConcurrentAttempts: 4,
      cancellationCoordinator: {
        completionBlockedReasons: vi.fn().mockReturnValue([]),
      },
      persistenceService: {
        recordInteraction: vi.fn(),
      },
      memoryCaptureService: {
        captureCompletionPatterns: vi.fn().mockReturnValue({ lines: [] }),
      },
      callbacks: {
        setFocusContext: vi.fn(),
        persistSessionState: vi.fn(),
        appendTaskQueueSnapshot: vi.fn(),
        refreshRuntimeState: vi.fn(),
      },
    } as never);
    const decision: KernelDecision = {
      schemaVersion: 5,
      id: 'decision-complete',
      eventId: 'event-complete',
      reason: 'all Subtasks completed',
      action: {
        type: 'complete_task',
        taskId: task.id,
      },
    };

    await expect((runtime as unknown as {
      applyExecutionDecision(input: unknown): Promise<unknown>;
    }).applyExecutionDecision({
      decision,
      executionId: 'execution-complete',
      request: {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: 'follow-up',
        origin: 'system',
      },
      progressTracker: {},
      supervisorContext: {},
      attemptFacts: [],
      finishExecution: vi.fn(),
    })).rejects.toThrow('injected completion outbox failure');

    expect(taskRepo.findById(task.id)?.status).toBe('running');
    expect(revisions.find(task.id, 1)).toMatchObject({
      status: 'active',
      completionKind: null,
    });
    expect(effects.find('effect_decision-complete_task_completion')).toBeNull();
  });
});
