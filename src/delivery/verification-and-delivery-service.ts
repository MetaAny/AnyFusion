import { existsSync } from 'fs';
import type { ExecutionMode, ResolvedPreference, Task, TaskRecoveryTrigger, WorkspaceContext } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import {
  ExecutionAggregator,
  type AcceptanceCriterion,
  type ExecutionAggregationInput,
} from '../execution/execution-aggregator.js';

export interface VerificationInput {
  output: string;
  evidenceText?: string[];
  artifactPaths: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  aggregationVerification?: ExecutionAggregationInput;
}

export interface VerificationResult {
  status: 'pass' | 'blocked';
  reason: string | null;
}

export interface Verifier {
  verify(input: VerificationInput): VerificationResult | Promise<VerificationResult>;
}

export interface DeliveryPreparationInput {
  output: string;
  durationMs: number;
  userPrompt: string;
  workspaceContext?: WorkspaceContext;
  preferences: ResolvedPreference[];
  nextStep: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  evidenceText?: string[];
  aggregationVerification?: ExecutionAggregationInput;
}

export interface DeliveryPreparationResult {
  verification: VerificationResult;
  artifactPaths: string[];
  summary: string;
  completionLines: string[];
}

export interface TaskCompletionDeliveryInput {
  taskId: string;
  title: string;
  summary: string;
  output: string;
  artifactPaths: string[];
  durationMs: number;
  executionMode: ExecutionMode;
  origin: 'user' | 'system';
  recoveryTrigger?: TaskRecoveryTrigger;
}

export class HeuristicVerifier implements Verifier {
  verify(input: VerificationInput): VerificationResult {
    if (!isUndeliverableExecutorOutput(input.output)) {
      return { status: 'pass', reason: null };
    }

    return {
      status: 'blocked',
      reason: '执行器返回未完成说明，未生成最终产物',
    };
  }
}

