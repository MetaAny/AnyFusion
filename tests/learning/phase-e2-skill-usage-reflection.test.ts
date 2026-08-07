import { describe, expect, it } from 'vitest';
import { SkillUsageCandidateBuilder } from '../../src/learning/skill-usage-candidate-builder.js';
import type { SkillUsageEventRecord } from '../../src/storage/skill-usage-event-repo.js';

describe('SkillUsageCandidateBuilder', () => {
  it('turns completed skill usage events into pending learning candidates', () => {
    const builder = new SkillUsageCandidateBuilder();
    const event: SkillUsageEventRecord = {
      id: 'sue_1',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_completed',
      message: 'TDD 流程完成且测试通过',
      payload: { tests: 'passed' },
      createdAt: '2026-04-27T01:00:00Z',
    };

    const result = builder.build(event);

    expect(result).toMatchObject({
      kind: 'skill',
      status: 'pending',
      sourceSkillUsageEventId: 'sue_1',
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
    });
    expect(result.title).toContain('test-driven-development');
    expect(result.content).toContain('TDD 流程完成且测试通过');
  });

  it('turns failed skill usage events into workflow learning candidates without auto promotion', () => {
    const builder = new SkillUsageCandidateBuilder();
    const event: SkillUsageEventRecord = {
      id: 'sue_2',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'debugging',
      skillVersion: null,
      eventType: 'skill_failed',
      message: '调试流程缺少日志采集步骤',
      payload: { missingSteps: ['读取完整错误'] },
      createdAt: '2026-04-27T01:05:00Z',
    };

    const result = builder.build(event);

    expect(result).toMatchObject({
      kind: 'workflow',
      status: 'pending',
      sourceTaskId: 'task_1',
    });
    expect(result.title).toContain('debugging');
    expect(result.content).toContain('调试流程缺少日志采集步骤');
  });
});
