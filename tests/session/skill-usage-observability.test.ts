import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
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
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

describe('Session skill usage observability', () => {
  it('does not misclassify sandbox lifecycle output as SkillUsageEvents or expose it to users', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '完成' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_skill_usage',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '用 TDD 实现一个小功能' }),
      ),
    });

    await session.submit('用 TDD 实现一个小功能', { awaitAsyncWork: true });

    const taskId = taskRepo.findByStatus('done')[0].id;
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM executor_skill_usage_events WHERE task_id = ?
    `).get(taskId)).toEqual({ count: 0 });
    expect(attemptSandbox.create).toHaveBeenCalledTimes(1);

    const output = session.getSnapshot().output.join('\n');
    expect(output).toContain('【Executor: codex-cli｜最终结果｜#');
    expect(output).not.toContain('🛠️ Executor: codex-cli｜#');
    expect(output).not.toContain('Skill test-driven-development: 开始按 TDD 执行');
    expect(output).not.toContain('RED 测试已创建');
    expect(output).not.toContain('Skill test-driven-development: TDD 流程完成');
  });
});
