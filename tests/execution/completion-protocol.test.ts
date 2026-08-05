import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCompletionProtocol, COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';
import type { Subtask } from '../../src/core/types.js';
import type { WorkspaceDelta, WorkspaceDeltaEntry } from '../../src/execution/workspace-change-tracker.js';

const roots: string[] = [];

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  const now = new Date().toISOString();
  return {
    id: 'task_a', taskId: 'task', title: 'A', goal: 'Do A', status: 'running',
    dependencies: [], contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'low', result: '', artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function response(report: Record<string, unknown>, body = 'Completed cleanly.'): string {
  return `${body}\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify(report)}`;
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { evidence: ['verified result'], noChangeReason: null, ...overrides };
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'metaclaw-completion-'));
  roots.push(value);
  return value;
}

function delta(changed: WorkspaceDeltaEntry[] = [], overrides: Partial<WorkspaceDelta> = {}): WorkspaceDelta {
  return {
    kind: 'git_status_delta_v1',
    changed,
    baselineTruncated: false,
    finalTruncated: false,
    ...overrides,
  };
}

function validate(input: {
  rawResponse?: string;
  current?: Subtask;
  workspaceRoot?: string;
  workspaceDelta?: unknown;
  outgoingHandoffs?: Parameters<typeof validateCompletionProtocol>[0]['outgoingHandoffs'];
  incomingUsageByTarget?: Parameters<typeof validateCompletionProtocol>[0]['incomingUsageByTarget'];
}) {
  return validateCompletionProtocol({
    rawResponse: input.rawResponse ?? response(report()),
    subtask: input.current ?? subtask(),
    outgoingHandoffs: input.outgoingHandoffs ?? [],
    workspaceRoot: input.workspaceRoot ?? root(),
    workspaceDelta: Object.hasOwn(input, 'workspaceDelta') ? input.workspaceDelta : delta(),
    incomingUsageByTarget: input.incomingUsageByTarget,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Completion Protocol v3', () => {
  it('injects authoritative identities, acceptance keys, and handoff identities', () => {
    const current = subtask({
      id: 'bound-subtask',
      acceptance: [
        { key: 'file_created', description: 'file exists', requiredEvidence: [] },
        { key: 'output_verified', description: 'output verified', requiredEvidence: [] },
      ],
    });
    const evidence = ['hello.py 已创建', '运行 python3 后输出 Hello world'];
    const result = validate({
      rawResponse: response(report({ evidence })),
      current,
      outgoingHandoffs: [{
        toSubtaskId: 'bound-downstream',
        requiredItems: [{ key: 'summary', type: 'text', description: 'execution summary' }],
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      envelope: {
        schemaVersion: 3,
        status: 'completed',
        subtaskId: 'bound-subtask',
        acceptanceEvidence: [
          { key: 'file_created', evidence },
          { key: 'output_verified', evidence },
        ],
        handoffs: [{
          toSubtaskId: 'bound-downstream',
          items: [{ key: 'summary', type: 'text', value: evidence.join('\n') }],
        }],
      },
    });
  });

  it('strips one strict terminal report and rejects legacy or forged fields', () => {
    expect(validate({}).ok).toBe(true);
    expect(validate({ rawResponse: `${response(report())}\n${COMPLETION_MARKER_V3}` }).ok).toBe(false);
    expect(validate({ rawResponse: `${response(report())}\ntrailing` }).ok).toBe(false);
    for (const payload of [
      { ...report(), schemaVersion: 2, status: 'completed', subtaskId: 'task_a' },
      { ...report(), workUnitId: 'forged', acceptanceEvidence: [{ key: 'done', evidence: ['forged'] }] },
      { ...report(), artifacts: ['/workspace/forged'] },
    ]) {
      const result = validate({ rawResponse: response(payload) });
      expect(result.ok ? [] : result.violations.map(item => item.code)).toContain('completion_malformed');
    }
  });

  it('accepts only the controlled Executor failure taxonomy without requiring a delta', () => {
    const failed = validateCompletionProtocol({
      rawResponse: response({
        failure: { kind: 'capability_mismatch', code: 'missing_browser', summary: 'This class cannot browse.' },
      }, 'Unable to complete this Subtask.'),
      subtask: subtask(), outgoingHandoffs: [], workspaceRoot: '/missing', workspaceDelta: null,
    });
    expect(failed).toMatchObject({
      ok: true,
      envelope: { schemaVersion: 3, status: 'failed', failure: { kind: 'capability_mismatch' } },
    });
    expect(validate({ rawResponse: response({
      failure: { kind: 'network', code: 'network', summary: 'network down' },
    }) }).ok).toBe(false);
  });

  it('enforces aggregate incoming handoff budgets', () => {
    const outgoingHandoffs = [{
      toSubtaskId: 'task_b',
      requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }],
    }];
    const result = validate({
      rawResponse: response(report({ evidence: [
        'x'.repeat(1_000), 'x'.repeat(1_000), 'x'.repeat(1_000), 'x'.repeat(997),
      ] })),
      outgoingHandoffs,
      incomingUsageByTarget: new Map([['task_b', { textCharacters: 21_000, artifactPaths: 0 }]]),
    });
    expect(result.ok ? [] : result.violations).toContainEqual(expect.objectContaining({
      code: 'completion_budget_exceeded', path: 'handoffs.0.toSubtaskId',
    }));
  });

  it.each([
    ['created', { path: 'new.md', beforeHash: null, afterHash: 'new' }],
    ['modified', { path: 'existing.md', beforeHash: 'old', afterHash: 'new' }],
    ['deleted', { path: 'removed.md', beforeHash: 'old', afterHash: null }],
  ] as const)('rejects report delivery when a file is %s', (_label, change) => {
    const result = validate({ workspaceDelta: delta([change]) });
    expect(result.ok ? [] : result.violations.map(item => item.code))
      .toContain('completion_report_workspace_changed');
  });

  it('requires report noChangeReason to be null', () => {
    const result = validate({ rawResponse: response(report({ noChangeReason: 'nothing needed' })) });
    expect(result.ok ? [] : result.violations.map(item => item.code))
      .toContain('completion_no_change_reason_mismatch');
  });

  it('derives edit artifacts from created and modified files while retaining deletion only in the delta', () => {
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, 'nested'));
    writeFileSync(join(workspaceRoot, 'created.md'), 'created');
    writeFileSync(join(workspaceRoot, 'nested', 'modified.md'), 'modified');
    const workspaceDelta = delta([
      { path: 'created.md', beforeHash: null, afterHash: 'created-hash' },
      { path: 'nested/modified.md', beforeHash: 'old-hash', afterHash: 'new-hash' },
      { path: 'deleted.md', beforeHash: 'old-hash', afterHash: null },
    ]);
    const result = validate({
      current: subtask({ deliveryKind: 'edit' }), workspaceRoot, workspaceDelta,
      outgoingHandoffs: [{
        toSubtaskId: 'task_b',
        requiredItems: [{ key: 'files', type: 'artifact', description: 'changed files' }],
      }],
    });
    expect(result).toMatchObject({
      ok: true,
      normalizedArtifacts: [join(workspaceRoot, 'created.md'), join(workspaceRoot, 'nested', 'modified.md')],
      envelope: {
        handoffs: [{
          toSubtaskId: 'task_b',
          items: [{
            key: 'files', type: 'artifact',
            paths: [join(workspaceRoot, 'created.md'), join(workspaceRoot, 'nested', 'modified.md')],
          }],
        }],
      },
    });
  });

  it('allows a zero-delta edit only with a non-empty no-change reason', () => {
    const current = subtask({ deliveryKind: 'edit' });
    const rejected = validate({ current });
    expect(rejected.ok ? [] : rejected.violations.map(item => item.code))
      .toContain('completion_no_change_reason_mismatch');
    expect(validate({
      current,
      rawResponse: response(report({ noChangeReason: 'The requested state was already present.' })),
    }).ok).toBe(true);
  });

  it('rejects a no-change reason when an edit changed files', () => {
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'changed.md'), 'changed');
    const result = validate({
      current: subtask({ deliveryKind: 'edit' }),
      workspaceRoot,
      workspaceDelta: delta([{ path: 'changed.md', beforeHash: null, afterHash: 'hash' }]),
      rawResponse: response(report({ noChangeReason: 'not applicable' })),
    });
    expect(result.ok ? [] : result.violations.map(item => item.code))
      .toContain('completion_no_change_reason_mismatch');
  });

  it('fails closed for missing, malformed, or truncated workspace deltas', () => {
    for (const workspaceDelta of [null, {}, delta([], { baselineTruncated: true }), delta([], { finalTruncated: true })]) {
      const result = validate({ workspaceDelta });
      expect(result.ok ? [] : result.violations.map(item => item.code))
        .toContain('completion_workspace_delta_uncertain');
    }
  });
});
