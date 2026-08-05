import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannerProposalResult, PlannerProposalSubmission } from '../../src/planning/planner-proposal.js';
import type { PlannerTuiSnapshot, SessionSnapshot } from '../../src/session/metaclaw-session.js';
import { PlannerTuiBridge, type PlannerTuiBridgeSession } from '../../src/tui-bridge/planner-tui-bridge.js';

class FakeSession implements PlannerTuiBridgeSession {
  readonly submitPlannerProposal = vi.fn(async (submission: PlannerProposalSubmission): Promise<PlannerProposalResult> => ({
    status: 'accepted',
    turnId: submission.turnId,
    submissionId: submission.submissionId,
    planId: 'plan-1',
    outcome: 'direct_reply_delivered',
    displayText: 'authoritative reply',
    taskId: null,
    kernel: { decisionId: 'decision-1', action: 'deliver_direct_reply', reason: 'reply' },
  }));

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    listener({
      output: [], currentTaskId: null, currentTask: null,
      runtimeState: {
        runningTaskId: null, runningExecutorName: null, readyTaskIds: [], blockedTaskIds: [],
        parkedTaskIds: [], lastEvent: 'idle',
      },
      plannerState: { status: 'idle' }, latestGuidance: null,
    });
    return () => undefined;
  }

  getPlannerTuiSnapshot(): PlannerTuiSnapshot {
    return {
      schemaVersion: 1,
      session: {
        id: 'session-1', focusedTask: null,
        runtimeState: {
          runningTaskId: null, runningExecutorName: null, readyTaskIds: [], blockedTaskIds: [],
          parkedTaskIds: [], lastEvent: 'idle',
        },
        plannerState: { status: 'idle' }, recentOutput: [],
      },
      taskPool: [], executorStatuses: [],
    };
  }

  completeCommand(text: string, cursor = text.length) {
    return {
      state: 'incomplete' as const,
      suggestions: [{
        value: 'list', label: 'list', description: 'List tasks',
        replacement: { start: 6, end: cursor, text: 'list' },
      }],
      hint: '/task <list|show>', error: null,
    };
  }

  async submitPlannerTuiCommand(command: string) {
    return { exitRequested: false, output: [`> ${command}`] };
  }
}

const bridges: PlannerTuiBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
});

describe('PlannerTuiBridge shared Proposal Host', () => {
  it('binds hello to a registered session and returns the structured authoritative result', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}.sock`);
    const session = new FakeSession();
    const bridge = new PlannerTuiBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'rpc' });
    expect(await read(socket)).toMatchObject({ type: 'hello', accepted: true });
    write(socket, {
      protocolVersion: 2, type: 'proposal_submit', requestId: 'proposal-1',
      turnId: 'turn-1', sessionId: 'session-1', userInput: 'hello',
      submissionId: 'submission-1', purpose: 'kernel', plan: { schemaVersion: 7 },
    });

    expect(await read(socket)).toMatchObject({
      type: 'proposal_result',
      result: { status: 'accepted', submissionId: 'submission-1', displayText: 'authoritative reply' },
    });
    expect(session.submitPlannerProposal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', turnId: 'turn-1', runtimeMode: 'rpc',
    }), 'kernel');
    socket.destroy();
  });

  it('requires hello and rejects proposal session drift', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-drift.sock`);
    const bridge = new PlannerTuiBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', new FakeSession());
    await bridge.start();
    const socket = await connect(socketPath);
    write(socket, { protocolVersion: 2, type: 'ping', requestId: 'ping-1' });
    expect(await read(socket)).toMatchObject({ type: 'error', error: { code: 'hello_required' } });
    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'interactive' });
    await read(socket);
    write(socket, {
      protocolVersion: 2, type: 'proposal_submit', requestId: 'proposal-1',
      turnId: 'turn-1', sessionId: 'session-2', userInput: 'hello',
      submissionId: 'submission-1', purpose: 'kernel', plan: {},
    });
    expect(await read(socket)).toMatchObject({ type: 'error', error: { code: 'session_mismatch' } });
    socket.destroy();
  });

  it('fails closed when hello names an unregistered session', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-unknown.sock`);
    const registered = new FakeSession();
    const bridge = new PlannerTuiBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', registered);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, {
      protocolVersion: 2, type: 'hello', requestId: 'hello-unknown', runtimeVersion: 'test',
      sessionId: 'session-2', mode: 'rpc',
    });

    expect(await read(socket)).toMatchObject({
      type: 'error', requestId: 'hello-unknown', error: { code: 'unknown_session' },
    });
    expect(registered.submitPlannerProposal).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('returns transport_uncertain when the authoritative session submission throws', async () => {
    const socketPath = join(tmpdir(), `planner-host-${process.pid}-${Date.now()}-uncertain.sock`);
    const session = new FakeSession();
    session.submitPlannerProposal.mockRejectedValueOnce(new Error('kernel connection lost'));
    const bridge = new PlannerTuiBridge({ socketPath });
    bridges.push(bridge);
    bridge.registerSession('session-1', session);
    await bridge.start();
    const socket = await connect(socketPath);

    write(socket, { protocolVersion: 2, type: 'hello', requestId: 'hello-1', runtimeVersion: 'test', sessionId: 'session-1', mode: 'rpc' });
    await read(socket);
    write(socket, {
      protocolVersion: 2, type: 'proposal_submit', requestId: 'proposal-1',
      turnId: 'turn-1', sessionId: 'session-1', userInput: 'hello',
      submissionId: 'submission-1', purpose: 'kernel', plan: { schemaVersion: 7 },
    });

    expect(await read(socket)).toMatchObject({
      type: 'proposal_result',
      result: {
        status: 'transport_uncertain', turnId: 'turn-1', submissionId: 'submission-1',
        retryableByReplay: true, message: 'kernel connection lost',
      },
    });
    socket.destroy();
  });
});

async function connect(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  return socket;
}

function write(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function read(socket: Socket): Promise<Record<string, unknown>> {
  const [chunk] = await once(socket, 'data');
  return JSON.parse(String(chunk).trim()) as Record<string, unknown>;
}
