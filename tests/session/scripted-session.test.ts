import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import { parseScriptInputs, runScriptedSession } from '../../src/session/scripted-session.js';
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

describe('scripted session', () => {
  it('parses script lines while ignoring comments and blank lines', () => {
    const script = `
# comment

帮我整理合同风险
  /task list done

`;

    expect(parseScriptInputs(script)).toEqual([
      '帮我整理合同风险',
      '/task list done',
    ]);
  });

  it('does not execute a legacy blocked task through /task unblock without a natural-language v4 replan', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '起诉书草稿', goal: '补齐起诉材料' });
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'int_related_resume_ref',
      'task_related_ref',
      'sess_other',
      '补齐起诉材料时如何处理证据清单',
      '旧任务完整输出不应进入恢复 prompt。这里包含旧案结论、旧验收标准、旧材料清单。',
      'codex-cli',
      '2026-04-20T10:00:00.000Z',
    );

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已恢复处理' }));
    const result = await runScriptedSession({
      inputs: [
        `/task unblock ${blockedTask.id} /tmp/evidence-v3.pdf`,
        '/task list done',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted',
      contextRecaller,
    });

    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(result.output.join('\n')).toContain(`任务 #${blockedTask.id} 已提交恢复请求，并附带资源 /tmp/evidence-v3.pdf`);
    expect(result.output.join('\n')).toContain('work graph is missing; replanning is required');
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('parked');
  });

  it('resolves the last task id placeholder so scripted acceptance can open task detail after creation', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: 'Phoenix 周报结论：本周主线推进稳定，主要风险在跨团队依赖。',
    }));
    const result = await runScriptedSession({
      inputs: [
        '整理 Phoenix 项目的周报，输出一个简短结论',
        '/task show {{last_task_id}}',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_detail',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '整理 Phoenix 项目的周报，输出一个简短结论' }),
      ),
    });

    const output = result.output.join('\n');
    expect(output).toContain('任务视图');
    expect(output).toContain('最新结果摘要');
    expect(output).toContain('Phoenix 周报结论');
    expect(output).toContain('【MetaClaw｜理解用户请求】');
    expect(output).toContain('【Executor: codex-cli｜派发准备】\n→ Executor: codex-cli 将处理该任务');
    expect(output).not.toContain('已识别可执行任务');
    expect(output).not.toContain('PlanningAgent:');
    expect(output).not.toContain('ControlKernel:');
    expect(output).not.toContain('Runtime:');
    expect(output).not.toContain('[Planner: dispatch]');
    expect(output).not.toContain('Work Unit ');
  });

  it('blocks risky external actions pending a planner-observed confirmation in scripted sessions', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({ body: '已发送给客户' }));
    const result = await runScriptedSession({
      inputs: [
        '直接把邮件发给客户',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_risky_gate',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({
          goal: '直接把邮件发给客户',
          overrides: {
            risk: { level: 'high', requiresConfirmation: true, reasons: ['external send'] },
          },
        }),
      ),
    });

    expect(attemptSandbox.create).not.toHaveBeenCalled();
    expect(result.output.join('\n')).toContain('该操作存在较高风险，请明确确认是否继续执行。');
    expect(result.output.join('\n')).not.toContain('risk confirmation required');
  });

  it('records file artifacts returned by the executor for workspace write tasks', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const attemptSandbox = new FakeAttemptSandbox(input => {
        const artifactDir = input.mounts.find(mount => mount.target === '/workspace')?.source;
        const artifactPath = resolve(artifactDir!, 'artifact-note.md');
        mkdirSync(artifactDir!, { recursive: true });
        writeFileSync(artifactPath, '# Artifact\nsaved by test\n', 'utf-8');
        return {
          body: `已保存结果到 ${artifactPath}`,
          artifacts: [artifactPath],
        };
      });
    await runScriptedSession({
      inputs: [
        '写一段测试内容，保存成 markdown 文件',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_artifact',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '写一段测试内容，保存成 markdown 文件', capabilityClass: 'code_edit' }),
      ),
    });

    const doneTask = taskEngine.list().find(task => task.status === 'done');
    expect((doneTask as any)?.artifacts).toHaveLength(1);
    expect((doneTask as any)?.artifacts[0]).toContain('/workspace-store/workspaces/');
    expect((doneTask as any)?.artifacts[0]).toContain('/files/artifact-note.md');
  });

  it('shows file-task Executor final output once and does not repeat it in completion', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(input => {
        const targetDir = input.mounts.find(mount => mount.target === '/workspace')?.source;
        const artifactPath = resolve(targetDir!, 'landing-page.html');
        mkdirSync(targetDir!, { recursive: true });
        writeFileSync(artifactPath, '<!DOCTYPE html><html><body><h1>报名页</h1></body></html>', 'utf-8');
        return {
          body: `已生成 HTML 文件：${artifactPath}\n<!DOCTYPE html><html><body><h1>报名页</h1></body></html>`,
          artifacts: [artifactPath],
        };
      });
    const result = await runScriptedSession({
      inputs: [
        '生成一个报名落地页 html 文件',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_html_artifact',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '生成一个报名落地页 html 文件', capabilityClass: 'code_edit' }),
      ),
    });

    expect(result.output.join('\n')).toContain('completed 1 Subtask(s)');
    expect(result.output.join('\n')).toContain('Artifacts:');
    expect(result.output.join('\n')).toContain('【Executor: codex-cli｜最终结果｜#');
    expect(result.output.join('\n').match(/<!DOCTYPE html>/g)).toHaveLength(1);
    expect(result.output.join('\n').match(/<html><body>/g)).toHaveLength(1);
  });

  it('does not synthesize a fallback artifact when a valid text completion returns no artifact', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      body: '# 调研报告\n\n正文内容。不要误报缺少飞书云文档 API。',
    }));
    const result = await runScriptedSession({
      inputs: [
        '请产出飞书云文档和在线预览',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_feishu_doc_fallback',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '请产出飞书云文档和在线预览' }),
      ),
    });

    const doneTask = taskEngine.list().find(task => task.status === 'done');
    expect(doneTask).toBeTruthy();
    expect(doneTask?.artifacts).toEqual([]);
    expect(result.output.join('\n')).not.toContain('已记录 1 个任务产物');
  });

  it('does not write a fallback Feishu Markdown artifact from undeliverable executor output', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptSandbox = new FakeAttemptSandbox(() => ({
      rawOutput: [
          '⏱ Timeout — denying command',
          '',
          '磊哥，我已开始调研并确认“pi Agent”大概率指的是 earendil-works/pi。',
          '但在继续拉取/保存资料准备写入 Markdown 报告时，当前环境拦截了后续文件/资料下载命令。',
          '因此这次还没有生成最终 Markdown 文件。',
          '',
          '未完成项：',
          '- 详细报告 Markdown 尚未写入：',
          '  /home/ylfego/Program/metaclaw/metaclaw-tasks/task_h0ghGKo5V9',
          '',
          '需要你允许后，我再继续完成完整调研报告并写入目标目录。',
        ].join('\n'),
    }));
    const result = await runScriptedSession({
      inputs: [
        '请调研 pi Agent，产出飞书云文档和在线预览',
      ],
      taskEngine,
      memoryEngine,
      orchestration,
      attemptSandbox,
      db,
      config: createConfig(),
      sessionId: 'sess_scripted_feishu_doc_undeliverable',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '请调研 pi Agent，产出飞书云文档和在线预览' }),
      ),
    });

    const blockedTask = taskEngine.list().find(task => task.status === 'blocked');
    expect(blockedTask).toBeTruthy();
    const fallbackArtifact = resolve(process.cwd(), 'metaclaw-tasks', blockedTask!.id, 'feishu-document.md');
    expect(blockedTask?.artifacts).not.toContain(fallbackArtifact);
    expect(result.output.join('\n')).toContain('response-only correction is unavailable or already exhausted');
    expect(result.output.join('\n')).not.toContain('已记录 1 个任务产物');
  });
});