export class TestEvidenceVerifier implements Verifier {
  verify(input: VerificationInput): VerificationResult {
    const requiresTestEvidence = input.acceptanceCriteria.some(criterion =>
      criterion.severity === 'must'
      && (
        criterion.id === 'repo_execution_verified'
        || criterion.requiredEvidence.some(evidence => /测试|test/i.test(evidence))
      ),
    );
    if (!requiresTestEvidence) {
      return { status: 'pass', reason: null };
    }

    const evidenceText = [input.output, ...(input.evidenceText ?? [])].join('\n');
    if (/(npm test|npm run test|npm run lint|npx vitest|pnpm test|yarn test|pytest|go test|cargo test|测试通过|测试完成|tests?["']?\s*:\s*["']?passed|未运行测试|没有运行测试|not run tests|tests? not run)/i.test(evidenceText)) {
      return { status: 'pass', reason: null };
    }

    return {
      status: 'blocked',
      reason: '缺少仓库修改任务的测试证据或未测试说明',
    };
  }
}

export class ArtifactVerifier implements Verifier {
  verify(input: VerificationInput): VerificationResult {
    const requiresArtifact = input.acceptanceCriteria.some(criterion =>
      criterion.severity === 'must'
      && (
        /(^|_)(artifact|file|document|report)(_|$)|产物文件|报告文件|文档文件/i.test(criterion.id)
        || criterion.requiredEvidence.some(evidence => /artifact path|file path|document path|report path|产物路径|文件路径|报告路径|文档路径/i.test(evidence))
      ),
    );
    if (!requiresArtifact) {
      return { status: 'pass', reason: null };
    }

    if (input.artifactPaths.some(path => existsSync(path))) {
      return { status: 'pass', reason: null };
    }

    const allowsInlineFinalContent = input.acceptanceCriteria.some(criterion =>
      criterion.severity === 'must'
      && criterion.requiredEvidence.some(evidence => /最终内容|完整最终内容|final content/i.test(evidence))
    );
    if (allowsInlineFinalContent && input.output.trim() && !isUndeliverableExecutorOutput(input.output)) {
      return { status: 'pass', reason: null };
    }

    return {
      status: 'blocked',
      reason: '缺少可访问的任务产物文件',
    };
  }
}

export class AggregationVerifier implements Verifier {
  constructor(private readonly aggregator = new ExecutionAggregator()) {}

  verify(input: VerificationInput): VerificationResult {
    if (!input.aggregationVerification) {
      return { status: 'pass', reason: null };
    }

    const aggregation = this.aggregator.aggregate(input.aggregationVerification);
    const hardConcern = aggregation.concerns.find(concern => concern.severity === 'error');
    if (!hardConcern) {
      return { status: 'pass', reason: null };
    }

    return {
      status: 'blocked',
      reason: `multi-executor aggregation verification failed: ${hardConcern.message}`,
    };
  }
}

export class LlmVerifier implements Verifier {
  constructor(private readonly verifyWithLlm: (input: VerificationInput) => Promise<VerificationResult>) {}

  verify(input: VerificationInput): Promise<VerificationResult> {
    return this.verifyWithLlm(input);
  }
}

export class VerificationAndDeliveryService {
  private readonly verifiers: Verifier[];

  constructor(verifierOrPipeline: Verifier | Verifier[] = [
    new HeuristicVerifier(),
    new AggregationVerifier(),
    new TestEvidenceVerifier(),
    new ArtifactVerifier(),
  ]) {
    this.verifiers = Array.isArray(verifierOrPipeline) ? verifierOrPipeline : [verifierOrPipeline];
  }

  prepare(input: DeliveryPreparationInput): DeliveryPreparationResult {
    const artifactPaths = this.collectArtifactPaths(input.output, input.workspaceContext?.targetPaths ?? []);
    const verification = this.verifySync({
      output: input.output,
      evidenceText: input.evidenceText,
      artifactPaths,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      aggregationVerification: input.aggregationVerification,
    });
    const deliverableArtifactPaths = verification.status === 'pass' ? artifactPaths : [];
    const summary = verification.status === 'pass'
      ? this.buildTaskResultSummary(input.output, deliverableArtifactPaths, input.workspaceContext)
      : '';

    return {
      verification,
      artifactPaths: deliverableArtifactPaths,
      summary,
      completionLines: verification.status === 'pass'
        ? this.buildCompletionLines({
            output: input.output,
            durationMs: input.durationMs,
            workspaceContext: input.workspaceContext,
            artifactPaths: deliverableArtifactPaths,
            summary,
            nextStep: input.nextStep,
          })
        : [],
    };
  }

  async prepareAsync(input: DeliveryPreparationInput): Promise<DeliveryPreparationResult> {
    const collectedArtifactPaths = this.collectArtifactPaths(input.output, input.workspaceContext?.targetPaths ?? []);
    const verification = await this.verify({
      output: input.output,
      evidenceText: input.evidenceText,
      artifactPaths: collectedArtifactPaths,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      aggregationVerification: input.aggregationVerification,
    });
    const artifactPaths = verification.status === 'pass' ? collectedArtifactPaths : [];
    const summary = verification.status === 'pass'
      ? this.buildTaskResultSummary(input.output, artifactPaths, input.workspaceContext)
      : '';

    return {
      verification,
      artifactPaths,
      summary,
      completionLines: verification.status === 'pass'
        ? this.buildCompletionLines({
            output: input.output,
            durationMs: input.durationMs,
            workspaceContext: input.workspaceContext,
            artifactPaths,
            summary,
            nextStep: input.nextStep,
          })
        : [],
    };
  }

  private verifySync(input: VerificationInput): VerificationResult {
    for (const verifier of this.verifiers) {
      const result = verifier.verify(input);
      if (result instanceof Promise) {
        throw new Error('异步 verifier 需要调用 prepareAsync()');
      }
      if (result.status !== 'pass') {
        return result;
      }
    }
    return { status: 'pass', reason: null };
  }

  private async verify(input: VerificationInput): Promise<VerificationResult> {
    for (const verifier of this.verifiers) {
      const result = await verifier.verify(input);
      if (result.status !== 'pass') {
        return result;
      }
    }
    return { status: 'pass', reason: null };
  }

  formatCompletion(input: {
    output: string;
    durationMs: number;
    workspaceContext?: WorkspaceContext;
    artifactPaths: string[];
    summary: string;
    nextStep: string;
  }): string[] {
    return this.buildCompletionLines(input);
  }

  async deliverTaskCompletion(
    notifier: NotificationService,
    input: TaskCompletionDeliveryInput,
  ): Promise<string | null> {
    if (input.executionMode !== 'resume-blocked') {
      return null;
    }

    try {
      await notifier.notifyTaskCompleted(input);
      return null;
    } catch (error) {
      return `⚠️ 任务完成通知失败: ${(error as Error).message}`;
    }
  }

  appendBlockedRecoveryCompletionBlock(
    lines: string[],
    input: {
      task: Task;
      summary: string;
      output: string;
      recoveryTrigger?: TaskRecoveryTrigger;
    },
  ): void {
    const recoveryTrigger = input.recoveryTrigger;
    lines.push(
      '✓ 旧阻塞任务已完成',
      '',
      '这是针对旧任务的答案：',
      `任务：#${input.task.id} ${input.task.title}`,
      `触发方式：${this.formatRecoveryTriggerForInline(recoveryTrigger)}`,
      `原阻塞原因：${recoveryTrigger?.blockedReason || this.getWaitingBlockReason(input.task) || '未知原因'}`,
    );

    if (recoveryTrigger?.triggerReason) {
      lines.push(`恢复原因：${recoveryTrigger.triggerReason}`);
    }

    if (recoveryTrigger?.sourceInputExcerpt) {
      lines.push(`触发输入：${recoveryTrigger.sourceInputExcerpt}`);
    }

    if (recoveryTrigger?.newlyProvidedResources && recoveryTrigger.newlyProvidedResources.length > 0) {
      lines.push(`补充材料：${recoveryTrigger.newlyProvidedResources.join('、')}`);
    }

    lines.push('', `答案摘要：${input.summary || firstNonEmptyLine(input.output) || '任务已完成'}`, '');
  }

  private collectArtifactPaths(output: string, targetPaths: string[]): string[] {
    if (targetPaths.length === 0 || !output.trim()) {
      return [];
    }

    const matches = output.match(/\/[^\s`"'，。,；;：！？（）()<>\]]+/g) ?? [];
    const normalized = matches
      .map(path => path.replace(/[.,;:!?）)\]]+$/u, ''))
      .filter(path => targetPaths.some(targetPath => path.startsWith(targetPath)))
      .filter(path => existsSync(path));

    return Array.from(new Set(normalized));
  }

  private buildTaskResultSummary(
    output: string,
    artifactPaths: string[],
    workspaceContext?: WorkspaceContext,
  ): string {
    if (!workspaceContext?.allowFilesystem) {
      return output.slice(0, 200) || '无';
    }

    const conciseSummary = extractConciseExecutorSummary(output, artifactPaths);
    if (conciseSummary) {
      return conciseSummary;
    }

    if (artifactPaths.length > 0) {
      if (artifactPaths.length === 1) {
        return `已写入任务文件：${artifactPaths[0]}`;
      }
      return `已写入 ${artifactPaths.length} 个任务文件到 ${workspaceContext.targetPaths[0]}`;
    }

    return `已完成文件写入任务，目标目录：${workspaceContext.targetPaths[0]}`;
  }

  private buildCompletionLines(input: {
    output: string;
    durationMs: number;
    workspaceContext?: WorkspaceContext;
    artifactPaths: string[];
    summary: string;
    nextStep: string;
  }): string[] {
    const completionSummary = input.summary
      && input.output.includes(input.summary)
      ? '任务已完成，详见上方 Executor 最终结果'
      : input.summary;
    const lines = [
      `✓ 任务完成 (${(input.durationMs / 1000).toFixed(1)}s)`,
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      `│ 摘要: ${completionSummary || '无'}`,
      `│ 下一步: ${input.nextStep}`,
      '└──────────────────────────────────────────────────┘',
    ];

    if (input.workspaceContext?.allowFilesystem) {
      lines.push(
        '',
        `→ 文件输出目录: ${input.workspaceContext.targetPaths[0]}`,
        '→ 已省略文件正文输出，请直接查看生成文件',
      );
    }

    if (input.artifactPaths.length > 0) {
      lines.push(
        '',
        `→ 已记录 ${input.artifactPaths.length} 个任务产物`,
        ...input.artifactPaths.map(path => `   - ${path}`),
      );
    }

    return lines;
  }

  private formatRecoveryTriggerForInline(trigger: TaskRecoveryTrigger | undefined): string {
    if (!trigger) {
      return '阻塞解除后恢复';
    }

    if (trigger.kind === 'timer-recheck') return '后台定时检查恢复';
    if (trigger.kind === 'user-query-unblocked') return '你刚才的补充信息解除阻塞';
    if (trigger.kind === 'natural-language-resume') return '你刚才用自然语言要求继续旧阻塞任务';
    if (trigger.kind === 'explicit-task-command') return '你刚才显式解除/继续旧阻塞任务';
    if (trigger.kind === 'proposal') return '你接受了恢复旧阻塞任务的建议';
    return '阻塞解除后恢复';
  }

  private getWaitingBlockReason(task: Task): string | null {
    return task.dependencies.find(dependency => dependency.status === 'waiting')?.description ?? null;
  }
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) ?? null;
}

export function isUndeliverableExecutorOutput(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) {
    return false;
  }

  return /Timeout\s+—\s+denying command/i.test(normalized)
    || /denying command/i.test(normalized)
    || /停止当前\s*workflow|等待用户响应|需要你允许后/u.test(normalized)
    || /还没有生成最终\s*Markdown\s*文件|尚未写入|没有生成最终\s*Markdown/u.test(normalized)
    || /未完成项：[\s\S]{0,300}(详细报告|Markdown|文件).*尚未写入/u.test(normalized);
}

export function extractConciseExecutorSummary(output: string, artifactPaths: string[]): string | null {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^```/.test(line)) {
      continue;
    }
    if (/(<!DOCTYPE|<html|<body|<head|<script|<style)/i.test(line)) {
      continue;
    }

    let normalized = line;
    for (const artifactPath of artifactPaths) {
      normalized = normalized.replace(artifactPath, '').trim();
    }
    normalized = normalized
      .replace(/`{1,3}\s*`{1,3}/g, '')
      .replace(/["“”'‘’]\s*["“”'‘’]/g, '')
      .trim();
    normalized = normalized.replace(/[：:，,\-]+$/u, '').trim();

    if (!normalized) {
      continue;
    }
    if (/^(已创建文件|已保存文件|文件已创建|保存路径|路径)$/u.test(normalized)) {
      continue;
    }
    if (/<[a-z][^>]*>/i.test(normalized)) {
      continue;
    }

    return normalized.slice(0, 200);
  }

  return null;
}
