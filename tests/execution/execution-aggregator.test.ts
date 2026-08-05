import { describe, expect, it } from 'vitest';
import {
  ExecutionAggregator,
  type AggregationPlan,
  type ExecutionSubtask,
  type SubtaskResult,
} from '../../src/execution/execution-aggregator.js';

function createUnit(overrides: Partial<ExecutionSubtask>): ExecutionSubtask {
  return {
    id: 'subtask_test',
    title: 'Test unit',
    goal: 'Test goal',
    executorHint: 'codex-cli',
    dependsOn: [],
    inputs: { taskId: 'task_agg', resources: [], recalledTaskIds: [] },
    deliveryKind: 'report',
    acceptance: [],
    riskLevel: 'low',
    ...overrides,
  };
}

function createResult(overrides: Partial<SubtaskResult>): SubtaskResult {
  return {
    subtaskId: 'subtask_test',
    executorName: 'codex-cli',
    status: 'success',
    output: 'ok',
    artifacts: [],
    startedAt: '2026-06-14T10:00:00.000Z',
    finishedAt: '2026-06-14T10:00:01.000Z',
    ...overrides,
  };
}

function createAggregationPlan(): AggregationPlan {
  return {
    mode: 'verify_and_summarize',
    acceptance: [],
    conflictPolicy: 'flag_conflicts',
  };
}

describe('ExecutionAggregator', () => {
  it('summarizes research and implementation outputs with artifacts when verification passes', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_research', deliveryKind: 'report' }),
        createUnit({ id: 'subtask_implementation', deliveryKind: 'edit' }),
      ],
      results: [
        createResult({
          subtaskId: 'subtask_research',
          executorName: 'hermes-agent',
          output: '来源: internal docs. Key finding: use FTS first.',
        }),
        createResult({
          subtaskId: 'subtask_implementation',
          executorName: 'codex-cli',
          output: 'Changed docs/task-os.md. npm test -- tests/execution/execution-aggregator.test.ts',
          artifacts: ['docs/task-os.md'],
        }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('pass');
    expect(result.artifacts).toEqual(['docs/task-os.md']);
    expect(result.finalOutput).toContain('Verification: pass');
    expect(result.finalOutput).toContain('subtask_research');
    expect(result.finalOutput).toContain('subtask_implementation');
  });

  it('flags conflicting subtask outputs', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_a', deliveryKind: 'report' }),
        createUnit({ id: 'subtask_b', deliveryKind: 'report' }),
      ],
      results: [
        createResult({ subtaskId: 'subtask_a', output: '来源: A. conclusion conflict with B.' }),
        createResult({ subtaskId: 'subtask_b', output: '来源: B. conclusion contradict A.' }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns.some(concern => concern.message.includes('冲突'))).toBe(true);
    expect(result.finalOutput).toContain('Verification: concerns');
  });

  it('does not infer edit contract failures from output wording or model artifact claims', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_edit', deliveryKind: 'edit' }),
      ],
      results: [
        createResult({ subtaskId: 'subtask_edit', output: 'Changed src/core/foo.ts.', artifacts: [] }),
      ],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('pass');
    expect(result.concerns).toEqual([]);
  });

  it('flags missing subtask results as errors', () => {
    const result = new ExecutionAggregator().aggregate({
      subtasks: [
        createUnit({ id: 'subtask_missing', deliveryKind: 'report' }),
      ],
      results: [],
      aggregation: createAggregationPlan(),
    });

    expect(result.status).toBe('concerns');
    expect(result.concerns[0]).toMatchObject({
      subtaskId: 'subtask_missing',
      severity: 'error',
    });
  });
});
