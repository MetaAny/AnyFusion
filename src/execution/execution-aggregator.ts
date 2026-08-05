// Aggregates subtask executor outputs, verifies expected evidence, and prepares retry feedback.

export interface ExecutionSubtask {
  id: string;
  title: string;
  goal: string;
  executorHint: string;
  dependsOn: string[];
  inputs: {
    taskId: string;
    resources: string[];
    recalledTaskIds: string[];
  };
  deliveryKind: 'edit' | 'report';
  acceptance: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  requiredEvidence: string[];
  severity: 'must' | 'should';
  appliesToSubtaskIds: string[];
}

export interface AggregationPlan {
  mode: 'summarize' | 'verify_and_summarize';
  acceptance: string[];
  criteria: AcceptanceCriterion[];
  conflictPolicy: 'flag_conflicts' | 'prefer_primary_executor';
  maxIterations: number;
}

export interface SubtaskResult {
  subtaskId: string;
  executorName: string;
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  output: string;
  artifacts: string[];
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface ExecutionAggregationInput {
  subtasks: ExecutionSubtask[];
  results: SubtaskResult[];
  aggregation: AggregationPlan;
}

export interface ExecutionVerificationConcern {
  subtaskId: string;
  criterionId: string;
  severity: 'warning' | 'error';
  message: string;
  feedback: string;
}

export interface ExecutionAggregationResult {
  status: 'pass' | 'concerns';
  finalOutput: string;
  concerns: ExecutionVerificationConcern[];
  artifacts: string[];
  retryFeedback: Array<{
    subtaskId: string;
    feedback: string;
  }>;
}

function hasConflict(left: SubtaskResult, right: SubtaskResult): boolean {
  const pair = `${left.output}\n${right.output}`;
  return /(冲突|conflict|contradict|不一致)/i.test(pair);
}

/** Verifies multi-executor subtask results and composes final output plus per-subtask retry feedback. */
export class ExecutionAggregator {
  aggregate(input: ExecutionAggregationInput): ExecutionAggregationResult {
    const concerns = this.verify(input);
    const artifacts = Array.from(new Set(input.results.flatMap(result => result.artifacts)));
    const status: ExecutionAggregationResult['status'] = concerns.some(concern => concern.severity === 'error')
      ? 'concerns'
      : concerns.length > 0 ? 'concerns' : 'pass';

    return {
      status,
      finalOutput: this.buildFinalOutput(input, concerns, artifacts),
      concerns,
      artifacts,
      retryFeedback: this.buildRetryFeedback(concerns),
    };
  }

  private verify(input: ExecutionAggregationInput): ExecutionVerificationConcern[] {
    const concerns: ExecutionVerificationConcern[] = [];
    const resultsById = new Map(input.results.map(result => [result.subtaskId, result]));

    for (const unit of input.subtasks) {
      const result = resultsById.get(unit.id);
      if (!result) {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'subtask_result_present',
          severity: 'error',
          message: '缺少 subtask 执行结果',
          feedback: '请重新执行该 subtask，并返回完整执行结果。',
        });
        continue;
      }

      if (result.status !== 'success') {
        concerns.push({
          subtaskId: unit.id,
          criterionId: 'subtask_success',
          severity: 'error',
          message: `subtask 未成功完成：${result.status}`,
          feedback: `请修复失败原因后重新执行。失败状态：${result.status}。错误：${result.error ?? result.output}`,
        });
        continue;
      }

    }

    for (let leftIndex = 0; leftIndex < input.results.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < input.results.length; rightIndex += 1) {
        const left = input.results[leftIndex]!;
        const right = input.results[rightIndex]!;
        if (hasConflict(left, right)) {
          concerns.push({
            subtaskId: `${left.subtaskId},${right.subtaskId}`,
            criterionId: 'cross_subtask_consistency',
            severity: 'warning',
            message: '不同 subtask 输出存在冲突或不一致，需要人工确认',
            feedback: '请对冲突结论进行复核，明确采用哪个结论以及理由。',
          });
        }
      }
    }

    return concerns;
  }

  private buildFinalOutput(
    input: ExecutionAggregationInput,
    concerns: ExecutionVerificationConcern[],
    artifacts: string[],
  ): string {
    const resultLines = input.results.map(result => [
      `## ${result.subtaskId} (${result.executorName}, ${result.status})`,
      result.output.trim() || '(no output)',
    ].join('\n'));

    return [
      '# Multi-executor result',
      '',
      concerns.length === 0 ? 'Verification: pass' : 'Verification: concerns',
      concerns.length > 0
        ? concerns.map(concern => `- [${concern.severity}] ${concern.subtaskId} (${concern.criterionId}): ${concern.message}`).join('\n')
        : '',
      artifacts.length > 0 ? `Artifacts:\n${artifacts.map(artifact => `- ${artifact}`).join('\n')}` : '',
      '',
      ...resultLines,
      '',
      `Aggregation mode: ${input.aggregation.mode}`,
      `Conflict policy: ${input.aggregation.conflictPolicy}`,
    ].filter(line => line !== '').join('\n');
  }

  private buildRetryFeedback(
    concerns: ExecutionVerificationConcern[],
  ): Array<{ subtaskId: string; feedback: string }> {
    const feedbackBySubtask = new Map<string, string[]>();
    for (const concern of concerns) {
      for (const subtaskId of concern.subtaskId.split(',')) {
        const trimmed = subtaskId.trim();
        if (!trimmed) {
          continue;
        }
        const feedback = feedbackBySubtask.get(trimmed) ?? [];
        feedback.push(`[${concern.criterionId}] ${concern.feedback}`);
        feedbackBySubtask.set(trimmed, feedback);
      }
    }

    return Array.from(feedbackBySubtask.entries()).map(([subtaskId, feedback]) => ({
      subtaskId,
      feedback: feedback.join('\n'),
    }));
  }
}
