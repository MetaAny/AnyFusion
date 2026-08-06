import type { ExecutorInput } from './adapter.js';

/** The only production renderer for an Executor's attempt-scoped context. */
export function buildExecutorContextPrompt(input: ExecutorInput): string {
  const { context } = input;
  const lines = [
    '[MetaClaw Subtask Execution Context v1]',
    '',
    'Boundary rules:',
    '- The Task goal below is background only. It is not an instruction to execute the whole Task.',
    '- Execute only currentSubtask.goal.',
    '- Other graph nodes are out of scope. Do not execute or anticipate their full goals.',
    '- Dependency data is available only through incomingHandoffs.',
    '- Work only within the default authorized workspace boundary. If an operation outside it is required, call request_capability with one exact resource and operation; never work around a denial.',
    '- A granted request returns a grantId. Every broker-mediated use must call use_capability with that grantId and the exact operation payload so Runtime can enforce TTL, call, and byte budgets. A grant never permits direct access.',
    '- Finish with non-empty Markdown followed by exactly one completion marker and strict JSON until EOF.',
    '',
    `Task background: ${context.taskBackground.title}`,
    `Background goal: ${context.taskBackground.goal}`,
    '',
    `Current Subtask: ${context.currentSubtask.title}`,
    `Operative goal: ${context.currentSubtask.goal}`,
    `Delivery kind: ${context.currentSubtask.deliveryKind}`,
    'Acceptance requirements (Runtime owns their internal keys):',
    JSON.stringify(context.currentSubtask.acceptance.map(item => ({
      description: item.description,
      requiredEvidence: item.requiredEvidence,
    })), null, 2),
    '',
    'Incoming direct handoffs:',
    JSON.stringify(context.incomingHandoffs.map(handoff => ({
      items: handoff.items.map(item => item.type === 'text'
        ? { type: item.type, value: item.value }
        : { type: item.type, paths: item.paths }),
    })), null, 2),
    '',
    'Outgoing handoff requirements (do not infer downstream goals):',
    JSON.stringify(context.outgoingHandoffRequirements.map(contract => ({
      requiredItems: contract.requiredItems.map(item => ({
        type: item.type,
        description: item.description,
      })),
    })), null, 2),
    '',
    'Planner-selected evidence:',
    JSON.stringify(context.selectedEvidence.map(evidence => ({
      title: evidence.title,
      content: evidence.content,
      truncated: evidence.truncated,
    })), null, 2),
    '',
    'Out-of-scope graph nodes (titles only):',
    JSON.stringify(context.outOfScopeSiblings.map(sibling => ({ title: sibling.title })), null, 2),
    '',
    `Working directory: ${context.workspaceContext.workingDirectory}`,
    `Authorized target paths: ${context.workspaceContext.targetPaths.join(', ') || '(none)'}`,
    `Evidence tool: ${context.evidenceTools.availability} — ${context.evidenceTools.reason}`,
    ...(context.recovery && context.recovery.mode !== 'fresh' ? [
      '',
      `Recovery mode: ${context.recovery.mode}`,
      'Inspect current state before continuing. Preserve confirmed work and perform only the remaining work.',
      `Recovery packet: ${JSON.stringify(modelRecoveryPacket(context.recovery.packet), null, 2)}`,
    ] : []),
    '',
    'Completion protocol:',
    context.completionContract.marker,
    JSON.stringify({
      evidence: ['<concise evidence that the work and checks succeeded>'],
      noChangeReason: null,
    }),
    'Return only evidence and noChangeReason. Runtime derives changed files and injects schema identity, attempt/work-unit/subtask IDs, acceptance keys, and handoff identities from the bound contract.',
    'For edit delivery, set noChangeReason to null when files changed; when no files need to change, provide a concise non-empty reason. For report delivery it must be null and the workspace must remain unchanged.',
    'If the Subtask cannot be completed, return {"failure":{"kind":"task_failed","code":"<stable_code>","summary":"<concise explanation>"}} instead.',
    'The marker shown above is illustrative. Emit it exactly once, only at the end of your final response.',
  ];
  return lines.join('\n');
}

function modelRecoveryPacket(packet: Record<string, unknown> | null): Record<string, unknown> {
  if (!packet) return {};
  return {
    failure: packet.failure,
    knownProgress: packet.knownProgress,
    workspaceDelta: packet.workspaceDelta,
    confirmedCompleted: packet.confirmedCompleted,
    unknownItems: packet.unknownItems,
  };
}
