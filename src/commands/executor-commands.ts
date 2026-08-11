import {
  optionArg,
  stringArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

export async function listExecutors(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const entries = context.executorRegistry?.list() ?? [];
  if (entries.length === 0) return { type: 'text', content: 'No Executors are configured.' };
  return {
    type: 'text',
    content: [
      `Executor registry digest: ${context.executorRegistry?.digest() ?? '-'}`,
      ...entries.map(entry => [
        `${entry.id} [${entry.enabled ? 'enabled' : 'disabled'} / ${entry.verification}]`,
        `  ${entry.description}`,
        `  driver=${entry.driver} capabilities=${entry.capabilities.join(', ')}`,
        `  binary=${entry.binaryPath}`,
        `  verifiedAt=${entry.verifiedAt ?? '-'}`,
        ...(entry.error ? [`  error=${entry.error}`] : []),
      ].join('\n')),
    ].join('\n'),
  };
}

export async function discoverExecutors(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.executorRegistry) return unavailable();
  const discoveries = await context.executorRegistry.discover();
  return {
    type: 'text',
    content: discoveries.length === 0
      ? 'No Executor profiles are configured for discovery.'
      : discoveries.map(item => (
          `${item.profileId}: ${item.binaryPath ?? 'not found'}${item.version ? ` (${item.version})` : ''}`
        )).join('\n'),
  };
}

export async function verifyExecutor(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.executorRegistry) return unavailable();
  const executorId = stringArg(args, 'executorName');
  try {
    const verification = await context.executorRegistry.verify(executorId);
    return {
      type: 'text',
      content: verification.success
        ? `Executor ${executorId} verified for digest ${verification.configDigest}`
        : `Executor ${executorId} verification failed: ${String(verification.result.error ?? 'unknown error')}`,
    };
  } catch (error) {
    return { type: 'text', content: `Executor verification failed: ${message(error)}` };
  }
}

export async function enableExecutor(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  return setEnabled(args, context, true);
}

export async function disableExecutor(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  return setEnabled(args, context, false);
}

export async function reloadExecutors(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.executorRegistry) return unavailable();
  try {
    const result = context.executorRegistry.reload();
    return { type: 'text', content: `Executor registry reloaded: ${result.configDigest}` };
  } catch (error) {
    return {
      type: 'text',
      content: `Executor registry reload rejected; previous snapshot remains active: ${message(error)}`,
    };
  }
}

export async function registerExecutor(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.executorRegistry) return unavailable();
  const id = stringArg(args, 'executorName');
  const profileId = optionArg(args, '--profile');
  const driver = optionArg(args, '--driver');
  const binaryPath = optionArg(args, '--binary');
  const runtimeHome = optionArg(args, '--home');
  const description = optionArg(args, '--description');
  const capabilities = splitList(optionArg(args, '--capabilities'));
  const primaryUseCases = splitList(optionArg(args, '--use-cases'));
  if (
    Boolean(profileId) === Boolean(driver)
    || !binaryPath
    || !runtimeHome
    || !description
    || capabilities.length === 0
    || primaryUseCases.length === 0
  ) {
    return {
      type: 'text',
      content: 'Usage: /executor register <id> (--profile <id> | --driver cli-session) --binary <absolutePath> --home <absolutePath> --description <text> --capabilities <a,b> --use-cases <a,b>',
    };
  }
  try {
    const verification = await context.executorRegistry.register({
      id,
      profileId: profileId ?? null,
      driver: (driver ?? profileId) as 'codex' | 'pi' | 'hermes' | 'cli-session',
      binaryPath,
      runtimeHome,
      description,
      capabilities,
      primaryUseCases,
      environmentFiles: splitList(optionArg(args, '--env-files')),
      ...(driver === 'cli-session' ? {
        versionArgs: parseStringArrayOption(args, '--version-args-json'),
        versionPattern: requiredOption(args, '--version-pattern'),
        permissionProfile: requiredOption(args, '--permission-profile') as
          | 'workspace-engineering'
          | 'public-web-research'
          | 'restricted-custom',
        sessionProtocol: {
          initialArgs: parseStringArrayOption(args, '--initial-args-json'),
          resumeArgs: parseStringArrayOption(args, '--resume-args-json'),
          sessionIdPattern: requiredOption(args, '--session-id-pattern'),
          finalOutputPattern: optionArg(args, '--final-output-pattern')?.trim() || null,
          timeoutMs: parseTimeout(requiredOption(args, '--timeout-ms')),
          terminateSignal: parseTerminateSignal(requiredOption(args, '--terminate-signal')),
        },
      } : {}),
    });
    return { type: 'text', content: `Executor ${id} registered, verified, enabled, and loaded (${verification.version})` };
  } catch (error) {
    return { type: 'text', content: `Executor registration failed: ${message(error)}` };
  }
}

function requiredOption(args: ResolvedCommandArgs, name: string): string {
  const value = optionArg(args, name)?.trim();
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function parseStringArrayOption(args: ResolvedCommandArgs, name: string): string[] {
  const raw = requiredOption(args, name);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(item => typeof item === 'string')) {
    throw new Error(`${name} must be a non-empty JSON string array`);
  }
  return parsed;
}

function parseTimeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 600000');
  }
  return value;
}

function parseTerminateSignal(raw: string): 'SIGTERM' | 'SIGINT' {
  if (raw !== 'SIGTERM' && raw !== 'SIGINT') {
    throw new Error('--terminate-signal must be SIGTERM or SIGINT');
  }
  return raw;
}

export async function refreshExecutors(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  if (!context.refreshExecutors) {
    return { type: 'text', content: 'Executor recovery refresh is not available in this host.' };
  }
  const target = stringArg(args, 'executorName');
  const report = await context.refreshExecutors(target && target !== 'all' ? [target] : undefined);
  return {
    type: 'text',
    content: [
      `Recovery refresh checked: ${report.checked.join(', ') || '-'}`,
      `Recovered: ${report.recovered.join(', ') || '-'}`,
      `Still error: ${report.stillError.join(', ') || '-'}`,
      `Skipped (not error/unknown): ${report.skipped.join(', ') || '-'}`,
    ].join('\n'),
  };
}

function setEnabled(
  args: ResolvedCommandArgs,
  context: CommandContext,
  enabled: boolean,
): Promise<CommandResult> {
  if (!context.executorRegistry) return Promise.resolve(unavailable());
  const executorId = stringArg(args, 'executorName');
  return context.executorRegistry.setEnabled(executorId, enabled)
    .then(() => ({
      type: 'text' as const,
      content: `Executor ${executorId} ${enabled ? 'enabled' : 'disabled'}`,
    }))
    .catch(error => ({
      type: 'text' as const,
      content: `Executor ${enabled ? 'enable' : 'disable'} failed: ${message(error)}`,
    }));
}

function splitList(value: string | undefined): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
}

function unavailable(): CommandResult {
  return { type: 'text', content: 'Executor registry administration is not available in this host.' };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
