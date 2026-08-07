import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import type { GuidanceProposal } from '../../src/core/types.js';

describe('V2 schema', () => {
  it('does not create retired event tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tableNames = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[])
      .map(row => row.name);

    expect(tableNames).not.toEqual(expect.arrayContaining([
      'guidance_events',
      'reflection_events',
      'executor_route_events',
    ]));
  });
});

describe('V2 core types', () => {
  it('supports proposal shapes', () => {
    const proposal: GuidanceProposal = {
      id: 'guid_1',
      trigger: 'startup',
      taskId: 'task_1',
      actionType: 'resume_task',
      recommendedAction: '恢复任务 #task_1',
      reasons: ['材料已齐', '上次下一步明确'],
      confidence: 0.92,
      requiresConfirmation: true,
      proposalPayload: { taskId: 'task_1' },
      expiresAt: '2026-04-20T01:00:00Z',
      createdAt: '2026-04-20T00:00:00Z',
    };

    expect(proposal.actionType).toBe('resume_task');
  });
});
