import { dump } from 'js-yaml';
import {
  stringArg,
  stringListArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';

export async function showDashboard(_args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const dashboard = context.orchestration.getDashboard();

  const lines = [
    '┌─ Metaclaw 任务盘面 ─────────────────────────────┐',
    `│ 活跃: ${dashboard.summary.active}  阻塞: ${dashboard.summary.blocked}  暂停: ${dashboard.summary.parked}  完成: ${dashboard.summary.done}`,
    '│',
  ];

  if (dashboard.priorityTask) {
    lines.push('│ 建议优先处理：');
    lines.push(`│   #${dashboard.priorityTask.id} ${dashboard.priorityTask.title}`);
    dashboard.priorityTask.reasons.forEach(r => lines.push(`│     → ${r}`));
    lines.push('│');
  }

  if (dashboard.blockedTasks.length > 0) {
    lines.push('│ 当前卡住：');
    dashboard.blockedTasks.forEach(t => {
      lines.push(`│   #${t.id} ${t.title}`);
      lines.push(`│     → ${t.blockReason}`);
    });
    lines.push('│');
  }

  if (dashboard.readyTasks.length > 0) {
    lines.push('│ 可以处理：');
    dashboard.readyTasks.slice(0, 3).forEach(t => {
      lines.push(`│   #${t.id} ${t.title}`);
    });
  }

  lines.push('└──────────────────────────────────────────────────┘');

  return { type: 'dashboard', content: lines.join('\n'), payload: dashboard };
}

export async function attachTaskResources(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const resources = stringListArg(args, 'resources');

  if (resources.length === 0) {
    return { type: 'text', content: '用法: /task attach <taskId> <资源...>' };
  }

  for (const resourcePath of resources) {
    context.taskEngine.attachResource(taskId, resourcePath);
  }

  const targetTask = context.taskEngine.getTaskRepo().findById(taskId)!;
  const summaryLine = `已关联 ${resources.length} 个文件到任务 #${taskId}: ${resources.join(', ')}`;

  if (targetTask.status === 'blocked') {
    return {
      type: 'text',
      content: `${summaryLine}\n任务 #${taskId} 当前仍为 BLOCKED，可继续执行 /task resume ${taskId}`,
    };
  }

  return { type: 'text', content: summaryLine };
}

export async function showConfig(_args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  return { type: 'text', content: dump(context.config).trim() };
}

export async function exitSession(): Promise<CommandResult> {
  return { type: 'exit', content: '再见 👋' };
}
