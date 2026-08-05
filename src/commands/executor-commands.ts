import type { AgentClass, AgentClassRiskLevel } from '../core/types.js';
import { PERMISSION_PROFILE_IDS, type PermissionProfileId } from '../resource/index.js';
import { AgentClassRepo } from '../storage/agent-class-repo.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { isBuiltinExecutorName } from '../executor/builtin-executor-catalog.js';
import {
  optionArg,
  stringArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

function parseListOption(args: ResolvedCommandArgs, flag: `--${string}`): string[] {
  const value = optionArg(args, flag);
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}

function parseRuntimeArgs(value?: string): string[] {
  if (!value) return [];
  return value.split(/\s+/).map(item => item.trim()).filter(Boolean);
}

function buildAgentClassFromOptions(
  name: string,
  args: ResolvedCommandArgs,
  existing?: AgentClass | null,
): AgentClass {
  const risk = (optionArg(args, '--risk') ?? existing?.riskLevel ?? 'medium') as AgentClassRiskLevel;
  const permissionProfileId = (optionArg(args, '--permission-profile')
    ?? existing?.permissionProfileId
    ?? null) as PermissionProfileId | null;
  if (permissionProfileId && !PERMISSION_PROFILE_IDS.includes(permissionProfileId)) {
    throw new Error(`Unknown permission profile: ${permissionProfileId}`);
  }
  const listOrExisting = (flag: `--${string}`, fallback: string[]) => {
    const parsed = parseListOption(args, flag);
    return parsed.length > 0 ? parsed : fallback;
  };
  const runtimeArgsOption = optionArg(args, '--args');
  return {
    name,
    kind: 'executor',
    domains: listOrExisting('--domains', existing?.domains ?? []),
    capabilities: listOrExisting('--capabilities', existing?.capabilities ?? []),
    inputTypes: listOrExisting('--inputs', existing?.inputTypes ?? ['text']),
    outputTypes: listOrExisting('--outputs', existing?.outputTypes ?? ['markdown']),
    strengths: listOrExisting('--strengths', existing?.strengths ?? []),
    weaknesses: listOrExisting('--weaknesses', existing?.weaknesses ?? []),
    primaryUseCases: listOrExisting('--primary-use-cases', existing?.primaryUseCases ?? []),
    avoidUseCases: listOrExisting('--avoid-use-cases', existing?.avoidUseCases ?? []),
    intentAffinity: existing?.intentAffinity ?? {},
    riskLevel: risk,
    harness: existing?.harness ?? 'cli',
    model: existing?.model ?? null,
    skills: existing?.skills ?? [],
    mcpServers: existing?.mcpServers ?? [],
    plugins: existing?.plugins ?? [],
    runtimeCommand: optionArg(args, '--command') ?? existing?.runtimeCommand ?? null,
    runtimeArgs: runtimeArgsOption ? parseRuntimeArgs(runtimeArgsOption) : existing?.runtimeArgs ?? [],
    runtimeCheckCommand: optionArg(args, '--check') ?? existing?.runtimeCheckCommand ?? null,
    executionImageRef: optionArg(args, '--image') ?? existing?.executionImageRef ?? null,
    resolvedImageId: optionArg(args, '--image-id') ?? existing?.resolvedImageId ?? null,
    permissionProfileId,
    projectUrl: optionArg(args, '--project-url') ?? existing?.projectUrl ?? null,
  };
}

function formatAgentClass(agentClass: AgentClass, health: string): string {
  const list = (values: string[]) => values.join(', ') || '-';
  return [
    `  ${agentClass.name} kind=${agentClass.kind} health=${health}`,
    `    domains: ${list(agentClass.domains)}`,
    `    capabilities: ${list(agentClass.capabilities)}`,
    `    strengths: ${list(agentClass.strengths)}`,
    `    primary use cases: ${list(agentClass.primaryUseCases)}`,
  ].join('\n');
}

export async function listExecutors(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const agentClasses = new AgentClassRepo(context.db).findAll();
  if (agentClasses.length === 0) {
    return { type: 'text', content: 'No AgentClass records are registered.' };
  }
  const workUnits = new WorkUnitRepo(context.db).findAll();
  const statuses = new KernelExecutorStatusRepo(context.db);
  return {
    type: 'text',
    content: [
      'Registered AgentClasses:',
      ...agentClasses.map(agentClass => formatAgentClass(agentClass, statuses.findByAgentClassName(agentClass.name)?.classHealth ?? 'unverified')),
      '',
      `WorkUnits: ${workUnits.map(unit => `${unit.id}:${unit.agentClassName}:${unit.state}`).join(', ') || '-'}`,
    ].join('\n'),
  };
}

export async function startExecutorRegisterWizard(): Promise<CommandResult> {
  return {
    type: 'directive',
    content: 'Executor AgentClass registration wizard started. Answer the prompts, or type cancel.',
    directive: { kind: 'start-executor-register-wizard' },
  };
}

export async function registerExecutor(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const name = stringArg(args, 'executorName');
  if (!name) {
    return {
      type: 'text',
      content: [
        'Enter the AgentClass registration wizard with /executor register wizard',
        '',
        'One-line usage:',
        '/executor register <name> --image <ref> --image-id <sha256:id> --permission-profile restricted-custom --command <cmd> --args "exec --prompt {prompt}" [--domains a,b] [--capabilities a,b]',
      ].join('\n'),
    };
  }
  if (isBuiltinExecutorName(name)) {
    return { type: 'text', content: `Cannot register or update canonical Executor AgentClass: ${name}` };
  }

  const agentClassRepo = new AgentClassRepo(context.db);
  let agentClass: AgentClass;
  try {
    agentClass = buildAgentClassFromOptions(name, args, agentClassRepo.findByName(name));
  } catch (error) {
    return { type: 'text', content: (error as Error).message };
  }

  if (!agentClass.executionImageRef || !agentClass.resolvedImageId || !agentClass.permissionProfileId) {
    return { type: 'text', content: 'Custom Executor requires --image, --image-id and --permission-profile.' };
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(agentClass.resolvedImageId)) {
    return { type: 'text', content: 'Custom Executor --image-id must be an immutable sha256:<64 hex> image ID.' };
  }

  agentClassRepo.upsert(agentClass);
  return { type: 'text', content: `Registered Executor AgentClass: ${name}` };
}

export async function unregisterExecutor(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const name = stringArg(args, 'executorName');
  if (!name) {
    return { type: 'text', content: 'Usage: /executor unregister <name>' };
  }
  if (isBuiltinExecutorName(name)) {
    return { type: 'text', content: `Cannot unregister canonical Executor AgentClass: ${name}` };
  }

  const agentClassRepo = new AgentClassRepo(context.db);
  if (!agentClassRepo.findByName(name)) {
    return { type: 'text', content: `Executor AgentClass is not registered: ${name}` };
  }
  if (new WorkUnitRepo(context.db).findAll().some(unit => unit.agentClassName === name)) {
    return { type: 'text', content: `Cannot unregister AgentClass with WorkUnits: ${name}` };
  }

  agentClassRepo.delete(name);
  return { type: 'text', content: `Unregistered Executor AgentClass: ${name}` };
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
