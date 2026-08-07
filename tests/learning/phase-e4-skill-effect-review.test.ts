import { describe, expect, it } from 'vitest';
import { SkillUsageCandidateBuilder } from '../../src/learning/skill-usage-candidate-builder.js';
import type { SkillUsageEventRecord } from '../../src/storage/skill-usage-event-repo.js';

function skillEvent(overrides: Partial<SkillUsageEventRecord> = {}): SkillUsageEventRecord {
  return {
    id: 'sue_e4_1',
    taskId: 'task_e4',
    executionId: 'exec_e4',
    executorName: 'codex-cli',
    skillName: 'systematic-debugging',
    skillVersion: '1.1.0',
    eventType: 'skill_suggested_patch',
    message: 'Skill 缺少“先读取完整错误再修复”的步骤，建议补充到 Pitfalls。',
    payload: {
      suggestedPatch: '新增步骤：遇到测试失败时先运行 targeted test 并读取完整错误，再修改代码。',
      targetSkill: 'systematic-debugging',
    },
    createdAt: '2026-04-27T02:00:00.000Z',
    ...overrides,
  };
}

describe('SkillUsageCandidateBuilder skill effect review', () => {
  it('turns skill_suggested_patch events into skill_patch candidates for review', () => {
    const result = new SkillUsageCandidateBuilder().build(skillEvent());

    expect(result).toMatchObject({
      kind: 'skill_patch',
      status: 'pending',
      sourceSkillUsageEventId: 'sue_e4_1',
      sourceTaskId: 'task_e4',
      safetyStatus: 'passed',
    });
    expect(result.title).toContain('systematic-debugging');
    expect(result.content).toContain('suggestedPatch');
    expect(result.content).toContain('先运行 targeted test');
  });

  it('turns repeated skill failures with missing steps into antipattern candidates', () => {
    const result = new SkillUsageCandidateBuilder().build(skillEvent({
      id: 'sue_e4_2',
      eventType: 'skill_failed',
      message: '连续失败：跳过 RED 阶段导致后续返工',
      payload: {
        failureCount: 3,
        missingSteps: ['没有先写失败测试', '没有确认 RED'],
      },
    }));

    expect(result).toMatchObject({
      kind: 'antipattern',
      status: 'pending',
      sourceTaskId: 'task_e4',
    });
    expect(result.title).toContain('systematic-debugging');
    expect(result.content).toContain('跳过 RED 阶段');
    expect(result.content).toContain('failureCount');
  });

  it('turns successful verification payloads into verification_recipe candidates', () => {
    const result = new SkillUsageCandidateBuilder().build(skillEvent({
      id: 'sue_e4_3',
      eventType: 'skill_completed',
      skillName: 'metaclaw-verification',
      message: 'targeted regression、lint、build、full test 全部通过',
      payload: {
        verificationCommands: [
          'npm test -- tests/core/phase-e2-skill-usage-reflection.test.ts',
          'npm run lint',
          'npm run build',
        ],
      },
    }));

    expect(result).toMatchObject({
      kind: 'verification_recipe',
      status: 'pending',
      sourceTaskId: 'task_e4',
    });
    expect(result.content).toContain('verificationCommands');
    expect(result.content).toContain('npm run build');
  });
});
