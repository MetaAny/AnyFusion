import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { z } from 'zod';
import {
  EXECUTOR_AFFORDANCE_IDS,
  EXECUTOR_DRIVER_IDS,
  type ExecutorRegistryConfig,
  type ExecutorVerification,
} from './executor-registry-types.js';

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_VALUE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*\S+/iu,
  /(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/-]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/u,
];

const CapabilitySchema = z.object({
  id: z.string().regex(ID_PATTERN),
  deliveryContract: z.string().trim().min(1).max(1_000),
  requiredAffordances: z.array(z.enum(EXECUTOR_AFFORDANCE_IDS)).min(1),
  recoverySafety: z.enum(['read_only', 'workspace_reconcilable', 'external_non_idempotent']),
  minimumPermissionProfile: z.enum(['workspace-engineering', 'public-web-research', 'restricted-custom']),
}).strict();

const ProfileSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  displayName: z.string().trim().min(1),
  discoveryCommands: z.array(z.string().trim().min(1)).min(1),
  driver: z.enum(EXECUTOR_DRIVER_IDS),
  defaultDescription: z.string().trim().min(1),
  suggestedCapabilities: z.array(z.string().regex(ID_PATTERN)),
}).strict();

const SessionProtocolSchema = z.object({
  initialArgs: z.array(z.string()),
  resumeArgs: z.array(z.string()).min(1),
  sessionIdPattern: z.string().trim().min(1),
  finalOutputPattern: z.string().trim().min(1).nullable(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  terminateSignal: z.enum(['SIGTERM', 'SIGINT']),
}).strict();

const BindingSchema = z.object({
  binaryPath: z.string().trim().min(1),
  versionArgs: z.array(z.string()).min(1),
  versionPattern: z.string().trim().min(1),
  driver: z.enum(EXECUTOR_DRIVER_IDS),
  runtimeHome: z.string().trim().min(1),
  environmentFiles: z.array(z.string().trim().min(1)),
  inheritEnvironment: z.array(z.string().regex(ENV_KEY_PATTERN)),
  effectivePermissionProfile: z.enum(['workspace-engineering', 'public-web-research', 'restricted-custom']),
  backendSupport: z.array(z.enum(['worktree', 'docker'])).min(1),
  dockerImageRef: z.string().trim().min(1).nullable().default(null),
  dockerImageId: z.string().trim().min(1).nullable().default(null),
  sessionProtocol: SessionProtocolSchema.nullable(),
}).strict();

const ExecutorSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  profileId: z.string().regex(ID_PATTERN).nullable(),
  description: z.string().trim().min(1).max(1_000),
  capabilities: z.array(z.string().regex(ID_PATTERN)).min(1),
  primaryUseCases: z.array(z.string().trim().min(1)).min(1),
  enabled: z.boolean(),
  binding: BindingSchema,
  strengths: z.array(z.string().trim().min(1)).default([]),
  weaknesses: z.array(z.string().trim().min(1)).default([]),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  domains: z.array(z.string().trim().min(1)).default([]),
  inputTypes: z.array(z.string().trim().min(1)).default(['text']),
  outputTypes: z.array(z.string().trim().min(1)).default(['markdown']),
  avoidUseCases: z.array(z.string().trim().min(1)).default([]),
  affinity: z.record(z.string(), z.number().min(0).max(1)).default({}),
}).strict();

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  capabilities: z.array(CapabilitySchema).min(1),
  profiles: z.array(ProfileSchema),
  executors: z.array(ExecutorSchema),
}).strict();

export interface LoadedExecutorRegistryConfig {
  config: ExecutorRegistryConfig;
  configDigest: string;
}

