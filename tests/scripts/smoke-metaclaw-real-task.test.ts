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

function authoritativeSuccessState(artifactPath: string) {
  return {
    acceptedProposalCount: 1,
    tasks: [{ id: 'task-1', status: 'done' }],
    subtasks: [{
      id: 'subtask-1',
      taskId: 'task-1',
      status: 'done',
      artifactsJson: JSON.stringify([artifactPath]),
    }],
    receipts: [{
      taskId: 'task-1',
      subtaskId: 'subtask-1',
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
        tasks: [{ id: 'task-1', status: 'blocked' }],
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

    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain('hello.py');
    expect(turns[0]).toContain('print("Hello world")');
    expect(turns[0]).toContain('python3');
    expect(turns[1]).toBe('/exit');
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
});
