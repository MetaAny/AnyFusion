import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCompletionProtocol, COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import type { Subtask } from '../../src/core/types.js';

const roots: string[] = [];

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  const now = new Date().toISOString();
  return {
    id: 'task_a', taskId: 'task', title: 'A', goal: 'Do A', status: 'running',
    dependencies: [], contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'low', result: '', artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function response(report: Record<string, unknown> = {}, body = 'Completed cleanly.'): string {
  return `${body}\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify(report)}`;
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'metaclaw-completion-'));
  roots.push(value);
  return value;
}

function validate(input: {
  rawResponse?: string;
  current?: Subtask;
  workspaceRoot?: string;
  outgoingHandoffs?: Parameters<typeof validateCompletionProtocol>[0]['outgoingHandoffs'];
  incomingUsageByTarget?: Parameters<typeof validateCompletionProtocol>[0]['incomingUsageByTarget'];
} = {}) {
  return validateCompletionProtocol({
    rawResponse: input.rawResponse ?? response(),
    subtask: input.current ?? subtask(),
    outgoingHandoffs: input.outgoingHandoffs ?? [],
    workspaceRoot: input.workspaceRoot ?? root(),
    incomingUsageByTarget: input.incomingUsageByTarget,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Completion Protocol v4', () => {
  it('uses the required result description for acceptance and text handoffs', () => {
    const current = subtask({
      id: 'bound-subtask',
      acceptance: [
        { key: 'result_ready', description: 'result is ready', requiredEvidence: [] },
        { key: 'result_checked', description: 'result is checked', requiredEvidence: [] },
      ],
    });
    const description = '调研完成：英格兰和法国并列 20 球，来源和覆盖范围已核对。';
    const result = validate({
      rawResponse: response({}, description),
      current,
      outgoingHandoffs: [{
        toSubtaskId: 'bound-downstream',
        requiredItems: [{ key: 'summary', type: 'text', description: 'execution summary' }],
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      body: description,
      envelope: {
        schemaVersion: 4,
        status: 'completed',
        subtaskId: 'bound-subtask',
        acceptanceEvidence: [
          { key: 'result_ready', evidence: [description] },
          { key: 'result_checked', evidence: [description] },
        ],
        artifacts: [],
        handoffs: [{
          toSubtaskId: 'bound-downstream',
          items: [{ key: 'summary', type: 'text', value: description }],
        }],
      },
    });
  });

  it('allows either unchanged or changed workspaces without a delivery type', () => {
    expect(validate().ok).toBe(true);
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'unreported-change.md'), 'changed');
    expect(validate({ workspaceRoot }).ok).toBe(true);
  });

  it('accepts optional result files and validates only the declared paths', () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'results'));
    writeFileSync(join(workspaceRoot, 'results', 'goals.json'), '{}');
    const result = validate({
      workspaceRoot,
      rawResponse: response({ resultFilePaths: ['results/goals.json'] }),
      outgoingHandoffs: [{
        toSubtaskId: 'task_b',
        requiredItems: [{ key: 'files', type: 'artifact', description: 'result files' }],
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      normalizedArtifacts: [join(workspaceRoot, 'results', 'goals.json')],
      envelope: {
        artifacts: [join(workspaceRoot, 'results', 'goals.json')],
        handoffs: [{
          toSubtaskId: 'task_b',
          items: [{ key: 'files', type: 'artifact', paths: [join(workspaceRoot, 'results', 'goals.json')] }],
        }],
      },
    });
  });

  it('rejects missing, escaping, or forged result file paths', () => {
    const workspaceRoot = root();
    for (const payload of [
      { resultFilePaths: ['missing.md'] },
      { resultFilePaths: ['../outside.md'] },
      { resultFilePaths: ['/tmp/outside.md'] },
      { resultFilePaths: ['missing.md'], artifacts: ['/workspace/forged'] },
    ]) {
      const result = validate({ workspaceRoot, rawResponse: response(payload) });
      expect(result.ok ? [] : result.violations.map(item => item.code))
        .toContain(payload.artifacts ? 'completion_malformed' : 'completion_artifact_invalid');
    }
  });

  it('requires one non-empty result description and one strict terminal report', () => {
    expect(validate({ rawResponse: response({}, '') }).ok).toBe(false);
    expect(validate({ rawResponse: `${response()}\n${COMPLETION_MARKER_V4}` }).ok).toBe(false);
    expect(validate({ rawResponse: `${response()}\ntrailing` }).ok).toBe(false);
    for (const payload of [
      { evidence: ['legacy'], noChangeReason: null },
      { resultFilePaths: [], schemaVersion: 3 },
      { resultFilePaths: 'not-an-array' },
    ]) {
      const result = validate({ rawResponse: response(payload) });
      expect(result.ok ? [] : result.violations.map(item => item.code)).toContain('completion_malformed');
    }
  });

  it('accepts only the controlled Executor failure taxonomy', () => {
    const failed = validateCompletionProtocol({
      rawResponse: response({
        failure: { kind: 'capability_mismatch', code: 'missing_browser', summary: 'This class cannot browse.' },
      }, 'Unable to complete this Subtask.'),
      subtask: subtask(), outgoingHandoffs: [], workspaceRoot: '/missing',
    });
    expect(failed).toMatchObject({
      ok: true,
      envelope: { schemaVersion: 4, status: 'failed', failure: { kind: 'capability_mismatch' } },
    });
    expect(validate({ rawResponse: response({
      failure: { kind: 'network', code: 'network', summary: 'network down' },
    }) }).ok).toBe(false);
  });

  it('requires result files when a downstream artifact handoff requires them', () => {
    const result = validate({
      outgoingHandoffs: [{
        toSubtaskId: 'task_b',
        requiredItems: [{ key: 'files', type: 'artifact', description: 'result files' }],
      }],
    });
    expect(result.ok ? [] : result.violations).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded', path: 'handoffs.0.items.0.paths',
    }));
  });

  it('enforces aggregate incoming handoff budgets using the result description', () => {
    const result = validate({
      rawResponse: response({}, 'x'.repeat(3_997)),
      outgoingHandoffs: [{
        toSubtaskId: 'task_b',
        requiredItems: [{ key: 'summary', type: 'text', description: 'summary' }],
      }],
      incomingUsageByTarget: new Map([['task_b', { textCharacters: 21_000, artifactPaths: 0 }]]),
    });
    expect(result.ok ? [] : result.violations).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded', path: 'handoffs.0.toSubtaskId',
    }));
  });
});
