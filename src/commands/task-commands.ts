import {
  optionalStringArg,
  stringArg,
  stringListArg,
  type CommandContext,
  type CommandResult,
  type ResolvedCommandArgs,
} from './catalog.js';
import { MANAGEABLE_TASK_STATUSES, type TaskClearScope } from '../task/task-control-types.js';
import { buildMaterialSummary, extractMaterialTextSnippets, isWebLink, splitTaskResources } from '../intent/material-utils.js';
import type { Task, TaskStatus } from '../core/types.js';
import { TaskSearchIndexRepo } from '../storage/task-search-index-repo.js';

const CLEAR_SCOPE_STATUSES: Record<TaskClearScope, TaskStatus[]> = {
  all: MANAGEABLE_TASK_STATUSES,
  parked: ['parked'],
  blocked: ['blocked'],
};

const CLEAR_SCOPE_LABELS: Record<TaskClearScope, string> = {
  all: '所有未完成任务',
  parked: '挂起任务',
  blocked: '阻塞任务',
};

function parseClearScope(value: string | undefined): TaskClearScope | null {
  if (!value || value === 'all') {
    return 'all';
  }

  if (value === 'parked') {
    return 'parked';
  }

  if (value === 'blocked') {
    return 'blocked';
  }

  return null;
}

export async function cancelTasksByScope(
  context: CommandContext,
  scope: TaskClearScope,
  reason = `用户清空${CLEAR_SCOPE_LABELS[scope]}`,
): Promise<{ cancelled: Task[]; runningCancelled: boolean }> {
  const repo = context.taskEngine.getTaskRepo();
  const statuses = CLEAR_SCOPE_STATUSES[scope];
  const candidates = repo.findAll()
    .filter(task => statuses.includes(task.status));
  const runningCancelled = candidates.some(task => task.status === 'running');

  for (const task of candidates) {
    await context.taskControl.cancelTask(task.id, reason);
  }

  return { cancelled: candidates, runningCancelled };
}

export function formatTaskClearResult(scope: TaskClearScope, cancelled: Task[], runningCancelled = false): string {
  const lines = [
    `已清空${CLEAR_SCOPE_LABELS[scope]}：取消 ${cancelled.length} 个任务`,
  ];

  if (cancelled.length === 0) {
    lines.push('→ 没有匹配的可清空任务');
    return lines.join('\n');
  }

  if (runningCancelled) {
    lines.push('→ 已中止当前执行器，避免被取消任务继续输出');
  }

  lines.push(
    ...cancelled.map(task => `  - #${task.id} [${task.status.toUpperCase()}] ${task.title}`),
  );
  return lines.join('\n');
}

function formatTaskLine(task: {
  id: string;
  status: string;
  title: string;
  lastSchedulingReason: string;
  lastInterruptionReason: string;
  dependencies: Array<{ status: string; description: string }>;
}) {
  const lines = [`  #${task.id} [${task.status.toUpperCase()}] ${task.title}`];

  if (task.status === 'running' || task.status === 'ready') {
    lines.push(`    → 原因：${task.lastSchedulingReason || '等待调度'}`);
  } else if (task.status === 'parked') {
    lines.push(`    → 原因：${task.lastInterruptionReason || '等待恢复'}`);
  } else if (task.status === 'blocked') {
    lines.push(`    → 阻塞：${task.dependencies.find(dep => dep.status === 'waiting')?.description || '未知原因'}`);
  }

  return lines.join('\n');
}

function buildStatusExplanation(task: {
  status: string;
  lastSchedulingReason: string;
  lastInterruptionReason: string;
  dependencies: Array<{ status: string; description: string }>;
}): string {
  if (task.status === 'blocked') {
    return task.dependencies.find(dep => dep.status === 'waiting')?.description || '等待解除阻塞';
  }

  if (task.status === 'parked') {
    return task.lastInterruptionReason || '等待恢复';
  }

  if (task.status === 'ready' || task.status === 'running') {
    return task.lastSchedulingReason || '等待调度';
  }

  if (task.status === 'done') {
    return '已完成，可查看结果摘要与后续动作';
  }

  return '暂无额外说明';
}

function buildLatestNextStep(task: {
  status: string;
  snapshots: Array<{ nextStep: string }>;
  dependencies: Array<{ status: string; description: string }>;
}): string {
  const latestSnapshot = task.snapshots[task.snapshots.length - 1];
  if (latestSnapshot?.nextStep) {
    return latestSnapshot.nextStep;
  }

  if (task.status === 'blocked') {
    const blocker = task.dependencies.find(dep => dep.status === 'waiting')?.description;
    return blocker ? `先解除阻塞：${blocker}` : '先确认阻塞条件';
  }

  if (task.status === 'done') {
    return '如需延续，可基于当前结果创建 follow-up 任务';
  }

  return '继续推进当前任务';
}

