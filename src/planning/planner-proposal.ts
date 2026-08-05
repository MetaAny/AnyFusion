import { createHash } from 'node:crypto';
import type { KernelDecisionAction } from '../kernel/control-kernel.js';

export type PlannerProposalPurpose = 'kernel' | 'validation';

export type PlannerProposalAcceptedOutcome =
  | 'proposal_validated'
  | 'task_authorized'
  | 'task_control_authorized'
  | 'direct_reply_delivered'
  | 'clarification_requested'
  | 'authorization_recorded'
  | 'no_action';

export type PlannerProposalResult =
  | {
      status: 'accepted';
      turnId: string;
      submissionId: string;
      planId: string;
      outcome: PlannerProposalAcceptedOutcome;
      displayText: string;
      taskId: string | null;
      kernel: { decisionId: string; action: KernelDecisionAction['type']; reason: string } | null;
    }
  | {
      status: 'rejected';
      turnId: string;
      submissionId: string;
      planId: string | null;
      rejectionType: 'validation' | 'kernel';
      issues: string[];
      kernel: { decisionId: string; action: 'reject_request'; reason: string } | null;
    }
  | {
      status: 'conflict';
      turnId: string;
      submissionId: string;
      acceptedSubmissionId: string | null;
      message: string;
    }
  | {
      status: 'transport_uncertain';
      turnId: string;
      submissionId: string;
      retryableByReplay: true;
      message: string;
    };

export interface PlannerProposalSubmission {
  sessionId: string;
  turnId: string;
  userInput: string;
  submissionId: string;
  plan: unknown;
  runtimeMode?: 'interactive' | 'rpc' | 'session';
}

export function plannerProposalFingerprint(plan: unknown): string {
  return createHash('sha256').update(stableJson(plan)).digest('hex');
}

export function createPlannerProposalSubmissionId(
  sessionId: string,
  turnId: string,
  plan: unknown,
): string {
  return `proposal_${createHash('sha256')
    .update(`${sessionId}\n${turnId}\n${stableJson(plan)}`)
    .digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
