import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  ExecutorRegistrationService,
  profileRegistrationDefaults,
} from '../executor/executor-registration-service.js';
import { ExecutorRegistryService } from '../executor/executor-registry-service.js';
import { ExecutorVerificationRepo } from '../storage/executor-verification-repo.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';

export async function runExecutorCli(input: {
  db: Database.Database;
  command: 'discover' | 'register' | 'verify' | 'enable' | 'disable' | 'show' | 'list' | 'reload';
  args: string[];
}): Promise<string> {
  const verificationRepo = new ExecutorVerificationRepo(input.db);
  const statusRepo = new KernelExecutorStatusRepo(input.db);
  const registry = new ExecutorRegistryService({ verificationRepo, statusRepo });
  const registration = new ExecutorRegistrationService({
    registry,
    verificationRepo,
    statusRepo,
  });

  if (input.command === 'discover') {
    const discovered = await registration.discover();
    return discovered.map(item => (
      `${item.profileId}\t${item.binaryPath ?? 'not found'}\t${item.version ?? '-'}`
    )).join('\n') || 'No discovery profiles configured.';
  }
  if (input.command === 'list') {
    return formatEntries(registry.current().tui);
  }
  if (input.command === 'reload') {
    return `Executor registry reloaded: ${registry.reload().configDigest}`;
  }

  const executorId = input.args[0];
  if (!executorId) throw new Error(`executor ${input.command} requires an Executor ID`);
  if (input.command === 'show') {
    const entry = registry.current().tui.find(item => item.id === executorId);
    if (!entry) throw new Error(`Executor is not registered: ${executorId}`);
    return formatEntries([entry]);
  }
  if (input.command === 'verify') {
    const result = await registration.verify(executorId);
    return result.success
      ? `Executor ${executorId} verified for ${result.configDigest} (${result.version})`
      : `Executor ${executorId} verification failed: ${String(result.result.error ?? 'unknown error')}`;
  }
  if (input.command === 'enable' || input.command === 'disable') {
    await registration.setEnabled(executorId, input.command === 'enable');
    return `Executor ${executorId} ${input.command}d`;
  }

  const options = parseOptions(input.args.slice(1));
  const profileId = options.get('--profile')?.trim() || null;
  const driver = options.get('--driver')?.trim() || null;
  if (Boolean(profileId) === Boolean(driver)) {
    throw new Error('executor register requires exactly one of --profile or --driver');
  }
  const binaryPath = resolve(required(options, '--binary'));
  const runtimeHome = resolve(required(options, '--home'));
  const description = required(options, '--description');
  const capabilities = list(required(options, '--capabilities'));
  const primaryUseCases = list(required(options, '--use-cases'));
  const profile = profileId ? registry.current().profiles.get(profileId) : null;
  if (profileId && !profile) throw new Error(`Unknown Executor profile: ${profileId}`);
  if (!profile && driver !== 'cli-session') throw new Error('Unknown CLI registration requires --driver cli-session');
  const defaults = profile ? profileRegistrationDefaults(profile, binaryPath, runtimeHome) : null;
  const environmentFiles = list(options.get('--env-files')).map(path => resolve(path));
  const result = await registration.register({
    id: executorId,
    profileId,
    description,
    capabilities,
    primaryUseCases,
    enabled: true,
    binding: {
      binaryPath,
      versionArgs: defaults?.binding.versionArgs ?? jsonStringArray(options, '--version-args-json'),
      versionPattern: defaults?.binding.versionPattern ?? required(options, '--version-pattern'),
      driver: defaults?.binding.driver ?? 'cli-session',
      runtimeHome,
      environmentFiles,
      inheritEnvironment: ['PATH'],
      effectivePermissionProfile: defaults?.binding.effectivePermissionProfile
        ?? permissionProfile(required(options, '--permission-profile')),
      backendSupport: defaults?.binding.backendSupport ?? ['worktree'],
      dockerImageRef: defaults?.binding.dockerImageRef ?? null,
      dockerImageId: defaults?.binding.dockerImageId ?? null,
      sessionProtocol: defaults
        ? defaults.binding.sessionProtocol
        : {
            initialArgs: jsonStringArray(options, '--initial-args-json'),
            resumeArgs: jsonStringArray(options, '--resume-args-json'),
            sessionIdPattern: required(options, '--session-id-pattern'),
            finalOutputPattern: options.get('--final-output-pattern')?.trim() || null,
            timeoutMs: timeoutMs(required(options, '--timeout-ms')),
            terminateSignal: terminateSignal(required(options, '--terminate-signal')),
          },
    },
    strengths: list(options.get('--strengths')),
    weaknesses: list(options.get('--weaknesses')),
    riskLevel: (options.get('--risk') as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
    domains: list(options.get('--domains')),
    inputTypes: list(options.get('--inputs')).length > 0 ? list(options.get('--inputs')) : ['text'],
    outputTypes: list(options.get('--outputs')).length > 0 ? list(options.get('--outputs')) : ['markdown'],
    avoidUseCases: list(options.get('--avoid-use-cases')),
    affinity: {},
  });
  return `Executor ${executorId} registered, verified, enabled, and loaded (${result.version})`;
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options.set(key, value);
    index += 1;
  }
  return options;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key)?.trim();
  if (!value) throw new Error(`Missing required option ${key}`);
  return value;
}

function list(value: string | undefined): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
}

function jsonStringArray(options: Map<string, string>, key: string): string[] {
  const parsed = JSON.parse(required(options, key)) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(item => typeof item === 'string')) {
    throw new Error(`${key} must be a non-empty JSON string array`);
  }
  return parsed;
}

function permissionProfile(
  value: string,
): 'workspace-engineering' | 'public-web-research' | 'restricted-custom' {
  if (value === 'workspace-engineering' || value === 'public-web-research' || value === 'restricted-custom') {
    return value;
  }
  throw new Error('--permission-profile is invalid');
}

function timeoutMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 600000');
  }
  return parsed;
}

function terminateSignal(value: string): 'SIGTERM' | 'SIGINT' {
  if (value === 'SIGTERM' || value === 'SIGINT') return value;
  throw new Error('--terminate-signal must be SIGTERM or SIGINT');
}

function formatEntries(entries: readonly {
  id: string;
  enabled: boolean;
  verification: string;
  driver: string;
  capabilities: string[];
  binaryPath: string;
  description: string;
  error: string | null;
}[]): string {
  return entries.map(entry => [
    `${entry.id} [${entry.enabled ? 'enabled' : 'disabled'} / ${entry.verification}]`,
    `  ${entry.description}`,
    `  driver=${entry.driver}`,
    `  capabilities=${entry.capabilities.join(', ')}`,
    `  binary=${entry.binaryPath}`,
    ...(entry.error ? [`  error=${entry.error}`] : []),
  ].join('\n')).join('\n') || 'No Executors are configured.';
}
