import { nanoid } from 'nanoid';
import type { LearningCandidateKind, LearningCandidateRecord } from '../storage/learning-candidate-repo.js';
import type { SkillUsageEventRecord } from '../storage/skill-usage-event-repo.js';
import { SafetyScanner } from './safety-scanner.js';

export class SkillUsageCandidateBuilder {
  constructor(private readonly safetyScanner: SafetyScanner = new SafetyScanner()) {}

  build(input: SkillUsageEventRecord): LearningCandidateRecord {
    const kind = this.classify(input);
    const title = this.title(input, kind);
    const rawContent = [
      `Executor「${input.executorName}」使用 Skill「${input.skillName}」。`,
      `事件：${input.eventType}`,
      `结果：${input.message}`,
      `上下文：${JSON.stringify(input.payload)}`,
    ].join('\n');
    const safety = this.safetyScanner.scanCandidate({ title, content: rawContent });

    return {
      id: `lc_${nanoid(10)}`,
      kind,
      status: 'pending',
      title,
      content: safety.redactedContent,
      sourceSkillUsageEventId: input.id,
      sourceTaskId: input.taskId,
      safetyStatus: safety.status,
      safetyReasons: safety.reasons,
      reviewNote: null,
      promotedAssetId: kind === 'skill_patch' ? input.skillName : null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
  }

  private classify(input: SkillUsageEventRecord): LearningCandidateKind {
    if (input.eventType === 'skill_suggested_patch') return 'skill_patch';

    if (input.eventType === 'skill_failed') {
      const failureCount = typeof input.payload.failureCount === 'number' ? input.payload.failureCount : 1;
      return failureCount >= 2 ? 'antipattern' : 'workflow';
    }

    if (input.eventType === 'skill_completed' && Array.isArray(input.payload.verificationCommands)) {
      return 'verification_recipe';
    }

    return 'skill';
  }

  private title(input: SkillUsageEventRecord, kind: LearningCandidateKind): string {
    switch (kind) {
      case 'skill_patch':
        return `Skill Patch 候选：${input.skillName}`;
      case 'antipattern':
        return `Skill 反模式：${input.skillName}`;
      case 'verification_recipe':
        return `验收配方：${input.skillName}`;
      case 'workflow':
        return `Skill 失败经验：${input.skillName}`;
      default:
        return `Skill 使用经验：${input.skillName}`;
    }
  }
}
