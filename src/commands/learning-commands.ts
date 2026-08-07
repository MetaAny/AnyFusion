import { LearningCandidateRepo, type LearningCandidateRecord } from '../storage/learning-candidate-repo.js';
import { ExecutorSkillInstallEventRepo, type ExecutorSkillInstallStatus } from '../storage/executor-skill-install-event-repo.js';
import { TaskMemoryCardRepo, type TaskMemoryCardOutcome } from '../storage/task-memory-card-repo.js';
import { SkillEffectSummaryRepo, type SkillEffectSummaryRecord } from '../storage/skill-effect-summary-repo.js';
import { SkillUsageEventRepo } from '../storage/skill-usage-event-repo.js';
import { SkillUsageCandidateBuilder } from '../learning/skill-usage-candidate-builder.js';
import { PromotionGate } from '../learning/promotion-gate.js';
import { buildExecutorSkillPackage } from '../executor/skill-package-builder.js';
import { SkillGovernanceEngine, assessSkillGovernance, type SkillGovernanceAction } from '../learning/skill-governance-engine.js';
import { LearningWeeklyReviewBuilder } from '../learning/learning-weekly-review-builder.js';
import { generateInteractionId } from '../utils/id.js';
import {
  stringArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

const SKILL_AUDIT_EXECUTOR_NAME = 'sandboxed';

function formatCandidateLine(candidate: ReturnType<LearningCandidateRepo['listPending']>[number]): string {
  return `  #${candidate.id} [${candidate.kind}/${candidate.safetyStatus}] ${candidate.title}`;
}

function createInstallAuditId(): string {
  return `install_${generateInteractionId().replace(/^int_/, '')}`;
}

function createTaskMemoryCardId(): string {
  return `tmc_${generateInteractionId().replace(/^int_/, '')}`;
}

function extractList(content: string, label: string): string[] {
  const line = content.split('\n').find(item => item.startsWith(`${label}：`) || item.startsWith(`${label}:`));
  if (!line) return [];
  return line
    .replace(new RegExp(`^${label}[：:]\\s*`), '')
    .split(/[;,，、]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function extractField(content: string, label: string, fallback = ''): string {
  const line = content.split('\n').find(item => item.startsWith(`${label}：`) || item.startsWith(`${label}:`));
  return line ? line.replace(new RegExp(`^${label}[：:]\\s*`), '').trim() : fallback;
}

function normalizeOutcome(value: string): TaskMemoryCardOutcome {
  if (value === 'failed' || value === 'partial' || value === 'blocked') return value;
  return 'success';
}

function buildTaskMemoryCard(candidate: LearningCandidateRecord) {
  const now = new Date().toISOString();
  return {
    id: createTaskMemoryCardId(),
    taskId: candidate.sourceTaskId ?? candidate.id,
    title: candidate.title,
    goal: extractField(candidate.content, '目标', candidate.title),
    summary: extractField(candidate.content, '摘要', candidate.content.slice(0, 500)),
    keyDecisions: extractList(candidate.content, '关键决策'),
    changedFiles: extractList(candidate.content, '修改文件'),
    verificationCommands: extractList(candidate.content, '验证命令'),
    pitfalls: extractList(candidate.content, '坑点'),
    artifacts: extractList(candidate.content, '产物'),
    outcome: normalizeOutcome(extractField(candidate.content, '结果', 'success')),
    sourceCandidateId: candidate.id,
    createdAt: now,
    updatedAt: now,
  };
}

function formatSkillSummary(summary: SkillEffectSummaryRecord): string {
  const version = summary.skillVersion ?? 'unversioned';
  const successRate = summary.usedCount === 0 ? 0 : Math.round((summary.successCount / summary.usedCount) * 100);
  const governance = assessSkillGovernance(summary);
  const risk = governance.riskLabel === 'high'
    ? ` [高风险/${governance.action === 'disable' ? '建议停用' : '建议废弃'}]`
    : governance.riskLabel === 'watch'
      ? ' [观察]'
      : '';
  return `  ${summary.skillName}@${version} executor=${summary.executorName} 使用 ${summary.usedCount} 次，成功率 ${successRate}%，失败 ${summary.failureCount}，patch ${summary.patchCandidateCount}${risk}`;
}

function governanceActionForCandidate(candidate: LearningCandidateRecord): Exclude<SkillGovernanceAction, 'none'> | null {
  if (candidate.kind === 'skill_disable') return 'disable';
  if (candidate.kind === 'skill_deprecation') return 'deprecate';
  return null;
}

function formatTaskMemoryCardLine(card: ReturnType<TaskMemoryCardRepo['listRecent']>[number]): string {
  return `  #${card.id} [${card.outcome}] ${card.title} (${card.taskId})`;
}

function formatPatchCandidateLine(candidate: LearningCandidateRecord): string {
  return `  #${candidate.id} [${candidate.status}/${candidate.safetyStatus}] ${candidate.title}`;
}

function writeInstallAudit(
  repo: ExecutorSkillInstallEventRepo,
  input: {
    candidateId: string;
    packageId: string | null;
    executorName: string;
    action: 'install' | 'update' | 'disable' | 'deprecate';
    status: ExecutorSkillInstallStatus;
    message: string;
  },
): void {
  repo.create({
    id: createInstallAuditId(),
    candidateId: input.candidateId,
    packageId: input.packageId,
    executorName: input.executorName,
    action: input.action,
    status: input.status,
    message: input.message,
    createdAt: new Date().toISOString(),
  });
}

export async function generateSkillFeedback(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const repo = new LearningCandidateRepo(context.db);
  const usageEvents = new SkillUsageEventRepo(context.db).listRecent(50);
  const builder = new SkillUsageCandidateBuilder();
  let created = 0;

  for (const event of usageEvents) {
    if (!['skill_failed', 'skill_suggested_patch'].includes(event.eventType)) {
      continue;
    }

    if (repo.existsForSkillUsageEvent(event.id)) continue;
    repo.insert(builder.build(event));
    created += 1;
  }

  return { type: 'text', content: `已生成 Skill Runtime Feedback：${created} 个候选` };
}

export async function listPatchCandidates(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const candidates = new LearningCandidateRepo(context.db)
    .listPending()
    .filter(candidate => candidate.kind === 'skill_patch');
  if (candidates.length === 0) {
    return { type: 'text', content: '暂无 Skill Patch Candidates' };
  }
  return {
    type: 'text',
    content: `Skill Patch Candidates：\n${candidates.map(formatPatchCandidateLine).join('\n')}`,
  };
}

export async function approvePatchCandidate(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const id = stringArg(args, 'candidateId');
  if (!id) {
    return { type: 'text', content: '用法: /learning patch approve <candidateId> [note...]' };
  }
  const repo = new LearningCandidateRepo(context.db);
  const candidate = repo.findById(id);
  if (!candidate || candidate.kind !== 'skill_patch') {
    return { type: 'text', content: `未找到 Skill Patch Candidate #${id}` };
  }
  repo.updateReview(id, {
    status: 'approved',
    reviewNote: stringArg(args, 'note') || null,
    promotedAssetId: candidate.promotedAssetId,
    updatedAt: new Date().toISOString(),
  });
  return { type: 'text', content: `已批准 Skill Patch Candidate #${id}` };
}

export async function listLearningCandidates(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const candidates = new LearningCandidateRepo(context.db).listPending();
  if (candidates.length === 0) {
    return { type: 'text', content: '暂无待审核学习候选' };
  }
  return {
    type: 'text',
    content: `待审核学习候选：\n${candidates.map(formatCandidateLine).join('\n')}`,
  };
}

export async function approveLearningCandidate(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const id = stringArg(args, 'candidateId');
  if (!id) {
    return { type: 'text', content: '用法: /learning approve <candidateId> [note...]' };
  }
  const repo = new LearningCandidateRepo(context.db);
  if (!repo.findById(id)) {
    return { type: 'text', content: `未找到学习候选 #${id}` };
  }
  repo.updateReview(id, {
    status: 'approved',
    reviewNote: stringArg(args, 'note') || null,
    updatedAt: new Date().toISOString(),
  });
  return { type: 'text', content: `已批准学习候选 #${id}` };
}

export async function rejectLearningCandidate(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const id = stringArg(args, 'candidateId');
  if (!id) {
    return { type: 'text', content: '用法: /learning reject <candidateId> [reason...]' };
  }
  const repo = new LearningCandidateRepo(context.db);
  if (!repo.findById(id)) {
    return { type: 'text', content: `未找到学习候选 #${id}` };
  }
  repo.updateReview(id, {
    status: 'rejected',
    reviewNote: stringArg(args, 'reason') || null,
    updatedAt: new Date().toISOString(),
  });
  return { type: 'text', content: `已拒绝学习候选 #${id}` };
}

export async function promoteLearningCandidate(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const id = stringArg(args, 'candidateId');
  if (!id) {
    return { type: 'text', content: '用法: /learning promote <candidateId>' };
  }

  const repo = new LearningCandidateRepo(context.db);
  const candidate = repo.findById(id);
  if (!candidate) {
    return { type: 'text', content: `未找到学习候选 #${id}` };
  }

  const gate = new PromotionGate().evaluate({
    kind: candidate.kind,
    status: candidate.status,
    safetyStatus: candidate.safetyStatus,
  });
  if (gate.decision !== 'promote') {
    if (candidate.kind === 'skill' || candidate.kind === 'skill_patch') {
      writeInstallAudit(new ExecutorSkillInstallEventRepo(context.db), {
        candidateId: candidate.id,
        packageId: null,
        executorName: SKILL_AUDIT_EXECUTOR_NAME,
        action: candidate.kind === 'skill_patch' ? 'update' : 'install',
        status: 'blocked',
        message: gate.reason,
      });
    }
    return { type: 'text', content: `学习候选 #${id} 不能 promotion：${gate.reason}` };
  }

  if (candidate.kind === 'task_memory_card') {
    const card = buildTaskMemoryCard(candidate);
    new TaskMemoryCardRepo(context.db).insert(card);
    repo.updateReview(candidate.id, {
      status: 'promoted',
      reviewNote: candidate.reviewNote,
      promotedAssetId: card.id,
      updatedAt: new Date().toISOString(),
    });
    return { type: 'text', content: `已沉淀任务记忆卡：${card.title}` };
  }

  const auditRepo = new ExecutorSkillInstallEventRepo(context.db);
  const governanceAction = governanceActionForCandidate(candidate);
  if (governanceAction) {
    const actionLabel = governanceAction === 'disable' ? '停用' : '废弃';
    writeInstallAudit(auditRepo, {
      candidateId: candidate.id,
      packageId: candidate.promotedAssetId,
      executorName: SKILL_AUDIT_EXECUTOR_NAME,
      action: governanceAction,
      status: 'unsupported',
      message: `当前 executor 不支持 skill ${governanceAction}`,
    });
    return { type: 'text', content: `当前 executor 不支持 Skill ${actionLabel}；已记录 audit。` };
  }

  let pkg;
  try {
    pkg = buildExecutorSkillPackage(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeInstallAudit(auditRepo, {
      candidateId: candidate.id,
      packageId: null,
      executorName: SKILL_AUDIT_EXECUTOR_NAME,
      action: candidate.kind === 'skill_patch' ? 'update' : 'install',
      status: 'blocked',
      message,
    });
    return { type: 'text', content: `学习候选 #${id} 不能 promotion：${message}` };
  }

  const installAction = candidate.kind === 'skill_patch' ? 'update' : 'install';
  writeInstallAudit(auditRepo, {
    candidateId: candidate.id,
    packageId: pkg.id,
    executorName: SKILL_AUDIT_EXECUTOR_NAME,
    action: installAction,
    status: 'unsupported',
    message: installAction === 'update'
      ? '当前 executor 不支持 skill update'
      : '当前 executor 不支持 skill install',
  });
  return {
    type: 'text',
    content: installAction === 'update'
      ? '当前 executor 不支持 Skill 更新；已记录 audit。'
      : '当前 executor 不支持 Skill 安装；已记录 audit。',
  };
}

export async function listTaskMemoryCards(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const cards = new TaskMemoryCardRepo(context.db).listRecent(10);
  if (cards.length === 0) {
    return { type: 'text', content: '暂无任务记忆卡' };
  }
  return { type: 'text', content: `任务记忆卡：\n${cards.map(formatTaskMemoryCardLine).join('\n')}` };
}

export async function listSkillEffects(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const summaries = new SkillEffectSummaryRepo(context.db).listTop(10);
  if (summaries.length === 0) {
    return { type: 'text', content: '暂无 Skill Effect Summary' };
  }
  return { type: 'text', content: `Skill Effect Summary：\n${summaries.map(formatSkillSummary).join('\n')}` };
}

export async function buildLearningWeeklyReview(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const review = new LearningWeeklyReviewBuilder(context.db).build();
  return {
    type: 'text',
    content: review.markdown,
    payload: {
      weeklyReview: {
        pendingCandidateCount: review.pendingCandidateCount,
        taskMemoryCardCount: review.taskMemoryCardCount,
        governanceRecommendationCount: review.governanceRecommendationCount,
      },
    },
  };
}

export async function showLearningSummary(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const pendingCount = new LearningCandidateRepo(context.db).listPending().length;
  const cards = new TaskMemoryCardRepo(context.db).listRecent(5);
  const summaries = new SkillEffectSummaryRepo(context.db).listTop(5);
  const governanceCandidates = new SkillGovernanceEngine().review(summaries);
  const lines = [
    '学习资产概览：',
    `待审核候选 ${pendingCount}`,
    `任务记忆卡 ${cards.length}`,
    `Skill Summary ${summaries.length}`,
    `建议治理的 Skill ${governanceCandidates.length}`,
  ];
  if (cards.length > 0) {
    lines.push('最近任务记忆卡：', ...cards.map(formatTaskMemoryCardLine));
  }
  if (summaries.length > 0) {
    lines.push('Skill 效果：', ...summaries.map(formatSkillSummary));
  }
  return { type: 'text', content: lines.join('\n') };
}
