import type { RuntimeExecutorBinding } from './executor-registry-types.js';

export function extractExecutorSessionId(
  binding: Readonly<RuntimeExecutorBinding>,
  output: string,
): string | null {
  if (binding.driver === 'pi') {
    const headerId = extractPiSessionHeaderId(output);
    if (headerId) return headerId;
  }
  const pattern = sessionIdPattern(binding);
  if (!pattern) return null;
  const match = new RegExp(pattern, 'u').exec(output);
  return match?.groups?.sessionId ?? match?.[1] ?? null;
}

export function extractExecutorFinalOutput(
  binding: Readonly<RuntimeExecutorBinding>,
  output: string,
): string {
  if (binding.driver === 'pi') {
    const finalMessage = extractPiFinalAssistantMessage(output);
    if (finalMessage !== null) return finalMessage;
  }
  const pattern = binding.sessionProtocol?.finalOutputPattern;
  if (!pattern) return output;
  const match = new RegExp(pattern, 'su').exec(output);
  return match?.groups?.output ?? match?.[1] ?? output;
}

function extractPiSessionHeaderId(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value === 'object'
        && value !== null
        && 'type' in value
        && value.type === 'session'
        && 'id' in value
        && typeof value.id === 'string'
        && value.id.length > 0
      ) {
        return value.id;
      }
    } catch {
      // Pi emits JSONL mixed with diagnostics; non-JSON lines are not session headers.
    }
  }
  return null;
}

function extractPiFinalAssistantMessage(output: string): string | null {
  let finalMessage: string | null = null;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value !== 'object'
        || value === null
        || !('type' in value)
        || value.type !== 'message_end'
        || !('message' in value)
        || typeof value.message !== 'object'
        || value.message === null
        || !('role' in value.message)
        || value.message.role !== 'assistant'
        || !('content' in value.message)
        || !Array.isArray(value.message.content)
      ) {
        continue;
      }
      const text = value.message.content.flatMap(part => (
        typeof part === 'object'
        && part !== null
        && 'type' in part
        && part.type === 'text'
        && 'text' in part
        && typeof part.text === 'string'
          ? [part.text]
          : []
      )).join('\n').trim();
      if (text) finalMessage = text;
    } catch {
      // Pi may mix JSONL with diagnostics; malformed lines cannot be final events.
    }
  }
  return finalMessage;
}

function sessionIdPattern(binding: Readonly<RuntimeExecutorBinding>): string | null {
  if (binding.sessionProtocol?.sessionIdPattern) return binding.sessionProtocol.sessionIdPattern;
  if (binding.driver === 'codex') return '"thread_id"\\s*:\\s*"([^"]+)"';
  if (binding.driver === 'pi') return '"session(?:Id|_id|File|_file)"\\s*:\\s*"([^"]+)"';
  if (binding.driver === 'hermes') {
    return '(?:session[_ ]?id|Session ID)[\\"\\\']?\\s*[:=]\\s*[\\"\\\']?([A-Za-z0-9_-]+)';
  }
  return null;
}
