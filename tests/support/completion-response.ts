import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';

export function completionResponse(
  input: ExecutorInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  return `${body}\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
    evidence: ['tests were not run: deterministic test fixture'],
    noChangeReason: input.context.currentSubtask.deliveryKind === 'edit' && artifacts.length === 0
      ? 'The deterministic test executor made no workspace changes.'
      : null,
  })}`;
}
