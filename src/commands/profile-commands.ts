import { AgentClassRepo } from '../storage/agent-class-repo.js';
import {
  stringArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

function formatList(values: string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(', ') : '-';
}

export async function showUserProfile(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const preferences = context.memoryEngine.list({ status: 'confirmed' });
  return {
    type: 'text',
    content: [
      '用户工作画像',
      `长期记忆 ${preferences.length}`,
      ...preferences.slice(0, 10).map(preference => `  - [${preference.scope}] ${preference.content}`),
    ].join('\n'),
  };
}

export async function showProjectProfile(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const subject = stringArg(args, 'name');
  if (!subject) {
    return { type: 'text', content: '用法: /profile project <name>' };
  }
  const projectPreferences = context.memoryEngine
    .list({ status: 'confirmed' })
    .filter(preference => preference.scope === 'project' && preference.subject === subject);
  return {
    type: 'text',
    content: [
      `项目画像：${subject}`,
      `长期记忆 ${projectPreferences.length}`,
      ...projectPreferences.map(preference => `  - ${preference.content}`),
    ].join('\n'),
  };
}

export async function showExecutorProfile(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const executorName = stringArg(args, 'executorName');
  if (!executorName) {
    return { type: 'text', content: '用法: /profile executor <name>' };
  }

  const agentClass = new AgentClassRepo(context.db).findByName(executorName);
  if (!agentClass) {
    return { type: 'text', content: `Error: Executor AgentClass is not registered: ${executorName}` };
  }

  const rows = context.db.prepare(`
    SELECT skill_name, skill_version, used_count, success_count, failure_count, patch_candidate_count
    FROM skill_effect_summaries
    WHERE executor_name = ?
    ORDER BY used_count DESC, updated_at DESC
    LIMIT 10
  `).all(executorName) as Array<{
    skill_name: string;
    skill_version: string | null;
    used_count: number;
    success_count: number;
    failure_count: number;
    patch_candidate_count: number;
  }>;

  return {
    type: 'text',
    content: [
      `Executor 画像：${executorName}`,
      `  kind: ${agentClass.kind}`,
      `  domains: ${formatList(agentClass.domains)}`,
      `  capabilities: ${formatList(agentClass.capabilities)}`,
      `  input types: ${formatList(agentClass.inputTypes)}`,
      `  output types: ${formatList(agentClass.outputTypes)}`,
      `  strengths: ${formatList(agentClass.strengths)}`,
      `  weaknesses: ${formatList(agentClass.weaknesses)}`,
      `  primary use cases: ${formatList(agentClass.primaryUseCases)}`,
      `  avoid use cases: ${formatList(agentClass.avoidUseCases)}`,
      `  intent affinity: ${Object.entries(agentClass.intentAffinity).map(([intent, score]) => `${intent}:${score}`).join(', ') || '-'}`,
      `  risk: ${agentClass.riskLevel}`,
      `  harness/model: ${agentClass.harness ?? '-'} / ${agentClass.model ?? '-'}`,
      `  skills: ${formatList(agentClass.skills)}`,
      `  MCP servers: ${formatList(agentClass.mcpServers)}`,
      `  plugins: ${formatList(agentClass.plugins)}`,
      `  runtime command: ${[agentClass.runtimeCommand, ...agentClass.runtimeArgs].filter(Boolean).join(' ') || '-'}`,
      `  runtime check: ${agentClass.runtimeCheckCommand ?? '-'}`,
      `  execution image: ${agentClass.executionImageRef ?? '-'}`,
      `  resolved image ID: ${agentClass.resolvedImageId ?? '-'}`,
      `  permission profile: ${agentClass.permissionProfileId ?? '-'}`,
      `  project URL: ${agentClass.projectUrl ?? '-'}`,
      `Skill Summary ${rows.length}`,
      ...rows.map(row => `  - ${row.skill_name}@${row.skill_version ?? 'unversioned'} used=${row.used_count} success=${row.success_count} failure=${row.failure_count} patch=${row.patch_candidate_count}`),
    ].join('\n'),
  };
}
