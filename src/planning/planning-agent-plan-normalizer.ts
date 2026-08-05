function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonicalizes representation-only differences at the MetaClaw Planner intake
 * boundary. Submission identity continues to use the unmodified wire payload.
 */
export function normalizePlanningAgentPlanInput(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.task)) return value;
  const taskId = value.task.taskId;
  if (typeof taskId !== 'string' || taskId.trim().length > 0) return value;
  return {
    ...value,
    task: {
      ...value.task,
      taskId: null,
    },
  };
}
