import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import type { Config } from '../../src/core/types.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { LearningCandidateRepo } from '../../src/storage/learning-candidate-repo.js';
import { FakeAttemptSandbox } from '../support/fake-attempt-sandbox.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('Learning candidate session review UX', () => {
  it('reviews learning candidates through the default session command router', async () => {
    const db = createTestDb();
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const attemptSandbox = new FakeAttemptSandbox();
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_learning_review',
    });
    const repo = new LearningCandidateRepo(db);
    repo.insert({
      id: 'lc_session_1',
      kind: 'skill',
      status: 'pending',
      title: '复用飞书回复截断调试流程',
      content: '定位发送层限制并验证 chunking。',
      sourceSkillUsageEventId: null,
      sourceTaskId: 'task_1',
      safetyStatus: 'passed',
      safetyReasons: [],
      reviewNote: null,
      promotedAssetId: null,
      createdAt: '2026-04-27T00:00:00Z',
      updatedAt: '2026-04-27T00:00:00Z',
    });

    session.initialize();
    await session.submit('/learning candidates', { awaitAsyncWork: true });
    await session.submit('/learning approve lc_session_1 可以沉淀', { awaitAsyncWork: true });

    const snapshot = session.getSnapshot().output.join('\n');
    expect(snapshot).toContain('待审核学习候选');
    expect(snapshot).toContain('复用飞书回复截断调试流程');
    expect(snapshot).toContain('已批准学习候选 #lc_session_1');
    expect(repo.findById('lc_session_1')?.status).toBe('approved');
    expect(attemptSandbox.create).not.toHaveBeenCalled();
  });
});
