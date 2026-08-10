import { describe, expect, it } from 'vitest';
import {
  extractExecutorFinalOutput,
  extractExecutorSessionId,
} from '../../src/executor/executor-session-output.js';
import type { RuntimeExecutorBinding } from '../../src/executor/executor-registry-types.js';

describe('extractExecutorSessionId', () => {
  it('extracts the native Pi JSONL session header ID', () => {
    expect(extractExecutorSessionId(binding('pi'), [
      '{"type":"session","version":3,"id":"019fe00d-pi-session","cwd":"/tmp/workspace"}',
      '{"type":"agent_end","messages":[]}',
    ].join('\n'))).toBe('019fe00d-pi-session');
  });

  it('keeps dedicated Codex and generic protocol extraction', () => {
    expect(extractExecutorSessionId(binding('codex'), '{"thread_id":"thread-1"}')).toBe('thread-1');
    expect(extractExecutorSessionId({
      ...binding('cli-session'),
      sessionProtocol: {
        initialArgs: ['start', '{prompt}'],
        resumeArgs: ['resume', '{sessionId}', '{prompt}'],
        sessionIdPattern: 'session=(?<sessionId>[A-Za-z0-9-]+)',
        finalOutputPattern: null,
        timeoutMs: 10_000,
        terminateSignal: 'SIGTERM',
      },
    }, 'session=custom-1')).toBe('custom-1');
  });
});

describe('extractExecutorFinalOutput', () => {
  it('extracts only the final Pi assistant message from streaming JSONL', () => {
    const marker = '<!-- metaclaw:completion:v3 -->';
    const finalReport = [
      '# Node.js report',
      '',
      marker,
      '{"terminalState":"completed"}',
    ].join('\n');
    const output = [
      '{"type":"session","id":"pi-session-1"}',
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { partial: { type: 'text', text: marker } },
      }),
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { partial: { type: 'text', text: marker } },
      }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: `ignored ${marker}` },
            { type: 'text', text: finalReport },
          ],
        },
      }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: marker }] }],
      }),
      '{"type":"agent_settled"}',
    ].join('\n');

    const extracted = extractExecutorFinalOutput(binding('pi'), output);

    expect(extracted).toBe(finalReport);
    expect(extracted.match(/metaclaw:completion:v3/gu)).toHaveLength(1);
  });

  it('uses the last valid Pi assistant message and ignores malformed JSONL', () => {
    const output = [
      '{not-json',
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: 'ignored' }] },
      }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'second' },
            { type: 'toolCall', name: 'ignored' },
            { type: 'text', text: 'section' },
          ],
        },
      }),
    ].join('\n');

    expect(extractExecutorFinalOutput(binding('pi'), output)).toBe('second\nsection');
  });

  it('falls back to protocol patterns and raw output', () => {
    const protocolBinding: RuntimeExecutorBinding = {
      ...binding('cli-session'),
      sessionProtocol: {
        initialArgs: ['start', '{prompt}'],
        resumeArgs: ['resume', '{sessionId}', '{prompt}'],
        sessionIdPattern: 'session=(?<sessionId>[A-Za-z0-9-]+)',
        finalOutputPattern: 'final=(?<output>.+)',
        timeoutMs: 10_000,
        terminateSignal: 'SIGTERM',
      },
    };

    expect(extractExecutorFinalOutput(protocolBinding, 'noise final=answer')).toBe('answer');
    expect(extractExecutorFinalOutput(binding('pi'), 'plain fallback')).toBe('plain fallback');
  });
});

function binding(driver: RuntimeExecutorBinding['driver']): RuntimeExecutorBinding {
  return {
    id: `${driver}-executor`,
    configDigest: 'digest',
    driver,
    supportsSessionResume: true,
    evidenceAffordance: 'none',
    resultCollector: 'stdout',
    homeMaterializer: 'empty',
    binaryPath: `/usr/bin/${driver}`,
    versionArgs: ['--version'],
    runtimeHome: '/tmp/runtime-home',
    environmentFiles: [],
    inheritEnvironment: [],
    permissionProfileId: 'restricted-custom',
    sessionProtocol: null,
  };
}
