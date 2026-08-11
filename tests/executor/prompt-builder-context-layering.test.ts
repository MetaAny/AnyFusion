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
      completionContract: { marker: '<!-- metaclaw:completion:v4 -->' as const, schemaVersion: 4 as const },
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
    expect(prompt).toContain('<!-- metaclaw:completion:v4 -->');
    expect(prompt).not.toContain('internal-downstream-id');
    expect(prompt).not.toContain('internal-evidence-id');
    expect(prompt).not.toContain('internal-sibling-id');
    expect(prompt).not.toContain('conversationHistory');
    expect(prompt).not.toContain('executionContextBundle');
  });

  it('requires a result description and permits optional result file paths without delivery-type rules', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('{"resultFilePaths":["<optional workspace-relative result file path>"]}');
    expect(prompt).toContain('The Markdown before the marker is the required result description');
    expect(prompt).toContain('If you changed files, commit the complete result');
    expect(prompt).not.toContain('Delivery kind:');
    expect(prompt).not.toContain('noChangeReason');
    expect(prompt).not.toContain('must remain unchanged');
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
        completionRetry: {
          protocol: 'completion-correction-v2',
          violations: [{ code: 'completion_malformed', path: 'marker', message: 'marker missing' }],
        },
      },
    };

    const prompt = buildExecutorContextPrompt(recoveryInput);
    expect(prompt).toContain('previous approach failed');
    expect(prompt).toContain('created file');
    expect(prompt).toContain('completion-correction-v2');
    expect(prompt).toContain('marker missing');
    expect(prompt).not.toContain('internal-source-attempt-id');
    expect(prompt).not.toContain('sourceAttemptId');
  });
});
