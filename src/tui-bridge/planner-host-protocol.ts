import type { CommandCompletion } from '../commands/catalog.js';
import type { PlannerProposalPurpose, PlannerProposalResult } from '../planning/planner-proposal.js';

export const ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION = 2 as const;
export const ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES = 1_048_576;

export type PlannerHostMode = 'interactive' | 'rpc';

export type PlannerHostRequest =
  | { protocolVersion: 2; type: 'hello'; requestId: string; runtimeVersion: string; sessionId: string; mode: PlannerHostMode }
  | { protocolVersion: 2; type: 'ping'; requestId: string }
  | { protocolVersion: 2; type: 'snapshot_get'; requestId: string }
  | { protocolVersion: 2; type: 'snapshot_subscribe'; requestId: string }
  | { protocolVersion: 2; type: 'command_complete'; requestId: string; text: string; cursor: number }
  | { protocolVersion: 2; type: 'command_submit'; requestId: string; command: string }
  | {
      protocolVersion: 2;
      type: 'proposal_submit';
      requestId: string;
      turnId: string;
      sessionId: string;
      userInput: string;
      submissionId: string;
      purpose: PlannerProposalPurpose;
      plan: unknown;
    }
  | { protocolVersion: 2; type: 'shutdown'; requestId: string };

export type PlannerHostMessage<TSnapshot = unknown> =
  | {
      protocolVersion: 2;
      type: 'hello';
      requestId: string;
      accepted: true;
      capabilities: string[];
    }
  | { protocolVersion: 2; type: 'pong'; requestId: string }
  | { protocolVersion: 2; type: 'snapshot'; requestId: string | null; snapshot: TSnapshot }
  | { protocolVersion: 2; type: 'subscribed'; requestId: string }
  | { protocolVersion: 2; type: 'command_completion'; requestId: string; completion: CommandCompletion }
  | {
      protocolVersion: 2;
      type: 'command_result';
      requestId: string;
      accepted: true;
      exitRequested: boolean;
      output: string[];
    }
  | {
      protocolVersion: 2;
      type: 'command_result';
      requestId: string;
      accepted: false;
      error: { code: string; message: string; details?: string[] };
    }
  | {
      protocolVersion: 2;
      type: 'proposal_result';
      requestId: string;
      result: PlannerProposalResult;
    }
  | { protocolVersion: 2; type: 'shutdown'; requestId: string; accepted: true }
  | {
      protocolVersion: 2;
      type: 'error';
      requestId: string | null;
      error: { code: string; message: string; details?: string[] };
    };

export function isPlannerHostRequest(value: unknown): value is PlannerHostRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { protocolVersion?: unknown; type?: unknown; requestId?: unknown };
  if (candidate.protocolVersion !== ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION) return false;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return false;
  if (candidate.type === 'command_complete') {
    const request = value as { text?: unknown; cursor?: unknown };
    return typeof request.text === 'string'
      && request.text.startsWith('/')
      && Number.isInteger(request.cursor)
      && (request.cursor as number) >= 0
      && (request.cursor as number) <= request.text.length;
  }
  if (candidate.type === 'command_submit') {
    const command = (value as { command?: unknown }).command;
    return typeof command === 'string' && /^\/\S/u.test(command.trim());
  }
  if (candidate.type === 'proposal_submit') {
    const request = value as {
      turnId?: unknown; sessionId?: unknown; userInput?: unknown;
      submissionId?: unknown; purpose?: unknown; plan?: unknown;
    };
    return typeof request.turnId === 'string' && request.turnId.length > 0
      && typeof request.sessionId === 'string' && request.sessionId.length > 0
      && typeof request.userInput === 'string' && request.userInput.trim().length > 0
      && typeof request.submissionId === 'string' && request.submissionId.length > 0
      && (request.purpose === 'kernel' || request.purpose === 'validation')
      && request.plan !== undefined;
  }
  return candidate.type === 'hello'
    || candidate.type === 'ping'
    || candidate.type === 'snapshot_get'
    || candidate.type === 'snapshot_subscribe'
    || candidate.type === 'proposal_submit'
    || candidate.type === 'shutdown';
}
