import type { LearningCandidateRecord } from '../storage/learning-candidate-repo.js';
import type { SkillEffectSummaryRecord } from '../storage/skill-effect-summary-repo.js';

export type SkillGovernanceAction = 'disable' | 'deprecate' | 'none';

export interface SkillGovernanceAssessment {
  action: SkillGovernanceAction;
  riskLabel: 'healthy' | 'watch' | 'high';
  reason: string;
}

function successRate(summary: SkillEffectSummaryRecord): number {
  if (summary.usedCount === 0) return 0;
  return Math.round((summary.successCount / summary.usedCount) * 100);
}

export function skillAssetId(summary: Pick<SkillEffectSummaryRecord, 'executorName' | 'skillName' | 'skillVersion'>): string {
  return `${summary.executorName}/${summary.skillName}@${summary.skillVersion ?? 'unversioned'}`;
}

export function assessSkillGovernance(summary: SkillEffectSummaryRecord): SkillGovernanceAssessment {
  const rate = successRate(summary);
  if (summary.usedCount >= 4 && summary.failureCount >= 4 && rate === 0) {
    return { action: 'disable', riskLabel: 'high', reason: '连续失败且成功率为 0%' };
  }

  if (summary.usedCount >= 5 && rate <= 25 && summary.patchCandidateCount >= 2) {
    return { action: 'deprecate', riskLabel: 'high', reason: '成功率低且反复产生 patch 压力' };
  }

  if (summary.usedCount >= 3 && rate < 50) {
    return { action: 'none', riskLabel: 'watch', reason: '成功率偏低，继续观察' };
  }

  return { action: 'none', riskLabel: 'healthy', reason: '未达到治理阈值' };
}

function candidateKindFor(action: Exclude<SkillGovernanceAction, 'none'>): 'skill_disable' | 'skill_deprecation' {
  return action === 'disable' ? 'skill_disable' : 'skill_deprecation';
}

function titleFor(action: Exclude<SkillGovernanceAction, 'none'>, summary: SkillEffectSummaryRecord): string {
  return action === 'disable'
    ? `建议停用 Skill：${summary.skillName}`
    : `建议废弃 Skill：${summary.skillName}`;
}

function contentFor(action: Exclude<SkillGovernanceAction, 'none'>, summary: SkillEffectSummaryRecord, assessment: SkillGovernanceAssessment): string {
  return [
    'Skill Governance Candidate',
    `executor：${summary.executorName}`,
    `skill：${summary.skillName}`,
    `version：${summary.skillVersion ?? 'unversioned'}`,
    `使用次数：${summary.usedCount}`,
    `成功次数：${summary.successCount}`,
    `失败次数：${summary.failureCount}`,
    `成功率：${successRate(summary)}%`,
    `patch 候选次数：${summary.patchCandidateCount}`,
    `最近失败原因：${summary.lastFailureReason ?? '无'}`,
    `推荐动作：${action}`,
    `治理原因：${assessment.reason}`,
  ].join('\n');
}

export class SkillGovernanceEngine {
  review(summaries: SkillEffectSummaryRecord[]): LearningCandidateRecord[] {
    return summaries.flatMap(summary => {
      const assessment = assessSkillGovernance(summary);
      if (assessment.action === 'none') return [];
      const action = assessment.action;
      const now = new Date().toISOString();
      return [{
        id: `lc_govern_${Buffer.from(`${skillAssetId(summary)}:${action}`).toString('base64url').slice(0, 32)}`,
        kind: candidateKindFor(action),
        status: 'pending',
        title: titleFor(action, summary),
        content: contentFor(action, summary, assessment),
        sourceSkillUsageEventId: null,
        sourceTaskId: null,
        safetyStatus: 'passed',
        safetyReasons: [],
        reviewNote: null,
        promotedAssetId: skillAssetId(summary),
        createdAt: now,
        updatedAt: now,
      } satisfies LearningCandidateRecord];
    });
  }
}
