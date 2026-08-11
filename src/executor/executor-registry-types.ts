import type { AgentClass, AgentClassRiskLevel } from '../core/types.js';
import type { KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';

export const EXECUTOR_DRIVER_IDS = ['codex', 'pi', 'hermes', 'cli-session'] as const;
export type ExecutorDriverId = typeof EXECUTOR_DRIVER_IDS[number];

export const EXECUTOR_AFFORDANCE_IDS = [
  'public-web-fetch',
  'public-web-search',
  'source-citation',
  'workspace-command-validation',
  'workspace-read-write',
] as const;
export type ExecutorAffordanceId = typeof EXECUTOR_AFFORDANCE_IDS[number];

export type ExecutorRecoverySafety = 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent';
export type ExecutorPermissionProfileId = 'workspace-engineering' | 'public-web-research' | 'restricted-custom';

export interface ExecutorCapabilityDefinition {
  id: string;
  deliveryContract: string;
  requiredAffordances: ExecutorAffordanceId[];
  recoverySafety: ExecutorRecoverySafety;
  minimumPermissionProfile: ExecutorPermissionProfileId;
}

export interface ExecutorProfileDefinition {
  id: string;
  displayName: string;
  discoveryCommands: string[];
  driver: ExecutorDriverId;
  defaultDescription: string;
  suggestedCapabilities: string[];
}

export interface CliSessionProtocol {
  initialArgs: string[];
  resumeArgs: string[];
  sessionIdPattern: string;
  finalOutputPattern: string | null;
  timeoutMs: number;
  terminateSignal: 'SIGTERM' | 'SIGINT';
}

export interface ExecutorInstallationBinding {
  binaryPath: string;
  versionArgs: string[];
  versionPattern: string;
  driver: ExecutorDriverId;
  runtimeHome: string;
  environmentFiles: string[];
  inheritEnvironment: string[];
  effectivePermissionProfile: ExecutorPermissionProfileId;
  sessionProtocol: CliSessionProtocol | null;
}

export interface ExecutorDefinition {
  id: string;
  profileId: string | null;
  description: string;
  capabilities: string[];
  primaryUseCases: string[];
  enabled: boolean;
  binding: ExecutorInstallationBinding;
  strengths: string[];
  weaknesses: string[];
  riskLevel: AgentClassRiskLevel;
  domains: string[];
  inputTypes: string[];
  outputTypes: string[];
  avoidUseCases: string[];
  affinity: Record<string, number>;
}

export interface ExecutorRegistryConfig {
  schemaVersion: 1;
  capabilities: ExecutorCapabilityDefinition[];
  profiles: ExecutorProfileDefinition[];
  executors: ExecutorDefinition[];
}

export interface ExecutorVerification {
  executorId: string;
  configDigest: string;
  binaryPath: string;
  binaryPathDigest: string;
  version: string;
  driver: ExecutorDriverId;
  verifiedAt: string;
  success: boolean;
  result: Record<string, unknown>;
}

export interface PlannerRoutingCapabilityDefinition {
  id: string;
  deliveryContract: string;
}

export interface PlannerExecutorCatalogEntry {
  name: string;
  description: string;
  routingCapabilities: string[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  affordances: ExecutorAffordanceId[];
}

export interface PlannerExecutorCatalog {
  version: 3;
  configDigest: string;
  capabilities: PlannerRoutingCapabilityDefinition[];
  executors: PlannerExecutorCatalogEntry[];
}

export interface KernelExecutorRegistryProjection {
  configDigest: string;
  candidates: Array<{
    id: string;
    capabilities: string[];
    health: KernelExecutorStatusProjection['classHealth'];
  }>;
}

export interface RuntimeExecutorBinding {
  id: string;
  configDigest: string;
  driver: ExecutorDriverId;
  supportsSessionResume: boolean;
  evidenceAffordance: 'metaclaw-tools' | 'none';
  resultCollector: 'result-file' | 'stdout' | 'pattern';
  homeMaterializer: 'codex-config' | 'pi-config' | 'hermes-config' | 'empty';
  binaryPath: string;
  versionArgs: string[];
  runtimeHome: string;
  environmentFiles: string[];
  inheritEnvironment: string[];
  permissionProfileId: ExecutorPermissionProfileId;
  sessionProtocol: CliSessionProtocol | null;
}

export function runtimeContractForDriver(
  driver: ExecutorDriverId,
  sessionProtocol: CliSessionProtocol | null,
): Pick<
  RuntimeExecutorBinding,
  'supportsSessionResume' | 'evidenceAffordance' | 'resultCollector' | 'homeMaterializer'
> {
  if (driver === 'codex') {
    return {
      supportsSessionResume: true,
      evidenceAffordance: 'metaclaw-tools',
      resultCollector: 'result-file',
      homeMaterializer: 'codex-config',
    };
  }
  if (driver === 'pi') {
    return {
      supportsSessionResume: true,
      evidenceAffordance: 'metaclaw-tools',
      resultCollector: 'stdout',
      homeMaterializer: 'pi-config',
    };
  }
  if (driver === 'hermes') {
    return {
      supportsSessionResume: true,
      evidenceAffordance: 'none',
      resultCollector: 'stdout',
      homeMaterializer: 'hermes-config',
    };
  }
  return {
    supportsSessionResume: Boolean(sessionProtocol),
    evidenceAffordance: 'none',
    resultCollector: sessionProtocol?.finalOutputPattern ? 'pattern' : 'stdout',
    homeMaterializer: 'empty',
  };
}

export interface TuiExecutorRegistryEntry {
  id: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  verification: 'verified' | 'unverified' | 'stale' | 'failed';
  error: string | null;
  capabilities: string[];
  driver: ExecutorDriverId;
  binaryPath: string;
  verifiedAt: string | null;
}

/** Read-only Registry facts that may cross the Planner host seam. */
export interface PlannerExecutorRegistryProjection {
  configDigest: string;
  planner: PlannerExecutorCatalog;
  tui: readonly TuiExecutorRegistryEntry[];
}

export interface ExecutorRegistrySnapshot {
  schemaVersion: 1;
  configDigest: string;
  loadedAt: string;
  configPath: string;
  capabilities: ReadonlyMap<string, Readonly<ExecutorCapabilityDefinition>>;
  profiles: ReadonlyMap<string, Readonly<ExecutorProfileDefinition>>;
  executors: ReadonlyMap<string, Readonly<ExecutorDefinition>>;
  verifications: ReadonlyMap<string, Readonly<ExecutorVerification>>;
  tui: readonly TuiExecutorRegistryEntry[];
  planner: PlannerExecutorCatalog;
  kernel: KernelExecutorRegistryProjection;
  runtime: ReadonlyMap<string, Readonly<RuntimeExecutorBinding>>;
}

export function executorToAgentClass(executor: ExecutorDefinition): AgentClass {
  return {
    name: executor.id,
    kind: 'executor',
    domains: [...executor.domains],
    capabilities: [...executor.capabilities],
    inputTypes: [...executor.inputTypes],
    outputTypes: [...executor.outputTypes],
    strengths: [...executor.strengths],
    weaknesses: [...executor.weaknesses],
    primaryUseCases: [...executor.primaryUseCases],
    avoidUseCases: [...executor.avoidUseCases],
    intentAffinity: { ...executor.affinity },
    riskLevel: executor.riskLevel,
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: executor.binding.binaryPath,
    runtimeArgs: [],
    runtimeCheckCommand: [executor.binding.binaryPath, ...executor.binding.versionArgs].join(' '),
    permissionProfileId: executor.binding.effectivePermissionProfile,
    projectUrl: null,
  };
}