function buildRecoveryAction(task: {
  id: string;
  status: string;
  resources?: string[];
  materialSummary?: { status: 'missing' | 'partial' | 'ready'; sufficiency: string };
}): string {
  if (task.status === 'blocked') {
    const hasLinks = (task.resources ?? []).some(resource => isWebLink(resource));
    if (task.materialSummary?.status === 'ready') {
      return `现有材料已具备可读内容，可直接执行 /task unblock ${task.id}；如仍不够，再补充材料：/task unblock ${task.id} [材料路径]`;
    }
    if (hasLinks) {
      return `若现有链接信息已足够，直接执行 /task unblock ${task.id}；如需补材料：/task unblock ${task.id} [材料路径]`;
    }
    return `/task unblock ${task.id} [材料路径]`;
  }

  if (task.status === 'parked') {
    return `/task resume ${task.id}`;
  }

  if (task.status === 'done') {
    return '直接输入 follow-up 指令，基于当前结果继续';
  }

  return '无';
}

export async function listTasks(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const scope = optionalStringArg(args, 'scope');
  const filter = scope && scope !== 'all' ? scope : undefined;
  const repo = context.taskEngine.getTaskRepo();
  let tasks;

  if (filter === 'active') {
    tasks = repo.findActive();
  } else if (filter === 'ready' || filter === 'parked' || filter === 'blocked' || filter === 'done') {
    tasks = repo.findByStatus(filter);
  } else {
    tasks = repo.findAll();
  }

  if (tasks.length === 0) {
    return { type: 'text', content: '暂无任务' };
  }

  if (filter) {
    const lines = tasks.map(formatTaskLine);
    return { type: 'text', content: `任务列表：\n${lines.join('\n')}` };
  }

  const groups = [
    { title: '当前执行', tasks: repo.findByStatus('running') },
    { title: '待执行', tasks: repo.findByStatus('ready') },
    { title: '已挂起', tasks: repo.findByStatus('parked') },
    { title: '已阻塞', tasks: repo.findByStatus('blocked') },
    { title: '已完成', tasks: repo.findByStatus('done') },
  ].filter(group => group.tasks.length > 0);

  const lines = ['任务清单：', ''];
  for (const group of groups) {
    lines.push(group.title);
    group.tasks.forEach(task => lines.push(formatTaskLine(task)));
    lines.push('');
  }

  return { type: 'text', content: lines.join('\n').trimEnd() };
}

export async function clearTasks(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const scope = parseClearScope(optionalStringArg(args, 'scope'));
  if (!scope) {
    return { type: 'text', content: '用法: /task clear [all|parked|blocked]' };
  }

  const result = await cancelTasksByScope(context, scope);
  return {
    type: 'text',
    content: formatTaskClearResult(scope, result.cancelled, result.runningCancelled),
  };
}

export async function showTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  const latestInteraction = context.db.prepare(
    'SELECT executor_used, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(taskId) as { executor_used: string | null; system_output: string | null; created_at: string } | undefined;
  const injectedPreferences = context.memoryEngine
    .list()
    .filter(preference => task.injectedPreferences.includes(preference.id));
  const latestSnapshot = task.snapshots[task.snapshots.length - 1] ?? null;
  const blocker = task.dependencies.find(dep => dep.status === 'waiting')?.description || '无';
  const latestResult = task.summary || latestInteraction?.system_output || '无';
  const latestNextStep = buildLatestNextStep(task);
  const statusExplanation = buildStatusExplanation(task);
  const lastProgress = latestSnapshot?.done.join('；') || task.summary || '无';
  const materialGroups = splitTaskResources(task.resources);
  const materialSnippets = await extractMaterialTextSnippets(task.resources);
  const materialSummary = buildMaterialSummary(task.resources, materialSnippets);
  const recoveryAction = buildRecoveryAction({
    ...task,
    materialSummary,
  });

  const lines = [
    `任务视图 #${task.id}`,
    `标题: ${task.title}`,
    `目标: ${task.goal}`,
    '',
    `当前状态: ${task.status}`,
    `状态说明: ${statusExplanation}`,
    `上次做到: ${lastProgress}`,
    `最新结果摘要: ${latestResult}`,
    `最新下一步: ${latestNextStep}`,
    `当前阻塞: ${blocker}`,
    `材料概览: ${materialSummary.overview}`,
    `材料状态: ${materialSummary.sufficiency}`,
    `关联材料: ${task.resources.join(', ') || '无'}`,
    `本地文件材料: ${materialGroups.files.join(', ') || '无'}`,
    `网页链接材料: ${materialGroups.links.join(', ') || '无'}`,
    `任务产物: ${task.artifacts.join(', ') || '无'}`,
    `恢复操作: ${recoveryAction}`,
    '',
    `最近执行器: ${latestInteraction?.executor_used || '无'}`,
    `最近调度原因: ${task.lastSchedulingReason || '无'}`,
    `最近中断原因: ${task.lastInterruptionReason || '无'}`,
    `最新快照时间: ${latestSnapshot ? latestSnapshot.createdAt : '无'}`,
    `创建时间: ${task.createdAt}`,
    `更新时间: ${task.updatedAt}`,
  ];
  if (injectedPreferences.length > 0) {
    lines.push('', '注入偏好:');
    injectedPreferences.forEach(preference => {
      const subjectText = preference.subject ? ` (${preference.subject})` : '';
      lines.push(`  - [${preference.scope}]${subjectText} ${preference.content}`);
    });
  }
  return { type: 'text', content: lines.join('\n') };
}

