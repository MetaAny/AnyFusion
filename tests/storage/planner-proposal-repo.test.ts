import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PlannerProposalRepo } from '../../src/storage/planner-proposal-repo.js';

describe('PlannerProposalRepo', () => {
  it('records one user turn and replays the same accepted submission', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new PlannerProposalRepo(db);

    expect(repo.ensureTurn('sess_1', 'turn_1', 'hello')).toEqual({ created: true, conflict: false });
    expect(repo.ensureTurn('sess_1', 'turn_1', 'hello')).toEqual({ created: false, conflict: false });

    const reservation = repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_1',
      planFingerprint: 'fingerprint_1', planId: 'plan_1', eventId: 'event_1',
    });
    expect(reservation.kind).toBe('reserved');

    const result = {
      status: 'accepted' as const, turnId: 'turn_1', submissionId: 'sub_1', planId: 'plan_1',
      outcome: 'direct_reply_delivered' as const, displayText: 'hello', taskId: null,
      kernel: { decisionId: 'decision_1', action: 'deliver_direct_reply' as const, reason: 'reply' },
    };
    repo.completeSubmission('sess_1', 'turn_1', 'sub_1', result);

    expect(repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_1',
      planFingerprint: 'fingerprint_1', planId: 'plan_1', eventId: 'event_1',
    })).toEqual({ kind: 'replay', result });
    expect(repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_2',
      planFingerprint: 'fingerprint_2', planId: 'plan_2', eventId: 'event_2',
    })).toEqual({ kind: 'conflict', acceptedSubmissionId: 'sub_1' });
  });

  it('allows a revised submission after a rejection while replaying the rejected revision', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new PlannerProposalRepo(db);
    repo.ensureTurn('sess_1', 'turn_1', 'hello');
    repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_bad',
      planFingerprint: 'bad', planId: null, eventId: null,
    });
    const rejected = {
      status: 'rejected' as const, turnId: 'turn_1', submissionId: 'sub_bad', planId: null,
      rejectionType: 'validation' as const, issues: ['bad schema'], kernel: null,
    };
    repo.completeSubmission('sess_1', 'turn_1', 'sub_bad', rejected);

    expect(repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_bad',
      planFingerprint: 'bad', planId: null, eventId: null,
    })).toEqual({ kind: 'replay', result: rejected });
    expect(repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_fixed',
      planFingerprint: 'fixed', planId: 'plan_fixed', eventId: 'event_fixed',
    }).kind).toBe('reserved');
  });

  it('reports an in-flight matching submission separately from a different fingerprint conflict', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new PlannerProposalRepo(db);
    repo.ensureTurn('sess_1', 'turn_1', 'hello');
    repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_1',
      planFingerprint: 'fingerprint_1', planId: 'plan_1', eventId: 'event_1',
    });

    expect(repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_1',
      planFingerprint: 'fingerprint_1', planId: 'plan_1', eventId: 'event_1',
    })).toMatchObject({ kind: 'in_flight', eventId: 'event_1' });
    expect(repo.reserveSubmission({
      sessionId: 'sess_1', turnId: 'turn_1', submissionId: 'sub_1',
      planFingerprint: 'different', planId: 'plan_1', eventId: 'event_1',
    })).toEqual({ kind: 'conflict', acceptedSubmissionId: null });
  });
});
