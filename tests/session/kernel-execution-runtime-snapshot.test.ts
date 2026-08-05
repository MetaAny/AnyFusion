import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import { ControlKernel, type KernelSnapshot } from '../../src/kernel/control-kernel.js';

describe('KernelExecutionRuntime dispatch snapshots', () => {
  it('reads the Task before and after durable recovery', async () => {
    const task = {
      id: 'task_1', title: 'Task', goal: 'Goal', status: 'blocked',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    const findTask = vi.fn().mockReturnValue(task);
    const applyWorkGraph = vi.fn().mockReturnValue({
      outcome: 'recovered', workGraph: { reason: 'existing', subtasks: [] }, subtasks: [],
    });
    const runtime = new KernelExecutionRuntime({
      taskRuntimeService: { findTask },
      workGraphRuntimeService: { apply: applyWorkGraph },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);
    vi.spyOn(runtime, 'execute').mockResolvedValue();

    await runtime.recoverDue(task.id);

    expect(findTask).toHaveBeenCalledTimes(3);
    expect(applyWorkGraph).toHaveBeenCalledTimes(1);
  });

  it('derives recovery safety from the failed Subtask instead of the ready frontier', () => {
    const task = { id: 'task_1', title: 'Task', goal: 'Goal', status: 'running' };
    const subtask = {
      id: 'subtask_external',
      taskId: task.id,
      title: 'External write',
      goal: 'Publish once',
      status: 'awaiting_decision',
      dependencies: [],
      preferredAgentClassList: ['codex-cli'],
      requiredCapabilities: ['unknown-capability'],
    };
    const runtime = new KernelExecutionRuntime({
      taskRuntimeService: {
        findTask: vi.fn().mockReturnValue(task),
        getCurrentRunningTask: vi.fn().mockReturnValue(task),
      },
      subtaskRepo: {
        listByTask: vi.fn().mockReturnValue([subtask]),
        listActiveByTask: vi.fn().mockReturnValue([]),
      },
      subtaskHandoffRepo: { listByTask: vi.fn().mockReturnValue([]) },
      attemptReceiptRepo: { listByTask: vi.fn().mockReturnValue([]) },
      workGraphRevisionRepo: { findActive: vi.fn().mockReturnValue(null) },
      dispatchItemRepo: { listByTask: vi.fn().mockReturnValue([]) },
      publicationRepo: { hasBlockingResidue: vi.fn().mockReturnValue(false) },
      cancellationCoordinator: {
        findCleanupTaskId: vi.fn().mockReturnValue(null),
        completionBlockedReasons: vi.fn().mockReturnValue([]),
      },
      maxConcurrentAttempts: 4,
      taskEventRepo: {},
    } as never);
    const snapshot = (runtime as unknown as {
      buildDispatchSnapshot(
        taskId: string,
        graphState: 'ready',
        stableFacts: {
          executorStatuses: [];
          correctionSupportedAgentClasses: [];
          nativeContinuationAgentClasses: [];
        },
        attempts: [],
        recoverySubtaskId: string,
      ): KernelSnapshot;
    }).buildDispatchSnapshot(
      task.id,
      'ready',
      { executorStatuses: [], correctionSupportedAgentClasses: [], nativeContinuationAgentClasses: [] },
      [],
      subtask.id,
    );

    expect(snapshot).toMatchObject({
      type: 'dispatch',
      recoverySafety: 'external_non_idempotent',
      automaticRecoveryAllowed: false,
    });
    const decision = new ControlKernel().decide({
      schemaVersion: 5,
      type: 'execution_outcome',
      id: 'event_external_failure',
      correlationId: 'task_1',
      causationId: 'attempt_1',
      occurredAt: '2026-07-22T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: task.id,
      subtaskId: subtask.id,
      attemptId: 'attempt_1',
      terminalKind: 'failed',
      agentClassName: 'codex-cli',
      attemptKind: 'primary',
      sourceAttemptId: null,
      failure: {
        kind: 'network',
        scope: 'agent_class',
        code: 'network_failure',
        summary: 'network unavailable',
      },
    }, snapshot);
    expect(decision.action).toEqual({
      type: 'block_work',
      taskId: task.id,
      subtaskId: subtask.id,
    });
  });

  it('retries durable cancellation cleanup in-process after a transient failure', async () => {
    vi.useFakeTimers();
    const recover = vi.fn()
      .mockRejectedValueOnce(new Error('Docker temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const findCleanupTaskId = vi.fn().mockReturnValue(null);
    const refreshRuntimeState = vi.fn();
    const runtime = new KernelExecutionRuntime({
      taskEventRepo: {},
      dispatchItemRepo: {
        listPending: vi.fn().mockReturnValue([]),
      },
      maxConcurrentAttempts: 4,
      cancellationCoordinator: {
        recover,
        findCleanupTaskId,
      },
      callbacks: { refreshRuntimeState },
    } as never);

    try {
      await (runtime as unknown as {
        drainCancellation(taskId: string): Promise<void>;
      }).drainCancellation('task_cancel');
      expect(recover).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(recover).toHaveBeenCalledTimes(2);
      expect(findCleanupTaskId).toHaveBeenCalled();
      expect(refreshRuntimeState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