export function ensureExecutorRegistryConfig(configPath: string): void {
  try {
    readFileSync(configPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config: ExecutorRegistryConfig = {
    schemaVersion: 1,
    capabilities: [
      {
        id: 'current-web-research',
        deliveryContract: 'Research current public-web information, preserve traceable sources, and deliver source-backed findings.',
        requiredAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        recoverySafety: 'read_only',
        minimumPermissionProfile: 'public-web-research',
      },
      {
        id: 'workspace-engineering',
        deliveryContract: 'Understand, modify, and verify files in a controlled workspace and deliver changes or artifacts.',
        requiredAffordances: ['workspace-read-write', 'workspace-command-validation'],
        recoverySafety: 'workspace_reconcilable',
        minimumPermissionProfile: 'workspace-engineering',
      },
    ],
    profiles: [
      knownProfile('codex', 'Codex CLI', ['codex'], 'codex', 'Repository implementation, tests, review, and engineering artifacts.', ['workspace-engineering']),
      knownProfile('pi', 'Pi Agent', ['pi'], 'pi', 'Current public-web research, source verification, and cited reports.', ['current-web-research']),
      knownProfile('hermes', 'Hermes Agent', ['hermes', 'hermes-agent'], 'hermes', 'General agentic execution with explicit session recovery.', ['current-web-research']),
    ],
    executors: [],
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, dump(config, { noRefs: true, lineWidth: 120 }), { encoding: 'utf8', mode: 0o600 });
}

export function loadExecutorRegistryConfig(configPath: string): LoadedExecutorRegistryConfig {
  const rawText = readFileSync(configPath, 'utf8');
  const raw = load(rawText);
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid executors.yaml: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const config = parsed.data as ExecutorRegistryConfig;
  const errors = validateExecutorRegistryConfig(config);
  if (errors.length > 0) {
    throw new Error(`invalid executors.yaml: ${errors.join('; ')}`);
  }
  return {
    config,
    configDigest: digestExecutorRegistryConfig(config),
  };
}

export function validateExecutorRegistryConfig(config: ExecutorRegistryConfig): string[] {
  const errors: string[] = [];
  const capabilityIds = collectDuplicateIds(config.capabilities, 'Capability', errors);
  const profileIds = collectDuplicateIds(config.profiles, 'Profile', errors);
  collectDuplicateIds(config.executors, 'Executor', errors);

  for (const profile of config.profiles) {
    for (const capability of profile.suggestedCapabilities) {
      if (!capabilityIds.has(capability)) {
        errors.push(`Profile ${profile.id} references unknown Capability: ${capability}`);
      }
    }
  }

  for (const executor of config.executors) {
    const profile = executor.profileId
      ? config.profiles.find(item => item.id === executor.profileId)
      : null;
    if (executor.profileId && !profileIds.has(executor.profileId)) {
      errors.push(`Executor ${executor.id} references unknown Profile: ${executor.profileId}`);
    } else if (profile && profile.driver !== executor.binding.driver) {
      errors.push(
        `Executor ${executor.id} driver ${executor.binding.driver} does not match Profile ${profile.id} driver ${profile.driver}`,
      );
    }
    if (!isAbsolute(executor.binding.binaryPath)) {
      errors.push(`Executor ${executor.id} binaryPath must be absolute`);
    }
    if (!isAbsolute(executor.binding.runtimeHome)) {
      errors.push(`Executor ${executor.id} runtimeHome must be absolute`);
    }
    for (const envFile of executor.binding.environmentFiles) {
      if (!isAbsolute(envFile)) errors.push(`Executor ${executor.id} environment file must be absolute: ${envFile}`);
    }
    if (executor.binding.backendSupport.includes('docker')) {
      if (!executor.binding.dockerImageRef || !executor.binding.dockerImageId) {
        errors.push(`Executor ${executor.id} docker backend requires dockerImageRef and dockerImageId`);
      } else if (!executor.binding.dockerImageId.startsWith('sha256:')) {
        errors.push(`Executor ${executor.id} dockerImageId must be immutable sha256`);
      }
    } else if (executor.binding.dockerImageRef || executor.binding.dockerImageId) {
      errors.push(`Executor ${executor.id} declares a Docker image without docker backend support`);
    }
    for (const capabilityId of executor.capabilities) {
      const capability = config.capabilities.find(item => item.id === capabilityId);
      if (!capability) {
        errors.push(`Executor ${executor.id} references unknown Capability: ${capabilityId}`);
        continue;
      }
      if (capability.minimumPermissionProfile !== executor.binding.effectivePermissionProfile) {
        errors.push(
          `Executor ${executor.id} permission profile ${executor.binding.effectivePermissionProfile} does not match Capability ${capabilityId} minimum ${capability.minimumPermissionProfile}`,
        );
      }
    }
    if (executor.binding.driver === 'cli-session' && !executor.binding.sessionProtocol) {
      errors.push(`Executor ${executor.id} cli-session driver requires sessionProtocol`);
    }
    if (executor.binding.driver !== 'cli-session' && executor.binding.sessionProtocol) {
      errors.push(`Executor ${executor.id} dedicated driver must not declare sessionProtocol`);
    }
    if (executor.binding.sessionProtocol) {
      validateSessionProtocol(executor.id, executor.binding.sessionProtocol, errors);
    }
    if (containsCredentialValue(executor)) {
      errors.push(`Executor ${executor.id} configuration appears to contain a credential value or secret field`);
    }
  }
  return errors.sort((left, right) => left.localeCompare(right));
}

function validateSessionProtocol(
  executorId: string,
  protocol: ExecutorRegistryConfig['executors'][number]['binding']['sessionProtocol'],
  errors: string[],
): void {
  if (!protocol) return;
  if (!protocol.initialArgs.some(arg => arg.includes('{prompt}'))) {
    errors.push(`Executor ${executorId} initialArgs must contain {prompt}`);
  }
  if (!protocol.resumeArgs.some(arg => arg.includes('{prompt}'))) {
    errors.push(`Executor ${executorId} resumeArgs must contain {prompt}`);
  }
  if (!protocol.resumeArgs.some(arg => arg.includes('{sessionId}'))) {
    errors.push(`Executor ${executorId} resumeArgs must contain {sessionId}`);
  }
  for (const [label, pattern] of [
    ['sessionIdPattern', protocol.sessionIdPattern],
    ['finalOutputPattern', protocol.finalOutputPattern],
  ] as const) {
    if (!pattern) continue;
    try {
      new RegExp(pattern, label === 'finalOutputPattern' ? 'su' : 'u');
    } catch (error) {
      errors.push(`Executor ${executorId} ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function containsCredentialValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value));
  }
  if (Array.isArray(value)) return value.some(containsCredentialValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsCredentialValue);
}

export function digestExecutorRegistryConfig(config: ExecutorRegistryConfig): string {
  return createHash('sha256').update(stableJson(config)).digest('hex');
}

export function digestBinaryPath(binaryPath: string): string {
  return createHash('sha256').update(resolve(binaryPath)).digest('hex');
}

export function verificationMatches(
  verification: ExecutorVerification | null,
  configDigest: string,
  binaryPath: string,
  driver: string,
): verification is ExecutorVerification {
  return Boolean(
    verification?.success
    && verification.configDigest === configDigest
    && verification.binaryPath === binaryPath
    && verification.binaryPathDigest === digestBinaryPath(binaryPath)
    && verification.driver === driver,
  );
}

function collectDuplicateIds<T extends { id: string }>(
  values: T[],
  label: string,
  errors: string[],
): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) errors.push(`duplicate ${label} ID: ${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function knownProfile(
  id: string,
  displayName: string,
  discoveryCommands: string[],
  driver: 'codex' | 'pi' | 'hermes',
  defaultDescription: string,
  suggestedCapabilities: string[],
): ExecutorRegistryConfig['profiles'][number] {
  return {
    id,
    displayName,
    discoveryCommands,
    driver,
    defaultDescription,
    suggestedCapabilities,
  };
}