export async function pauseTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const wasRunning = task.status === 'running';
    context.taskEngine.park(taskId, '用户手动暂停', {
      done: [task.summary || '进行中'],
      pending: ['待继续'],
      nextStep: '恢复后继续',
      pauseReason: '用户手动暂停',
    });
    if (wasRunning) context.activeExecutions?.abortTask(taskId);
    return { type: 'text', content: `任务 #${taskId} 已暂停` };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function resumeTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  return {
    type: 'directive',
    content: `任务 #${taskId} 已提交恢复请求`,
    directive: { kind: 'resume-task', taskId, mode: 'resume-parked' },
  };
}

export async function blockTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const wasRunning = task.status === 'running';
    const reason = stringArg(args, 'reason') || '未指定原因';
    context.taskEngine.block(taskId, {
      taskId,
      type: 'manual',
      description: reason,
      status: 'waiting',
    });
    if (wasRunning) context.activeExecutions?.abortTask(taskId);
    return { type: 'text', content: `任务 #${taskId} 已标记为阻塞: ${reason}` };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function unblockTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  const task = context.taskEngine.getTaskRepo().findById(taskId);
  if (!task) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  const newlyProvidedResources = Array.from(new Set(stringListArg(args, 'resources').filter(Boolean)));
  const blockedReason = task.dependencies
    .filter(dependency => dependency.status === 'waiting')
    .map(dependency => dependency.description)
    .filter(Boolean)
    .join('；');

  return {
    type: 'directive',
    content: newlyProvidedResources.length > 0
      ? `任务 #${taskId} 已提交恢复请求，并附带资源 ${newlyProvidedResources.join(', ')}`
      : `任务 #${taskId} 已提交恢复请求`,
    directive: {
      kind: 'resume-task',
      taskId,
      mode: 'resume-blocked',
      newlyProvidedResources,
      blockedReason,
    },
  };
}

export async function cancelTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const receipt = await context.taskControl.cancelTask(taskId);
    return {
      type: 'text',
      content: `任务 #${taskId} 已取消：影响 ${receipt.affectedSubtaskIds.length} 个 Subtask，${receipt.cleanupAttemptIds.length} 个 attempt 正在清理`,
    };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function completeTask(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  return {
    type: 'text',
    content: `任务 #${taskId} 不能手工绕过完成门；完整结果会在运行残留清零后自动完成，部分结果请使用 /task accept-partial ${taskId}`,
  };
}

export async function cancelSubtasks(args: ResolvedCommandArgs, context: CommandContext): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  const subtaskIds = stringListArg(args, 'subtaskIds');
  if (subtaskIds.length === 0) {
    return { type: 'text', content: `用法: /task subtask-cancel ${taskId} <subtaskId...>` };
  }

  try {
    const receipt = await context.taskControl.cancelSubtasks(taskId, subtaskIds);
    return {
      type: 'text',
      content: `任务 #${taskId} 已提交原子 Subtask 取消：影响 ${receipt.affectedSubtaskIds.length} 个节点，${receipt.cleanupAttemptIds.length} 个 attempt 正在清理`,
    };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function acceptPartialResult(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const taskId = stringArg(args, 'taskId');
  if (!context.taskEngine.getTaskRepo().findById(taskId)) {
    return { type: 'text', content: `任务不存在: ${taskId}` };
  }

  try {
    const receipt = await context.taskControl.acceptPartialResult(taskId);
    return {
      type: 'text',
      content: `任务 #${taskId} 已显式接受部分结果；取消节点 ${receipt.affectedSubtaskIds.length} 个`,
    };
  } catch (error) {
    return { type: 'text', content: `操作失败: ${(error as Error).message}` };
  }
}

export async function rebuildTaskIndex(
  _args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const count = new TaskSearchIndexRepo(context.db).rebuild();
  return { type: 'text', content: `任务检索索引已重建：${count} 条索引记录` };
}

export async function searchTaskIndex(
  args: ResolvedCommandArgs,
  context: CommandContext,
): Promise<CommandResult> {
  const query = stringArg(args, 'query').trim();
  if (!query) {
    return { type: 'text', content: '用法: /task index search <query>' };
  }

  const results = new TaskSearchIndexRepo(context.db).search(query, 10);
  if (results.length === 0) {
    return { type: 'text', content: '任务检索索引没有命中结果' };
  }

  return {
    type: 'text',
    content: [
      `任务检索索引命中 ${results.length} 条：`,
      ...results.map(result => {
        const snippet = result.snippet.replace(/\s+/g, ' ').trim();
        return `  - #${result.taskId} [${result.sourceKind}] ${result.title || result.sourceId}: ${snippet}`;
      }),
    ].join('\n'),
  };
}
