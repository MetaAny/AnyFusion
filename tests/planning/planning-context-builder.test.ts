import { describe, expect, it } from 'vitest';
import { PlanningContextBuilder } from '../../src/planning/planning-context-builder.js';
import { testPlannerExecutorCatalog } from '../support/executor-registry.js';

describe('PlanningContextBuilder', () => {
  it('builds host metadata without model dialogue or injected domain facts', () => {
    const context = new PlanningContextBuilder({
      sessionId: 'sess_minimal',
      requestSource: 'interactive',
      getTimeoutMs: () => 5_000,
      getExecutorCatalog: testPlannerExecutorCatalog,
    }).build({ userInput: 'continue' });

    expect(context).toEqual({
      userInput: 'continue',
      request: { sessionId: 'sess_minimal', source: 'interactive' },
      pendingAuthorizationRequest: null,
      executorCatalog: testPlannerExecutorCatalog(),
      timeoutMs: 5_000,
    });
    expect(context).not.toHaveProperty('recentTasks');
    expect(context).not.toHaveProperty('agentClasses');
    expect(context).not.toHaveProperty('ruleHints');
    expect(context).not.toHaveProperty('currentFocus');
    expect(context).not.toHaveProperty('initialContext');
    expect(context).not.toHaveProperty('permissions');
    expect(JSON.stringify(context.executorCatalog)).not.toMatch(
      /nativeAffordances|requiredAffordances|agentClassDefaults|adapterBinding|runtimeCommand|historicalSuccess/,
    );
  });
});
