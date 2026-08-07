import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SkillUsageEventRepo } from '../../src/storage/skill-usage-event-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('Phase E2 skill usage event storage', () => {
  it('persists terminal events and updates their effect summary atomically', () => {
    const db = createTestDb();
    const repo = new SkillUsageEventRepo(db);

    repo.insert({
      id: 'sue_1',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_completed',
      message: 'TDD 执行完成',
      payload: { helpful: true },
      createdAt: '2026-04-27T01:00:00Z',
    });

    expect(repo.listRecent()).toEqual([expect.objectContaining({
      id: 'sue_1',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'test-driven-development',
      skillVersion: '1.1.0',
      eventType: 'skill_completed',
      message: 'TDD 执行完成',
      payload: { helpful: true },
    })]);
    expect(db.prepare(`
      SELECT used_count, success_count, helpful_count FROM skill_effect_summaries
    `).get()).toEqual({ used_count: 1, success_count: 1, helpful_count: 1 });
  });

  it('does not persist non-terminal events', () => {
    const db = createTestDb();
    const repo = new SkillUsageEventRepo(db);

    repo.insert({
      id: 'sue_2',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'debugging',
      skillVersion: null,
      eventType: 'skill_progress',
      message: 'token=sk-abc123 已读取配置',
      payload: { apiKey: 'sk-secret-value', nested: { password: 'plain-text' } },
      createdAt: '2026-04-27T01:01:00Z',
    });

    expect(repo.listRecent()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM skill_effect_summaries').get())
      .toEqual({ count: 0 });
  });

  it('redacts terminal failure details before both event and summary persistence', () => {
    const db = createTestDb();
    const repo = new SkillUsageEventRepo(db);

    repo.insert({
      id: 'sue_3',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'debugging',
      skillVersion: null,
      eventType: 'skill_failed',
      message: 'token=sk-abc123 caused failure',
      payload: { apiKey: 'sk-secret-value' },
      createdAt: '2026-04-27T01:02:00Z',
    });

    const [event] = repo.listRecent();
    expect(event.message).toContain('[REDACTED]');
    expect(JSON.stringify(event.payload)).not.toContain('sk-secret-value');
    expect(db.prepare('SELECT last_failure_reason FROM skill_effect_summaries').get())
      .toEqual({ last_failure_reason: 'token=[REDACTED] caused failure' });
  });

  it('rolls back the terminal detail when its summary update fails', () => {
    const db = createTestDb();
    const repo = new SkillUsageEventRepo(db);
    db.exec(`
      CREATE TRIGGER reject_skill_summary
      BEFORE INSERT ON skill_effect_summaries BEGIN
        SELECT RAISE(ABORT, 'summary rejected');
      END;
    `);

    expect(() => repo.insert({
      id: 'sue_atomic',
      taskId: 'task_1',
      executionId: 'exec_1',
      executorName: 'codex-cli',
      skillName: 'debugging',
      skillVersion: null,
      eventType: 'skill_failed',
      message: 'failed',
      payload: {},
      createdAt: '2026-04-27T01:03:00Z',
    })).toThrow('summary rejected');
    expect(db.prepare('SELECT COUNT(*) AS count FROM executor_skill_usage_events').get())
      .toEqual({ count: 0 });
  });
});
