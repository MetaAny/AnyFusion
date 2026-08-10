// Compatibility facade for consumers that still use the AgentClass value shape.
// Static executor definitions come only from the active registry snapshot.
import type Database from 'better-sqlite3';
import type { AgentClass, AgentClassKind } from '../core/types.js';
import { ExecutorVerificationRepo } from '../storage/executor-verification-repo.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { ExecutorRegistryService } from './executor-registry-service.js';
import { executorToAgentClass, type ExecutorRegistrySnapshot } from './executor-registry-types.js';

export interface AgentClassServiceDeps {
  db?: Database.Database;
  registry?: ExecutorRegistryService;
  snapshot?: () => ExecutorRegistrySnapshot;
}

export class AgentClassService {
  private readonly snapshot: () => ExecutorRegistrySnapshot;

  constructor(deps: AgentClassServiceDeps) {
    if (deps.snapshot) {
      this.snapshot = deps.snapshot;
      return;
    }
    const registry = deps.registry ?? new ExecutorRegistryService({
      verificationRepo: new ExecutorVerificationRepo(requireDb(deps.db)),
      statusRepo: new KernelExecutorStatusRepo(requireDb(deps.db)),
    });
    this.snapshot = () => registry.current();
  }

  seedDefaults(): void {
    // Executor definitions are no longer seeded into SQLite.
  }

  listAgentClasses(): AgentClass[] {
    return [...this.snapshot().executors.values()].map(executorToAgentClass);
  }

  listByKind(kind: AgentClassKind): AgentClass[] {
    return kind === 'executor' ? this.listAgentClasses() : [];
  }

  findByName(name: string): AgentClass | null {
    const executor = this.snapshot().executors.get(name);
    return executor ? executorToAgentClass(executor) : null;
  }

  deriveRecoverySafety(
    requiredCapabilities: readonly string[],
  ): 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent' {
    let safety: 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent' = 'read_only';
    for (const capabilityId of requiredCapabilities) {
      const capability = this.snapshot().capabilities.get(capabilityId);
      if (!capability || capability.recoverySafety === 'external_non_idempotent') {
        return 'external_non_idempotent';
      }
      if (capability.recoverySafety === 'workspace_reconcilable') safety = 'workspace_reconcilable';
    }
    return safety;
  }

  supportsExecutionEvidence(executorId: string): boolean {
    const snapshot = this.snapshot();
    const executor = snapshot.executors.get(executorId);
    if (!executor) return false;
    return executor.capabilities.some(capabilityId => (
      snapshot.capabilities.get(capabilityId)?.requiredAffordances.some(
        affordance => affordance === 'workspace-read-write'
          || affordance === 'public-web-search'
          || affordance === 'public-web-fetch',
      ) === true
    ));
  }

  setResolvedImageId(): void {
    // Docker image resolution is now part of a verified Runtime binding.
  }

  upsert(_agentClass: AgentClass): never {
    throw new Error('Executor definitions must be registered through executors.yaml');
  }
}

function requireDb(db: Database.Database | undefined): Database.Database {
  if (!db) throw new Error('AgentClassService requires db or registry snapshot');
  return db;
}
