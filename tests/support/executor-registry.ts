import { createTestExecutorRegistrySnapshot } from '../../src/executor/test-executor-registry.js';
import {
  executorToAgentClass,
  type PlannerExecutorCatalog,
} from '../../src/executor/executor-registry-types.js';

export function testPlannerExecutorCatalog(): PlannerExecutorCatalog {
  return structuredClone(createTestExecutorRegistrySnapshot().planner);
}

export function testExecutorAgentClasses() {
  return [...createTestExecutorRegistrySnapshot().executors.values()].map(executorToAgentClass);
}
