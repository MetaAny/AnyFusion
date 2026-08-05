import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PlannerProcessRunner } from '../src/planning/planner-process-runner.js';

interface FakeRpcProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function emitJson(child: FakeRpcProcess, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

function createRpcProcess(
  onCommand: (request: Record<string, unknown>, child: FakeRpcProcess) => void,
): FakeRpcProcess {
  const child = new EventEmitter() as FakeRpcProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString();
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      onCommand(JSON.parse(line) as Record<string, unknown>, child);
      newline = input.indexOf('\n');
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  return child;
}

function acceptedResult(label: string) {
  return {
    status: 'accepted' as const,
    turnId: `turn-${label}`,
    submissionId: `submission-${label}`,
    planId: `plan-${label}`,
    outcome: 'proposal_validated' as const,
    displayText: 'validated',
    taskId: null,
    kernel: null,
  };
}

function completeTurn(child: FakeRpcProcess, requestId: unknown, label = 'one'): void {
  const plan = { id: `plan-${label}`, schemaVersion: 7 };
  const result = acceptedResult(label);
  emitJson(child, { type: 'response', command: 'prompt', success: true, id: requestId });
  emitJson(child, {
    type: 'tool_execution_start', toolCallId: 'tool-1',
    toolName: 'submit_planning_proposal', args: { plan },
  });
  emitJson(child, {
    type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'submit_planning_proposal',
    result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, terminate: true },
    isError: false,
  });
  emitJson(child, { type: 'agent_end', messages: [] });
}

describe('PlannerProcessRunner', () => {
  it('returns only an accepted native proposal tool result, not assistant text', async () => {
    let seen: {
      command: string;
      args: string[];
      request?: Record<string, unknown>;
      env?: NodeJS.ProcessEnv;
    } | undefined;
    const runner = new PlannerProcessRunner({
      command: 'anyfusion-planner',
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        seen = { command, args, env: options.env };
        return createRpcProcess((request, child) => {
          seen = { ...seen!, request };
          completeTurn(child, request.id);
        }) as never;
      }) as never,
    });

    const result = await runner.run('hello', {
      timeoutMs: 1000,
      request: { sessionId: 'session-1', source: 'session' },
    } as never, 'validation');

    expect(result).toMatchObject({
      proposalResult: { status: 'accepted', outcome: 'proposal_validated' },
      submittedPlan: { id: 'plan-one', schemaVersion: 7 },
      threadId: join('/tmp/anyfusion-planner-test', 'session-1.jsonl'),
      toolCalls: [{ toolName: 'submit_planning_proposal', status: 'completed' }],
    });
    expect(seen?.request).toMatchObject({ type: 'prompt', message: 'hello' });
    expect(seen?.env?.ANYFUSION_PLANNER_TURN_PURPOSE).toBe('validation');
    expect(seen?.env?.METACLAW_PLANNER_SESSION_ID).toBe('session-1');
    expect(seen?.env?.ANYFUSION_PLANNER_CATALOG_JSON).toBeUndefined();
    expect(seen?.env?.ANYFUSION_PLANNER_MCP_COMMAND).toBe(process.execPath);
    expect(JSON.parse(seen?.env?.ANYFUSION_PLANNER_MCP_ARGS_JSON ?? '[]')).toEqual([
      expect.stringMatching(/planner-mcp\.js$/),
    ]);
  });

  it('fails closed when Pi rejects prompt preflight and redacts the error', async () => {
    const runner = new PlannerProcessRunner({
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: (() => createRpcProcess((request, child) => {
        emitJson(child, {
          type: 'response', command: 'prompt', success: false, id: request.id,
          error: 'api_key=planner-secret Authorization: Bearer bearer-secret',
        });
      }) as never) as never,
    });

    const error = await runner.run('hello', {
      timeoutMs: 1000,
      request: { sessionId: 'session-error', source: 'gateway' },
    } as never, 'kernel').catch(reason => reason as Error);

    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('planner-secret');
    expect(error.message).not.toContain('bearer-secret');
  });

  it('serializes concurrent turns targeting the same persisted Pi session', async () => {
    const children: FakeRpcProcess[] = [];
    const requests: Record<string, unknown>[] = [];
    const spawn = vi.fn(() => {
      const child = createRpcProcess(request => { requests.push(request); });
      children.push(child);
      return child as never;
    });
    const runner = new PlannerProcessRunner({ sessionDir: '/tmp/anyfusion-planner-test', spawn: spawn as never });
    const context = {
      timeoutMs: 1000,
      request: { sessionId: 'shared-session', source: 'gateway' },
    } as never;

    const first = runner.run('first', context, 'validation');
    const second = runner.run('second', context, 'validation');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    completeTurn(children[0]!, requests[0]!.id, 'first');
    await expect(first).resolves.toMatchObject({ submittedPlan: { id: 'plan-first' } });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    completeTurn(children[1]!, requests[1]!.id, 'second');
    await expect(second).resolves.toMatchObject({ submittedPlan: { id: 'plan-second' } });
  });

  it('does not accept agent_end after only a rejected proposal result', async () => {
    const runner = new PlannerProcessRunner({
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: (() => createRpcProcess((request, child) => {
        const rejected = {
          status: 'rejected', turnId: 'turn-1', submissionId: 'submission-1', planId: null,
          rejectionType: 'validation', issues: ['missing priority'], kernel: null,
        };
        emitJson(child, { type: 'response', command: 'prompt', success: true, id: request.id });
        emitJson(child, { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'submit_planning_proposal', args: { plan: {} } });
        emitJson(child, { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'submit_planning_proposal', result: { details: rejected }, isError: false });
        emitJson(child, { type: 'agent_end', messages: [] });
      }) as never) as never,
    });

    await expect(runner.run('hello', {
      timeoutMs: 1000,
      request: { sessionId: 'session-rejected', source: 'gateway' },
    } as never, 'kernel')).rejects.toThrow('without an accepted submit_planning_proposal');
  });

  it('reports a redacted Planner model error instead of misclassifying it as a missing proposal', async () => {
    const runner = new PlannerProcessRunner({
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: (() => createRpcProcess((request, child) => {
        emitJson(child, { type: 'response', command: 'prompt', success: true, id: request.id });
        emitJson(child, {
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '401 Incorrect API key provided: sk-planner-secret',
          }],
          willRetry: false,
        });
      }) as never) as never,
    });

    const error = await runner.run('hello', {
      timeoutMs: 1000,
      request: { sessionId: 'session-model-error', source: 'gateway' },
    } as never, 'kernel').catch(reason => reason as Error);

    expect(error.message).toContain('Planner model failed');
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('planner-secret');
    expect(error.message).not.toContain('without an accepted submit_planning_proposal');
  });
});
