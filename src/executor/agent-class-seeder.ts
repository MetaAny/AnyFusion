import type { WorkUnitRepo } from '../storage/work-unit-repo.js';

export function seedDefaultWorkUnits(
  workUnitRepo: Pick<WorkUnitRepo, 'upsert' | 'findById'>,
): void {
  const now = new Date().toISOString();
  if (!workUnitRepo.findById('planner-1')) {
    workUnitRepo.upsert({
      id: 'planner-1',
      agentClassName: 'planner',
      agentClassKind: 'planner',
      state: 'idle',
      claimedTaskId: null,
      claimedSubtaskId: null,
      claimedAttemptId: null,
      heartbeatAt: now,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}
