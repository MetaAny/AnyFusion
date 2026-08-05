import type Database from 'better-sqlite3';
import type { PlannerProposalResult } from '../planning/planner-proposal.js';

type FinalProposalResult = Extract<PlannerProposalResult, { status: 'accepted' | 'rejected' }>;

export interface PlannerProposalSubmissionRecord {
  sessionId: string;
  turnId: string;
  submissionId: string;
  planFingerprint: string;
  planId: string | null;
  eventId: string | null;
  status: 'submitting' | 'uncertain' | 'accepted' | 'rejected';
  result: FinalProposalResult | null;
}

export type PlannerProposalReservation =
  | { kind: 'reserved' }
  | { kind: 'replay'; result: FinalProposalResult }
  | { kind: 'in_flight'; eventId: string | null; status: 'submitting' | 'uncertain' }
  | { kind: 'conflict'; acceptedSubmissionId: string | null };

interface TurnRow {
  user_input: string;
  accepted_submission_id: string | null;
}

interface SubmissionRow {
  session_id: string;
  turn_id: string;
  submission_id: string;
  plan_fingerprint: string;
  plan_id: string | null;
  event_id: string | null;
  status: PlannerProposalSubmissionRecord['status'];
  result_json: string | null;
}

export class PlannerProposalRepo {
  constructor(private readonly db: Database.Database) {}

  ensureTurn(sessionId: string, turnId: string, userInput: string): { created: boolean; conflict: boolean } {
    return this.db.transaction(() => {
      const existing = this.findTurn(sessionId, turnId);
      if (existing) {
        return { created: false, conflict: existing.user_input !== userInput };
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO planner_proposal_turns (
          session_id, turn_id, user_input, accepted_submission_id, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?)
      `).run(sessionId, turnId, userInput, now, now);
      return { created: true, conflict: false };
    })();
  }

  reserveSubmission(input: {
    sessionId: string;
    turnId: string;
    submissionId: string;
    planFingerprint: string;
    planId: string | null;
    eventId: string | null;
  }): PlannerProposalReservation {
    return this.db.transaction(() => {
      const turn = this.findTurn(input.sessionId, input.turnId);
      if (!turn) throw new Error(`Planner proposal turn not found: ${input.sessionId}/${input.turnId}`);

      const existing = this.findSubmission(input.sessionId, input.turnId, input.submissionId);
      if (turn.accepted_submission_id && turn.accepted_submission_id !== input.submissionId) {
        return { kind: 'conflict', acceptedSubmissionId: turn.accepted_submission_id } as const;
      }
      if (existing) {
        if (
          existing.planFingerprint !== input.planFingerprint
          || existing.planId !== input.planId
          || existing.eventId !== input.eventId
        ) {
          return { kind: 'conflict', acceptedSubmissionId: turn.accepted_submission_id } as const;
        }
        if (existing.result) return { kind: 'replay', result: existing.result } as const;
        if (existing.status !== 'submitting' && existing.status !== 'uncertain') {
          throw new Error(`Planner proposal ${existing.submissionId} has terminal status without a result`);
        }
        return { kind: 'in_flight', eventId: existing.eventId, status: existing.status } as const;
      }

      if (turn.accepted_submission_id) {
        return { kind: 'conflict', acceptedSubmissionId: turn.accepted_submission_id } as const;
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO planner_proposal_submissions (
          session_id, turn_id, submission_id, plan_fingerprint, plan_id, event_id,
          status, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'submitting', NULL, ?, ?)
      `).run(
        input.sessionId, input.turnId, input.submissionId, input.planFingerprint,
        input.planId, input.eventId, now, now,
      );
      return { kind: 'reserved' } as const;
    })();
  }

  getSubmission(sessionId: string, turnId: string, submissionId: string): PlannerProposalSubmissionRecord | null {
    return this.findSubmission(sessionId, turnId, submissionId);
  }

  markUncertain(sessionId: string, turnId: string, submissionId: string): void {
    this.db.prepare(`
      UPDATE planner_proposal_submissions
      SET status = 'uncertain', updated_at = ?
      WHERE session_id = ? AND turn_id = ? AND submission_id = ?
        AND status IN ('submitting', 'uncertain')
    `).run(new Date().toISOString(), sessionId, turnId, submissionId);
  }

  completeSubmission(
    sessionId: string,
    turnId: string,
    submissionId: string,
    result: FinalProposalResult,
  ): void {
    this.db.transaction(() => {
      const turn = this.findTurn(sessionId, turnId);
      if (!turn) throw new Error(`Planner proposal turn not found: ${sessionId}/${turnId}`);
      if (result.status === 'accepted'
        && turn.accepted_submission_id
        && turn.accepted_submission_id !== submissionId) {
        throw new Error(`Planner proposal turn already accepted by ${turn.accepted_submission_id}`);
      }
      const now = new Date().toISOString();
      const updated = this.db.prepare(`
        UPDATE planner_proposal_submissions
        SET status = ?, result_json = ?, updated_at = ?
        WHERE session_id = ? AND turn_id = ? AND submission_id = ?
      `).run(result.status, JSON.stringify(result), now, sessionId, turnId, submissionId);
      if (updated.changes !== 1) {
        throw new Error(`Planner proposal submission not found: ${sessionId}/${turnId}/${submissionId}`);
      }
      if (result.status === 'accepted') {
        this.db.prepare(`
          UPDATE planner_proposal_turns
          SET accepted_submission_id = ?, updated_at = ?
          WHERE session_id = ? AND turn_id = ?
        `).run(submissionId, now, sessionId, turnId);
      } else {
        this.db.prepare(`
          UPDATE planner_proposal_turns SET updated_at = ?
          WHERE session_id = ? AND turn_id = ?
        `).run(now, sessionId, turnId);
      }
    })();
  }

  private findTurn(sessionId: string, turnId: string): TurnRow | null {
    return (this.db.prepare(`
      SELECT user_input, accepted_submission_id
      FROM planner_proposal_turns WHERE session_id = ? AND turn_id = ?
    `).get(sessionId, turnId) as TurnRow | undefined) ?? null;
  }

  private findSubmission(
    sessionId: string,
    turnId: string,
    submissionId: string,
  ): PlannerProposalSubmissionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM planner_proposal_submissions
      WHERE session_id = ? AND turn_id = ? AND submission_id = ?
    `).get(sessionId, turnId, submissionId) as SubmissionRow | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      turnId: row.turn_id,
      submissionId: row.submission_id,
      planFingerprint: row.plan_fingerprint,
      planId: row.plan_id,
      eventId: row.event_id,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) as FinalProposalResult : null,
    };
  }
}
