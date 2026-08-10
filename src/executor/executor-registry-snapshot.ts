import type { KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';
import {
  type ExecutorRegistryConfig,
  type ExecutorRegistrySnapshot,
  type ExecutorVerification,
  type PlannerExecutorCatalog,
  runtimeContractForDriver,
} from './executor-registry-types.js';
import { verificationMatches } from './executor-registry-config.js';

export function createExecutorRegistrySnapshot(input: {
  configPath: string;
  configDigest: string;
  config: ExecutorRegistryConfig;
  verifications: ExecutorVerification[];
  statuses?: KernelExecutorStatusProjection[];
  loadedAt?: string;
}): ExecutorRegistrySnapshot {
  const capabilities = new Map(input.config.capabilities.map(item => [item.id, freezeClone(item)]));
  const profiles = new Map(input.config.profiles.map(item => [item.id, freezeClone(item)]));
  const executors = new Map(input.config.executors.map(item => [item.id, freezeClone(item)]));
  const matchingVerifications = new Map<string, ExecutorVerification>();
  const latestByExecutor = new Map<string, ExecutorVerification>();
  for (const verification of input.verifications) {
    if (!latestByExecutor.has(verification.executorId)) latestByExecutor.set(verification.executorId, verification);
    const executor = executors.get(verification.executorId);
    if (executor && verificationMatches(
      verification,
      input.configDigest,
      executor.binding.binaryPath,
      executor.binding.driver,
    )) {
      matchingVerifications.set(verification.executorId, freezeClone(verification));
    }
  }
  const statuses = new Map((input.statuses ?? []).map(status => [status.agentClassName, status]));
  const routable = [...executors.values()]
    .filter(executor => executor.enabled && matchingVerifications.has(executor.id));
  const planner: PlannerExecutorCatalog = {
    version: 3,
    configDigest: input.configDigest,
    capabilities: [...capabilities.values()]
      .map(capability => ({ id: capability.id, deliveryContract: capability.deliveryContract }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    executors: routable.map(executor => ({
      name: executor.id,
      description: executor.description,
      routingCapabilities: [...executor.capabilities].sort(),
      primaryUseCases: [...executor.primaryUseCases],
      avoidUseCases: [...executor.avoidUseCases],
      affordances: [...new Set(executor.capabilities.flatMap(
        capability => capabilities.get(capability)?.requiredAffordances ?? [],
      ))].sort(),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
  const runtime = new Map(routable.map(executor => [executor.id, freezeClone({
    id: executor.id,
    configDigest: input.configDigest,
    driver: executor.binding.driver,
    ...runtimeContractForDriver(executor.binding.driver, executor.binding.sessionProtocol),
    binaryPath: executor.binding.binaryPath,
    versionArgs: executor.binding.versionArgs,
    runtimeHome: executor.binding.runtimeHome,
    environmentFiles: executor.binding.environmentFiles,
    inheritEnvironment: executor.binding.inheritEnvironment,
    permissionProfileId: executor.binding.effectivePermissionProfile,
    sessionProtocol: executor.binding.sessionProtocol,
  })]));
  const tui = [...executors.values()].map(executor => {
    const matching = matchingVerifications.get(executor.id);
    const latest = latestByExecutor.get(executor.id);
    const verification: 'verified' | 'unverified' | 'stale' | 'failed' = matching
      ? 'verified'
      : latest?.configDigest !== input.configDigest
        ? 'stale'
        : latest && !latest.success
          ? 'failed'
          : 'unverified';
    return freezeClone({
      id: executor.id,
      description: executor.description,
      enabled: executor.enabled,
      configured: true,
      verification,
      error: latest && !latest.success ? String(latest.result.error ?? 'verification failed') : null,
      capabilities: [...executor.capabilities],
      driver: executor.binding.driver,
      binaryPath: executor.binding.binaryPath,
      verifiedAt: matching?.verifiedAt ?? null,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    schemaVersion: 1 as const,
    configDigest: input.configDigest,
    loadedAt: input.loadedAt ?? new Date().toISOString(),
    configPath: input.configPath,
    capabilities,
    profiles,
    executors,
    verifications: matchingVerifications,
    tui,
    planner,
    kernel: {
      configDigest: input.configDigest,
      candidates: routable.map(executor => ({
        id: executor.id,
        capabilities: [...executor.capabilities],
        health: statuses.get(executor.id)?.classHealth ?? 'unverified',
      })),
    },
    runtime,
  });
}

function freezeClone<T>(value: T): Readonly<T> {
  return Object.freeze(structuredClone(value));
}
