import type { PlanningContext } from './planning-types.js';

export interface PlanningContextBuilderDeps {
  sessionId: string;
  requestSource: string;
  getTimeoutMs(): number;
  getExecutorCatalog(): PlanningContext['executorCatalog'];
}

export class PlanningContextBuilder {
  constructor(private readonly deps: PlanningContextBuilderDeps) {}

  getExecutorCatalog(): PlanningContext['executorCatalog'] {
    return this.deps.getExecutorCatalog();
  }

  build(input: {
    userInput: string;
    pendingAuthorizationRequest?: PlanningContext['pendingAuthorizationRequest'];
  }): PlanningContext {
    return {
      userInput: input.userInput,
      request: {
        sessionId: this.deps.sessionId,
        source: this.deps.requestSource,
      },
      pendingAuthorizationRequest: input.pendingAuthorizationRequest ?? null,
      executorCatalog: this.getExecutorCatalog(),
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}
