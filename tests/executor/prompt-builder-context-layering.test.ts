import { describe, expect, it } from 'vitest';
import { buildExecutorContextPrompt } from '../../src/executor/prompt-builder.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';

function input(): ExecutorInput {
  return {
    context: {
      taskBackground: { id: 'internal-task-id', title: 'Task', goal: 'Top-level goal', instruction: 'background_only' as const },
      currentSubtask: {
        id: 'internal-subtask-id',
        title: 'A',
        goal: 'Only do A',
        deliveryKind: 'report' as const,
        acceptance: [
          { key: 'secret_acceptance_key_one', description: 'file exists', requiredEvidence: [] },
          { key: 'secret_acceptance_key_two', description: 'output verified', requiredEvidence: [] },
        ],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [{ toSubtaskId: 'internal-downstream-id', requiredItems: [{ key: 'secret_handoff_key', type: 'text' as const, description: 'summary' }] }],
      selectedEvidence: [{ ref: { kind: 'current_user_input' as const }, evidenceId: 'internal-evidence-id', title: 'Current input', content: 'selected evidence only', truncated: false }],
      outOfScopeSiblings: [{ id: 'internal-sibling-id', title: 'B' }],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'internal-execution-id', taskId: 'internal-task-id', subtaskId: 'internal-subtask-id', attemptId: 'internal-attempt-id', workUnitId: 'internal-work-unit-id' },
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->' as const, schemaVersion: 2 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'unit test' },
    },
  };
}

describe('Subtask execution prompt layering', () => {
  it('marks the Task goal background-only and the Subtask goal operative', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('Background goal: Top-level goal');
    expect(prompt).toContain('Operative goal: Only do A');
    expect(prompt).toContain('background only');
  });

  it('renders only selected evidence, direct handoffs, sibling titles and completion contract', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('selected evidence only');
    expect(prompt).toContain('"title": "B"');
    expect(prompt).toContain('<!-- metaclaw:completion:v2 -->');
    expect(prompt).not.toContain('internal-downstream-id');
    expect(prompt).not.toContain('internal-evidence-id');
    expect(prompt).not.toContain('internal-sibling-id');
    expect(prompt).not.toContain('conversationHistory');
    expect(prompt).not.toContain('executionContextBundle');
  });

  it('renders an identity-free completion report while Runtime owns all authoritative identities and keys', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('{"evidence":["<concise evidence that the work and checks succeeded>"],"noChangeReason":null}');
    expect(prompt).toContain('Runtime derives changed files and injects schema identity, attempt/work-unit/subtask IDs, acceptance keys, and handoff identities');
    for (const internalValue of [
      'internal-task-id',
      'internal-subtask-id',
      'internal-execution-id',
      'internal-attempt-id',
      'internal-work-unit-id',
      'secret_acceptance_key_one',
      'secret_acceptance_key_two',
      'secret_handoff_key',
    ]) {
      expect(prompt).not.toContain(internalValue);
    }
    expect(prompt).not.toContain('acceptanceEvidence');
    expect(prompt).not.toContain('schemaVersion');
  });

  it('keeps recovery attempt identity out of the model-facing recovery packet', () => {
    const recoveryInput = input();
    recoveryInput.context.recovery = {
      mode: 'recovery_packet',
      sourceAttemptId: 'internal-source-attempt-id',
      packet: {
        sourceAttemptId: 'internal-source-attempt-id',
        failure: { code: 'task_failed', summary: 'previous approach failed' },
        knownProgress: { fileCreated: true },
        workspaceDelta: {},
        confirmedCompleted: ['created file'],
        unknownItems: ['run tests'],
      },
    };

    const prompt = buildExecutorContextPrompt(recoveryInput);
    expect(prompt).toContain('previous approach failed');
    expect(prompt).toContain('created file');
    expect(prompt).not.toContain('internal-source-attempt-id');
    expect(prompt).not.toContain('sourceAttemptId');
  });
});
