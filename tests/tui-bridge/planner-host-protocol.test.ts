import { describe, expect, it } from 'vitest';
import { isPlannerHostRequest } from '../../src/tui-bridge/planner-host-protocol.js';

describe('AnyFusionPlannerHostProtocol v2', () => {
  it('accepts runtime-correlated proposal requests and rejects identity drift', () => {
    expect(isPlannerHostRequest({
      protocolVersion: 2,
      type: 'proposal_submit',
      requestId: 'request-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      userInput: 'create task',
      submissionId: 'proposal-1',
      purpose: 'kernel',
      plan: {},
    })).toBe(true);
    expect(isPlannerHostRequest({
      protocolVersion: 2,
      type: 'proposal_submit',
      requestId: 'request-2',
      turnId: 'turn-2',
      sessionId: 'session-1',
      userInput: 'create task',
      plan: {},
    })).toBe(false);
    expect(isPlannerHostRequest({
      protocolVersion: 2,
      type: 'proposal_submit',
      requestId: 'request-3',
      turnId: 'turn-3',
      sessionId: 'session-1',
      userInput: 'create task',
      submissionId: 'proposal-3',
      purpose: 'repair',
      plan: {},
    })).toBe(false);
  });

  it('keeps command validation and rejects the retired protocol', () => {
    expect(isPlannerHostRequest({
      protocolVersion: 2, type: 'command_complete', requestId: 'complete-1', text: '/task ', cursor: 6,
    })).toBe(true);
    expect(isPlannerHostRequest({
      protocolVersion: 2, type: 'command_complete', requestId: 'complete-invalid', text: '/task', cursor: 99,
    })).toBe(false);
    expect(isPlannerHostRequest({
      protocolVersion: 2, type: 'command_submit', requestId: 'command-1', command: '/help',
    })).toBe(true);
    expect(isPlannerHostRequest({ protocolVersion: 1, type: 'ping', requestId: 'retired' })).toBe(false);
  });
});
