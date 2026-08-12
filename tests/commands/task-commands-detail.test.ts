import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { listTasks, resumeTask, showTask } from '../../src/commands/task-commands.js';
import type { CommandContext } from '../../src/commands/catalog.js';
import type { Config } from '../../src/core/types.js';

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

describe('showTask detail view', () => {
  let db: Database.Database;
  let taskEngine: TaskEngine;
  let memoryEngine: MemoryEngine;
  let context: CommandContext;

  beforeEach(() => {
    db = createTestDb();
    const taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);

    context = {
      taskEngine,
      memoryEngine,
      orchestration,
      currentTaskId: null,
      db,
      config: createConfig(),
    } as never;
  });

  it('shows latest executor and injected memory details in task detail output', async () => {
    const preference = memoryEngine.addManual({
      content: 'Phoenix 项目材料统一使用 Phoenix 术语体系',
      scope: 'project',
      type: 'domain',
      subject: 'Phoenix',
    });

    const task = taskEngine.create({ title: 'Phoenix 周报', goal: '整理 Phoenix 项目周报' });
    taskEngine['taskRepo'].update(task.id, {
      injectedPreferences: [preference.id],
      lastSchedulingReason: '用户提交',
      lastInterruptionReason: '被高优任务抢占：紧急会议纪要',
      summary: '已整理 Phoenix 周报摘要',
    });

    db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'int_task_detail_1',
      task.id,
      'sess_task_detail',
      '整理 Phoenix 项目周报',
      '已整理 Phoenix 周报摘要',
      'codex-cli',
      '2026-04-18T10:00:00.000Z',
    );

    const result = await showTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(result.content).toContain('最近执行器: codex-cli');
    expect(result.content).toContain('最近调度原因: 用户提交');
    expect(result.content).toContain('最近中断原因: 被高优任务抢占：紧急会议纪要');
    expect(result.content).toContain('注入偏好');
    expect(result.content).toContain('[project]');
    expect(result.content).toContain('Phoenix');
  });

  it('renders task detail as a structured task view with latest result, next step, resources, and blocker', async () => {
    const task = taskEngine.create({
      title: '起诉材料补齐',
      goal: '整理证据并补齐起诉材料',
      resources: ['/tmp/evidence-a.pdf'],
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });
    taskEngine['taskRepo'].appendSnapshot(task.id, {
      done: ['已整理现有证据目录'],
      pending: ['等待新增证据后补齐起诉书'],
      nextStep: '收到新证据后更新起诉书正文',
      pauseReason: '等待客户补充证据文件',
      createdAt: '2026-04-18T11:00:00.000Z',
    });
    taskEngine['taskRepo'].update(task.id, {
      summary: '已整理现有证据目录，待客户补充关键证据文件',
      lastSchedulingReason: '用户提交',
      lastInterruptionReason: '等待客户补充证据文件',
    });

    db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'int_task_detail_2',
      task.id,
      'sess_task_detail',
      '整理证据并补齐起诉材料',
      '已整理现有证据目录，待客户补充关键证据文件',
      'codex-cli',
      '2026-04-18T11:05:00.000Z',
    );

    const result = await showTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(result.content).toContain('任务视图');
    expect(result.content).toContain('当前状态');
    expect(result.content).toContain('最新结果摘要');
    expect(result.content).toContain('最新下一步');
    expect(result.content).toContain('当前阻塞');
    expect(result.content).toContain('关联材料');
    expect(result.content).toContain('等待客户补充证据文件');
    expect(result.content).toContain('/tmp/evidence-a.pdf');
    expect(result.content).toContain('收到新证据后更新起诉书正文');
  });

  it('shows recovery guidance for a parked task including last progress and resume action', async () => {
    const task = taskEngine.create({
      title: 'Phoenix 行业分析',
      goal: '继续整理 Phoenix 行业分析',
      resources: ['/tmp/phoenix-notes.md'],
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.park(task.id, '用户手动暂停', {
      done: ['已完成行业格局整理'],
      pending: ['继续补齐竞争对手对比'],
      nextStep: '先补齐主要竞争对手对比表',
      pauseReason: '用户手动暂停',
    });
    taskEngine['taskRepo'].update(task.id, {
      summary: '已完成行业格局整理',
      lastInterruptionReason: '用户手动暂停',
    });

    const result = await showTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(result.content).toContain('当前状态: parked');
    expect(result.content).toContain('上次做到');
    expect(result.content).toContain('已完成行业格局整理');
    expect(result.content).toContain('恢复操作');
    expect(result.content).toContain(`/task resume ${task.id}`);
  });

  it('splits local files and web links in task detail and shows a clearer blocked recovery hint when links already exist', async () => {
    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报',
      resources: ['/tmp/phoenix-weekly.md', 'https://example.com/phoenix-weekly'],
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待确认现有材料是否足以继续',
      status: 'waiting',
    });

    const result = await showTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(result.content).toContain('本地文件材料');
    expect(result.content).toContain('/tmp/phoenix-weekly.md');
    expect(result.content).toContain('网页链接材料');
    expect(result.content).toContain('https://example.com/phoenix-weekly');
    expect(result.content).toContain('材料概览');
    expect(result.content).toContain('材料状态');
    expect(result.content).toContain('若现有链接信息已足够');
  });

  it('uses readable material snippets in task detail so the summary matches the real execution context', async () => {
    const html = '<html><head><title>Phoenix Weekly</title></head><body><main>本周完成 Phoenix 核心模块联调，当前风险在跨团队依赖。</main></body></html>';
    const task = taskEngine.create({
      title: 'Phoenix 周报整理',
      goal: '整理 Phoenix 周报',
      resources: [
        '/tmp/phoenix-weekly.md',
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      ],
    });

    const result = await showTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(result.content).toContain('材料概览: 1 个本地文件，1 个网页链接，已提取 1 份可读摘录');
    expect(result.content).toContain('材料状态: 现有材料已包含可读内容，可先继续推进任务；若结果仍不够具体，再补充更多材料');
  });

  it('shows task artifacts in the task detail view when the executor has written result files', async () => {
    const task = taskEngine.create({
      title: 'harness 分析归档',
      goal: '把 harness 分析保存到项目目录',
    });
    taskEngine['taskRepo'].update(task.id, {
      status: 'done',
      summary: '已保存分析文档',
      artifacts: ['/tmp/metaclaw-artifacts/harness-analysis.md'],
    } as any);

    const result = await showTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(result.content).toContain('任务产物');
    expect(result.content).toContain('/tmp/metaclaw-artifacts/harness-analysis.md');
  });

  it('projects a ready Task awaiting repository promotion as waiting for approval', async () => {
    const now = '2026-08-12T02:00:00.000Z';
    const task = taskEngine.create({ title: '世界杯赔率模拟', goal: '生成并发布赔率模拟结果' });
    taskEngine.transition(task.id, 'ready');
    db.prepare(`
      INSERT INTO subtasks (
        id, task_id, title, goal, status, dependencies_json, context_refs_json,
        required_capabilities_json, preferred_agent_class_list_json, acceptance_json,
        risk_level, result, artifacts_json, verification_json, error, created_at,
        updated_at, graph_revision, generation_id
      ) VALUES (?, ?, ?, ?, 'awaiting_integration', '[]', '[]', '[]', '["codex"]',
        '[]', 'low', '', '[]', '{"warnings":[],"completionSchemaVersion":4}', NULL,
        ?, ?, 1, 'generation-approval')
    `).run('subtask-approval', task.id, '赔率模拟', '生成赔率模拟结果', now, now);
    const permissions = new SqlitePermissionRepository(db);
    permissions.createRequest({
      id: 'permission-publication',
      fingerprint: 'fingerprint-publication',
      taskId: task.id,
      generationId: 'generation-approval',
      subtaskId: 'subtask-approval',
      attemptId: 'attempt-approval',
      agentClassName: 'codex',
      permissionProfileId: 'workspace-engineering',
      capability: 'repository_promotion',
      resource: '/workspace/default',
      partition: { kind: 'repository', repositoryId: 'project-default' },
      operation: 'promote_commit:candidate',
      reason: 'Merge the completed candidate into Project main.',
      suggestedScope: 'once',
      distinctRequestOrdinal: 1,
    }, now);
    permissions.escalate('permission-publication', 'decision-publication', 'requires approval', now);
    new WorkspacePublicationRepo(db).insertCandidate({
      id: 'publication-approval',
      taskId: task.id,
      generationId: 'generation-approval',
      subtaskId: 'subtask-approval',
      sourceAttemptId: 'attempt-approval',
      agentClassName: 'codex',
      mainBaseCommit: 'base',
      candidateCommit: 'candidate',
      permissionRequestId: 'permission-publication',
      changedPaths: ['next_world_cup_odds.md'],
      completion: {
        body: 'candidate complete', artifacts: [], warnings: [], handoffs: [], completionSchemaVersion: 4,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });

    const detail = await showTask({ positionals: { taskId: task.id }, options: {} }, context);
    const list = await listTasks({ positionals: {}, options: {} }, context);
    const resume = await resumeTask({ positionals: { taskId: task.id }, options: {} }, context);

    expect(detail.content).toContain('当前状态: waiting_approval（底层 Task 仍为 ready）');
    expect(detail.content).toContain('批准发布请求 permission-publication');
    expect(detail.content).not.toContain('恢复操作: 无');
    expect(list.content).toContain('[WAITING_APPROVAL]');
    expect(list.content).toContain('在权限面板批准请求 permission-publication');
    expect(resume.type).toBe('text');
    expect(resume.content).toContain('Executor 已完成候选结果，无需再次调度');
    expect(resume.content).toContain('批准请求 permission-publication');
  });
});
