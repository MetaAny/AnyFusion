import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import { isAbsolute, relative } from 'node:path';

export function completionResponse(
  input: ExecutorInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  const workspaceRoot = input.context.workspaceContext.workingDirectory;
  const resultFilePaths = artifacts.map(path => (
    isAbsolute(path) ? relative(workspaceRoot, path).replaceAll('\\', '/') : path
  ));
  return `${body}\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
    ...(resultFilePaths.length > 0 ? { resultFilePaths } : {}),
  })}`;
}
