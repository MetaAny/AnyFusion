import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  digestBinaryPath,
  digestExecutorRegistryConfig,
  loadExecutorRegistryConfig,
  validateExecutorRegistryConfig,
} from '../../src/executor/executor-registry-config.js';
import { createExecutorRegistrySnapshot } from '../../src/executor/executor-registry-snapshot.js';
import type { ExecutorRegistryConfig } from '../../src/executor/executor-registry-types.js';

function config(): ExecutorRegistryConfig {
  return {
    schemaVersion: 1,
    capabilities: [{
      id: 'workspace-engineering',
      deliveryContract: 'Edit and verify a workspace.',
      requiredAffordances: ['workspace-read-write', 'workspace-command-validation'],
      recoverySafety: 'workspace_reconcilable',
      minimumPermissionProfile: 'workspace-engineering',
    }],
    profiles: [{
      id: 'codex',
      displayName: 'Codex',
      discoveryCommands: ['codex'],
      driver: 'codex',
      defaultDescription: 'Repository executor',
      suggestedCapabilities: ['workspace-engineering'],
    }],
    executors: [{
      id: 'repo-codex',
      profileId: 'codex',
      description: 'Repository executor',
      capabilities: ['workspace-engineering'],
      primaryUseCases: ['implementation'],
      enabled: true,
      binding: {
        binaryPath: '/usr/bin/codex',
        versionArgs: ['--version'],
        versionPattern: '.+',
        driver: 'codex',
        runtimeHome: '/tmp/codex-home',
        environmentFiles: ['/tmp/codex.env'],
        inheritEnvironment: ['PATH'],
        effectivePermissionProfile: 'workspace-engineering',
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
    }],
  };
}

describe('executors.yaml registry', () => {
  it('loads valid required and optional fields with a stable digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'executor-config-'));
    const path = join(directory, 'executors.yaml');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, dump(config()));
    const first = loadExecutorRegistryConfig(path);
    const second = loadExecutorRegistryConfig(path);
    expect(first.config.executors[0]?.id).toBe('repo-codex');
    expect(first.configDigest).toBe(second.configDigest);
  });

  it('rejects duplicates, unknown capabilities, relative paths, permission mismatch, and secret fields', () => {
    const invalid = config();
    invalid.capabilities.push({ ...invalid.capabilities[0]! });
    invalid.executors[0]!.capabilities = ['missing'];
    invalid.executors[0]!.binding.binaryPath = 'codex';
    invalid.executors[0]!.binding.runtimeHome = './home';
    invalid.executors[0]!.description = 'apiKey=leaked';
    expect(validateExecutorRegistryConfig(invalid)).toEqual(expect.arrayContaining([
      'duplicate Capability ID: workspace-engineering',
      'Executor repo-codex references unknown Capability: missing',
      'Executor repo-codex binaryPath must be absolute',
      'Executor repo-codex runtimeHome must be absolute',
      'Executor repo-codex configuration appears to contain a credential value or secret field',
    ]));
  });

  it('allows credential environment key names while rejecting credential values', () => {
    const value = config();
    value.executors[0]!.binding.inheritEnvironment = ['OPENAI_API_KEY', 'PATH'];
    expect(validateExecutorRegistryConfig(value)).not.toContain(
      'Executor repo-codex configuration appears to contain a credential value or secret field',
    );
    value.executors[0]!.binding.sessionProtocol = {
      initialArgs: ['--token=plain-text-secret'],
      resumeArgs: ['--resume', '{sessionId}', '{prompt}'],
      sessionIdPattern: 'session=(.+)',
      finalOutputPattern: null,
      timeoutMs: 10_000,
      terminateSignal: 'SIGTERM',
    };
    value.executors[0]!.binding.driver = 'cli-session';
    expect(validateExecutorRegistryConfig(value)).toContain(
      'Executor repo-codex configuration appears to contain a credential value or secret field',
    );
  });

  it('rejects malformed generic session contracts before verification', () => {
    const value = config();
    const executor = value.executors[0]!;
    executor.profileId = null;
    executor.binding.driver = 'cli-session';
    executor.binding.sessionProtocol = {
      initialArgs: ['run'],
      resumeArgs: ['resume', '{prompt}'],
      sessionIdPattern: '[',
      finalOutputPattern: null,
      timeoutMs: 10_000,
      terminateSignal: 'SIGTERM',
    };
    expect(validateExecutorRegistryConfig(value)).toEqual(expect.arrayContaining([
      'Executor repo-codex initialArgs must contain {prompt}',
      'Executor repo-codex resumeArgs must contain {sessionId}',
    ]));
    expect(validateExecutorRegistryConfig(value).some(error => error.includes('sessionIdPattern is invalid'))).toBe(true);
  });

  it('routes only enabled digest-matched verified executors and marks changed config stale', () => {
    const value = config();
    const digest = digestExecutorRegistryConfig(value);
    const verification = {
      executorId: 'repo-codex',
      configDigest: digest,
      binaryPath: '/usr/bin/codex',
      binaryPathDigest: 'wrong',
      version: '1.0.0',
      driver: 'codex' as const,
      verifiedAt: '2026-08-07T00:00:00.000Z',
      success: true,
      result: {},
    };
    const stale = createExecutorRegistrySnapshot({
      configPath: '/tmp/executors.yaml',
      config: value,
      configDigest: digest,
      verifications: [verification],
    });
    expect(stale.planner.executors).toEqual([]);
    expect(stale.tui[0]?.verification).toBe('unverified');
  });

  it('projects explicit driver contracts into the Runtime snapshot', () => {
    const value = config();
    const digest = digestExecutorRegistryConfig(value);
    const snapshot = createExecutorRegistrySnapshot({
      configPath: '/tmp/executors.yaml',
      config: value,
      configDigest: digest,
      verifications: [{
        executorId: 'repo-codex',
        configDigest: digest,
        binaryPath: '/usr/bin/codex',
        binaryPathDigest: digestBinaryPath('/usr/bin/codex'),
        version: '1.0.0',
        driver: 'codex',
        verifiedAt: '2026-08-07T00:00:00.000Z',
        success: true,
        result: {},
      }],
    });
    expect(snapshot.runtime.get('repo-codex')).toMatchObject({
      supportsSessionResume: true,
      evidenceAffordance: 'metaclaw-tools',
      resultCollector: 'result-file',
      homeMaterializer: 'codex-config',
    });
  });
});
