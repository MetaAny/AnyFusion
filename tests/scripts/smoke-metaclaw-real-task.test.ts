import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

async function loadSmokeScript() {
  return import('../../scripts/smoke-metaclaw-real-task.mjs');
}

function authoritativeSuccessState(artifactPath: string, agentClassName = 'codex-cli') {
  return {
    acceptedProposalCount: 1,
    tasks: [{ id: 'task-1', source: 'system_smoke', smokeRunId: 'smoke-1', status: 'done' }],
    subtasks: [{
      id: 'subtask-1',
      taskId: 'task-1',
      status: 'done',
      artifactsJson: JSON.stringify([artifactPath]),
    }],
    receipts: [{
      taskId: 'task-1',
      subtaskId: 'subtask-1',
      agentClassName,
      terminalState: 'completed',
    }],
    publications: [{ id: 'publication-1', taskId: 'task-1', status: 'integrated' }],
    dispatchItems: [{ attemptId: 'attempt-1', taskId: 'task-1', status: 'terminal' }],
  };
}

describe('smoke-metaclaw-real-task helpers', () => {
  it('parses executor, scenario, and integer options', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.readOption(['--executor', 'pi'], '--executor')).toBe('pi');
    expect(smoke.readOption(['--scenario=python-hello'], '--scenario')).toBe('python-hello');
    expect(smoke.parseExecutorCommand('pi')).toBe('pi');
    expect(smoke.parseScenario('planner-session')).toBe('planner-session');
    expect(smoke.parseScenario('python-hello')).toBe('python-hello');
    expect(smoke.parseScenario('pi-research')).toBe('pi-research');
    expect(smoke.parsePositiveInteger('42', 10)).toBe(42);
    expect(() => smoke.parseExecutorCommand('pi;rm')).toThrow(/Invalid smoke executor command/);
    expect(() => smoke.parseScenario('unknown')).toThrow(/Invalid smoke scenario/);
  });

  it('installs Pi config under the provided executor home', async () => {
    const smoke = await loadSmokeScript();
    const sourceDir = join(tempRoot, 'pi-config');
    const targetHome = join(tempRoot, 'home');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'models.json'), '{"models":[]}');
    writeFileSync(join(sourceDir, 'settings.json'), '{"defaultModel":"test"}');

    const targetDir = smoke.installPiConfig({ sourceDir, targetHome, repoRoot: tempRoot });

    expect(targetDir).toBe(join(targetHome, '.pi', 'agent'));
    expect(existsSync(join(targetDir, 'models.json'))).toBe(true);
    expect(readFileSync(join(targetDir, 'settings.json'), 'utf-8')).toContain('defaultModel');
  });

  it('does not overwrite a managed Pi executor home', async () => {
    const smoke = await loadSmokeScript();
    const targetHome = join(tempRoot, 'managed-home');
    const targetDir = join(targetHome, '.pi', 'agent');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'models.json'), '{"managed":true}');

    smoke.bootstrapExecutor({
      executorCommand: 'pi',
      executorHome: targetHome,
      repoRoot: tempRoot,
      preserveExistingConfig: true,
    });

    expect(readFileSync(join(targetDir, 'models.json'), 'utf-8')).toBe('{"managed":true}');
  });

  it('derives smoke configuration from the same template used by shell.ps1', async () => {
    const smoke = await loadSmokeScript();
    const dockerDir = join(tempRoot, 'docker');
    mkdirSync(dockerDir, { recursive: true });
    writeFileSync(join(dockerDir, 'tui-config.yaml'), [
      'executor:',
      '  command: codex',
      '  timeout: 900',
      '  max_duration: 3600',
      'ui:',
      '  dashboard_on_start: true',
      '',
    ].join('\n'));

    const config = smoke.buildSmokeConfig({
      repoRoot: tempRoot,
      executorCommand: 'pi',
      executorTimeout: 901,
      executorMaxDuration: 3601,
    });

    expect(config).toContain('command: pi');
    expect(config).toContain('timeout: 901');
    expect(config).toContain('max_duration: 3601');
    expect(config).toContain('dashboard_on_start: true');
  });

  it('cleans only smoke-owned paths by default', async () => {
    const smoke = await loadSmokeScript();
    const metaclawHome = join(tempRoot, 'metaclaw-home');
    const executorHome = join(tempRoot, 'executor-home');
    const externalWorkdir = join(tempRoot, 'project');
    const scriptDir = join(tempRoot, 'script');
    for (const path of [metaclawHome, executorHome, externalWorkdir, scriptDir]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'marker'), path);
    }

    smoke.cleanupOwnedSmokeArtifacts({
      keepArtifacts: false,
      managedByHost: false,
      metaclawHome,
      executorHome,
      workdir: externalWorkdir,
      scriptDir,
      ownsMetaclawHome: true,
      ownsExecutorHome: true,
      ownsWorkdir: false,
      ownsScriptDir: true,
    });

    expect(existsSync(metaclawHome)).toBe(false);
    expect(existsSync(executorHome)).toBe(false);
    expect(existsSync(scriptDir)).toBe(false);
    expect(readFileSync(join(externalWorkdir, 'marker'), 'utf-8')).toBe(externalWorkdir);
  });

  it('derives the canonical task-owned workspace and repository roots for purge verification', async () => {
    const smoke = await loadSmokeScript();
    const metaclawHome = join(tempRoot, 'metaclaw-home');

    expect(smoke.smokeTaskOwnedRuntimePaths(metaclawHome, 'project-1', 'task-1')).toEqual([
      join(metaclawHome, 'project-worktrees', 'project-1', 'workspaces', 'task-1'),
    ]);
  });

  it('verifies the authoritative Subtask artifact and its exact stdout', async () => {
    const smoke = await loadSmokeScript();
    const workdir = join(tempRoot, 'work');
    const artifactDir = join(tempRoot, 'managed-task-workspace');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, 'hello.py');
    writeFileSync(artifactPath, 'print("Hello world")\n');

    expect(smoke.verifyPythonHelloScenario({
      workdir,
      authoritativeState: authoritativeSuccessState(artifactPath),
    })).toMatchObject({ artifactPath, taskId: 'task-1' });
  });

  it('rejects a runnable Python artifact when the authoritative Task is blocked', async () => {
    const smoke = await loadSmokeScript();
    const workdir = join(tempRoot, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'hello.py'), 'print("Hello world")\n');

    expect(() => smoke.verifyPythonHelloScenario({
      workdir,
      authoritativeState: {
        acceptedProposalCount: 1,
        tasks: [{ id: 'task-1', source: 'system_smoke', smokeRunId: 'smoke-1', status: 'blocked' }],
        subtasks: [{ id: 'subtask-1', taskId: 'task-1', status: 'blocked' }],
        receipts: [{
          taskId: 'task-1',
          subtaskId: 'subtask-1',
          terminalState: 'contract_blocked',
          errorCode: 'completion_no_change_reason_mismatch',
        }],
        publications: [],
        dispatchItems: [],
      },
    })).toThrow(/authoritative Task task-1 is blocked/);
  });

  it('directs artifact output to the runtime-authorized target instead of the process cwd', async () => {
    const smoke = await loadSmokeScript();
    const script = smoke.buildScenarioScript('artifact');

    expect(script).toContain('Runtime will provide the exact authorized target directory');
    expect(script).toContain('do not ask me for a path');
    expect(script).toContain(smoke.smokeApprovalDirective);
    expect(script).not.toContain('in the current directory');
  });

  it('uses exactly two dialogue turns for the native Planner session memory smoke', async () => {
    const smoke = await loadSmokeScript();
    const script = smoke.buildScenarioScript('planner-session');
    const turns = script.trim().split('\n');

    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain(smoke.plannerMemoryMarker);
    expect(turns[1]).not.toContain(smoke.plannerMemoryMarker);
    expect(turns[1]).toContain('刚才');
    expect(turns[2]).toBe('/exit');
  });

  it('keeps the Python hello requirements in one Planner turn', async () => {
    const smoke = await loadSmokeScript();
    const turns = smoke.buildScenarioScript('python-hello').trim().split('\n');

    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain('hello.py');
    expect(turns[0]).toContain('print("Hello world")');
    expect(turns[0]).toContain('python3');
    expect(turns[1]).toBe(smoke.smokeApprovalDirective);
    expect(turns[2]).toBe('/exit');
  });

  it('uses a web-search-only turn for the Pi research smoke', async () => {
    const smoke = await loadSmokeScript();
    const turns = smoke.buildScenarioScript('pi-research').trim().split('\n');

    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain('web_search');
    expect(turns[0]).toContain('创建一个持久调研任务');
    expect(turns[0]).toContain('不要修改工作区');
    expect(turns[1]).toBe(smoke.smokeApprovalDirective);
    expect(turns[2]).toBe('/exit');
  });

  it('keeps the shared Executor Registry visible without overriding Runtime HOME for Pi smoke', async () => {
    const smoke = await loadSmokeScript();
    const childEnv = smoke.buildSmokeChildEnv({
      metaclawHome: '/data/anyfusion',
      anyFusionConfigHome: '/config/anyfusion',
      repoRoot: '/repo',
      smokeRunId: 'smoke-1',
    });

    expect(childEnv).toMatchObject({
      METACLAW_HOME: '/data/anyfusion',
      ANYFUSION_CONFIG_HOME: '/config/anyfusion',
      ANYFUSION_SMOKE_RUN_ID: 'smoke-1',
    });
    expect(childEnv).not.toHaveProperty('HOME');
    expect(childEnv).not.toHaveProperty('USERPROFILE');
  });

  it('verifies Pi research from authoritative receipt ownership', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.verifyPiResearchScenario({
      authoritativeState: authoritativeSuccessState('', 'pi'),
    })).toEqual({
      taskId: 'task-1',
      executorNames: ['pi'],
    });
    expect(() => smoke.verifyPiResearchScenario({
      authoritativeState: authoritativeSuccessState('', 'codex-cli'),
    })).toThrow(/expected a completed pi receipt/);
  });

  it('scopes authoritative Task and accepted proposal reads to the current smoke run', async () => {
    const smoke = await loadSmokeScript();
    const metaclawHome = join(tempRoot, 'main-home');
    mkdirSync(metaclawHome, { recursive: true });
    const db = new Database(join(metaclawHome, 'metaclaw.db'));
    runMigrations(db);
    const now = '2026-08-08T00:00:00.000Z';
    for (const index of [1, 2]) {
      const taskId = `task-${index}`;
      const eventId = `event-${index}`;
      db.prepare(`
        INSERT INTO tasks (
          id, title, source, smoke_run_id, status, created_at, updated_at
        ) VALUES (?, ?, 'system_smoke', ?, 'done', ?, ?)
      `).run(taskId, `Task ${index}`, `smoke-${index}`, now, now);
      db.prepare(`
        INSERT INTO kernel_events (
          id, schema_version, event_type, correlation_id, session_id, task_id,
          event_json, available_at, status, created_at, updated_at
        ) VALUES (?, 5, 'plan_proposed', ?, ?, NULL, '{}', ?, 'processed', ?, ?)
      `).run(eventId, `correlation-${index}`, `session-${index}`, now, now, now);
      db.prepare(`
        INSERT INTO kernel_decisions (
          id, schema_version, event_id, event_type, correlation_id, session_id,
          task_id, event_json, snapshot_json, decision_json, action, reason, created_at
        ) VALUES (
          ?, 5, ?, 'plan_proposed', ?, ?, ?, '{}', '{}', '{}',
          'authorize_task_plan', 'test', ?
        )
      `).run(
        `decision-${index}`,
        eventId,
        `correlation-${index}`,
        `session-${index}`,
        taskId,
        now,
      );
      db.prepare(`
        INSERT INTO planner_proposal_turns (
          session_id, turn_id, user_input, accepted_submission_id, created_at, updated_at
        ) VALUES (?, ?, 'work', ?, ?, ?)
      `).run(`session-${index}`, `turn-${index}`, `submission-${index}`, now, now);
      db.prepare(`
        INSERT INTO planner_proposal_submissions (
          session_id, turn_id, submission_id, plan_fingerprint, plan_id,
          event_id, status, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', '{}', ?, ?)
      `).run(
        `session-${index}`,
        `turn-${index}`,
        `submission-${index}`,
        `fingerprint-${index}`,
        `plan-${index}`,
        eventId,
        now,
        now,
      );
    }
    db.close();

    expect(smoke.readAuthoritativeTaskState(metaclawHome, 'smoke-2')).toMatchObject({
      acceptedProposalCount: 1,
      tasks: [{ id: 'task-2', smokeRunId: 'smoke-2' }],
      subtasks: [],
      receipts: [],
    });
  });

  it('requires the second reply to recall the marker from one persisted AnyFusion-Pi session', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.verifyPlannerSessionScenario({
      interactions: [{
        userInput: '刚才的测试短语是什么？只回复短语。',
        systemOutput: smoke.plannerMemoryMarker,
      }],
      sessionFiles: ['/planner/sessions/2026/07/30/rollout-one.jsonl'],
    })).toEqual({
      nativeSessionPath: '/planner/sessions/2026/07/30/rollout-one.jsonl',
    });

    expect(() => smoke.verifyPlannerSessionScenario({
      interactions: [{ userInput: '刚才的测试短语是什么？', systemOutput: '不知道' }],
      sessionFiles: ['/planner/sessions/one.jsonl'],
    })).toThrow(/did not recall/);
    expect(() => smoke.verifyPlannerSessionScenario({
      interactions: [{ userInput: '刚才的测试短语是什么？', systemOutput: smoke.plannerMemoryMarker }],
      sessionFiles: ['/planner/sessions/one.jsonl', '/planner/sessions/two.jsonl'],
    })).toThrow(/exactly one persisted AnyFusion-Pi session/);
  });

  it('rotates smoke audits to twenty bounded records', async () => {
    const smoke = await loadSmokeScript();
    const metaclawHome = join(tempRoot, 'audit-home');
    mkdirSync(metaclawHome, { recursive: true });
    const db = new Database(join(metaclawHome, 'metaclaw.db'));
    runMigrations(db);
    db.close();

    for (let index = 0; index < 25; index += 1) {
      smoke.recordSmokeRunAudit({
        metaclawHome,
        runId: `smoke-${index}`,
        scenario: 'artifact',
        executorId: 'codex-cli',
        result: index === 24 ? 'passed' : 'failed',
        diagnostics: { index },
        startedAt: `2026-08-08T00:00:${String(index).padStart(2, '0')}.000Z`,
        completedAt: `2026-08-08T00:01:${String(index).padStart(2, '0')}.000Z`,
      });
    }

    const readDb = new Database(join(metaclawHome, 'metaclaw.db'), { readonly: true });
    const rows = readDb.prepare(`
      SELECT run_id, result FROM smoke_run_audits
      ORDER BY completed_at DESC
    `).all();
    readDb.close();
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({ run_id: 'smoke-24', result: 'passed' });
    expect(rows.at(-1)).toEqual({ run_id: 'smoke-5', result: 'failed' });
  });

  it('rejects a successful user Task as authoritative smoke evidence', async () => {
    const smoke = await loadSmokeScript();
    const state = authoritativeSuccessState('');
    state.tasks[0] = {
      id: 'task-1',
      source: 'user',
      smokeRunId: null,
      status: 'done',
    };

    expect(() => smoke.verifyAuthoritativeTaskState(state))
      .toThrow(/is not owned by a system_smoke run/);
  });
});
