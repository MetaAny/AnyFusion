import { resolve } from 'node:path';
import { digestBinaryPath, digestExecutorRegistryConfig } from './executor-registry-config.js';
import { createExecutorRegistrySnapshot } from './executor-registry-snapshot.js';
import type { ExecutorRegistryConfig, ExecutorRegistrySnapshot } from './executor-registry-types.js';

export function createTestExecutorRegistrySnapshot(configPath = '/test/executors.yaml'): ExecutorRegistrySnapshot {
  const config: ExecutorRegistryConfig = {
    schemaVersion: 1,
    capabilities: [
      {
        id: 'current-web-research',
        deliveryContract: 'Research current public-web information and deliver source-backed findings.',
        requiredAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        recoverySafety: 'read_only',
        minimumPermissionProfile: 'public-web-research',
      },
      {
        id: 'workspace-engineering',
        deliveryContract: 'Modify and verify files in a controlled workspace.',
        requiredAffordances: ['workspace-read-write', 'workspace-command-validation'],
        recoverySafety: 'workspace_reconcilable',
        minimumPermissionProfile: 'workspace-engineering',
      },
    ],
    profiles: [],
    executors: [
      testExecutor('codex-cli', 'codex', 'workspace-engineering', '/usr/bin/codex', '/tmp/codex-home'),
      testExecutor('pi-agent', 'pi', 'current-web-research', '/usr/bin/pi', '/tmp/pi-home'),
    ],
  };
  const configDigest = digestExecutorRegistryConfig(config);
  return createExecutorRegistrySnapshot({
    configPath,
    config,
    configDigest,
    verifications: config.executors.map(executor => ({
      executorId: executor.id,
      configDigest,
      binaryPath: executor.binding.binaryPath,
      binaryPathDigest: digestBinaryPath(executor.binding.binaryPath),
      version: 'test',
      driver: executor.binding.driver,
      verifiedAt: '2026-08-07T00:00:00.000Z',
      success: true,
      result: { test: true },
    })),
    statuses: config.executors.map(executor => ({
      agentClassName: executor.id,
      classHealth: 'healthy',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: '2026-08-07T00:00:00.000Z',
    })),
  });
}

function testExecutor(
  id: string,
  driver: 'codex' | 'pi',
  capability: string,
  binaryPath: string,
  runtimeHome: string,
): ExecutorRegistryConfig['executors'][number] {
  return {
    id,
    profileId: null,
    description: `${id} test executor`,
    capabilities: [capability],
    primaryUseCases: [capability],
    enabled: true,
    binding: {
      binaryPath: resolve(binaryPath),
      versionArgs: ['--version'],
      versionPattern: '.+',
      driver,
      runtimeHome: resolve(runtimeHome),
      environmentFiles: [],
      inheritEnvironment: [],
      effectivePermissionProfile: capability === 'workspace-engineering'
        ? 'workspace-engineering'
        : 'public-web-research',
      backendSupport: ['worktree', 'docker'],
      dockerImageRef: `anyfusion-test/${id}:latest`,
      dockerImageId: `sha256:${id === 'codex-cli' ? 'a' : 'b'}`.padEnd(71, id === 'codex-cli' ? 'a' : 'b'),
      sessionProtocol: null,
    },
    strengths: [],
    weaknesses: [],
    riskLevel: 'medium',
    domains: [],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    avoidUseCases: [],
    affinity: {},
  };
}
