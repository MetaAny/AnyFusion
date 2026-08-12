// Formats session-facing status, guidance, queue, and recovery
// messages so orchestration code can work with domain facts instead of strings.
import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import type { Dashboard, GuidanceProposal, RuntimeState, Task } from '../core/types.js';
import type { TaskClearScope, TaskStatusQueryScope } from '../task/task-control-types.js';

export interface GuidanceState {
  scene: string;
  taskId: string;
  taskTitle: string;
  recommendedAction: string;
  reasons: string[];
}

export interface GuidanceSuggestion {
  taskId: string;
  recommendedAction: string;
  reasons: string[];
}

export interface TaskQueueSnapshotEntry {
  task: Task;
  score: number;
  reason: string;
  executionOrder: string;
}

export interface ExecutorRegisterWizardSummaryInput {
  name?: string;
  projectUrl?: string | null;
  runtimeCommand?: string;
  runtimeArgs?: string[];
  runtimeCheckCommand?: string | null;
  domains?: string[];
  capabilities?: string[];
}

const CLEAR_SCOPE_LABELS: Record<TaskClearScope, string> = {
  all: '所有未完成任务',
  parked: '挂起任务',
  blocked: '阻塞任务',
};

/** Centralizes user-visible session formatting for task state, guidance, recall, and executor setup output. */
export class SessionPresentationService {
  private readonly queueLimit: number;

  constructor(options: { queueLimit?: number } = {}) {
    this.queueLimit = options.queueLimit ?? 5;
  }

  formatExecutorFinalResult(input: {
    executorName: string;
    taskId: string;
    subtaskId: string;
    output: string;
  }): string {
    return [
      `【Executor: ${input.executorName}｜最终结果｜#${input.taskId} / #${input.subtaskId}】`,
      input.output,
    ].join('\n');
  }

  formatExecutorDispatch(executorName: string): string[] {
    return [
      `【Executor: ${executorName}｜派发准备】`,
      `→ Executor: ${executorName} 将处理该任务`,
    ];
  }

  formatKernelRejection(reason: string): string {
    const missingTask = /^task not found: (.+)$/.exec(reason);
    if (missingTask) {
      return `未找到任务 #${missingTask[1]}，请检查任务编号或先查看任务状态。`;
    }

    const activeTask = /单活跃任务限制: 当前活跃顶层任务 #(.+)$/.exec(reason);
    if (activeTask) {
      return `当前已有任务 #${activeTask[1]} 正在运行，请等待完成，或先暂停/取消当前任务。`;
    }

    const completedTask = /^completed task (.+) cannot be resumed without a follow-up plan$/.exec(reason);
    if (completedTask) {
      return `任务 #${completedTask[1]} 已结束，无法直接恢复；请创建跟进任务。`;
    }

    if (reason.includes('no available executor agent class')) {
      return '当前没有可用的 Executor，请检查配置或注册可执行的 Executor 后重试。';
    }

    return '当前请求未通过执行校验，请调整请求后重试。';
  }

  buildGuidanceState(
    scene: string,
    suggestion: GuidanceSuggestion,
    taskTitle: string,
  ): GuidanceState {
    return {
      scene,
      taskId: suggestion.taskId,
      taskTitle,
      recommendedAction: suggestion.recommendedAction,
      reasons: [...suggestion.reasons],
    };
  }

  formatGuidanceBlock(
    scene: string,
    suggestion: GuidanceSuggestion,
    taskTitle: string,
    options: { emptyReason?: string } = {},
  ): string[] {
    const titleSuffix = taskTitle ? ` ${taskTitle}` : '';
    const lines = [
      '',
      '┌─ 操作指引 ───────────────────────────────────────┐',
      `│ 场景：${scene}`,
      `│ 推荐动作：${suggestion.recommendedAction}`,
      `│ 目标任务：#${suggestion.taskId}${titleSuffix}`,
    ];

    if (suggestion.reasons.length === 0) {
      lines.push(`│ 原因：${options.emptyReason ?? '上下文已准备完成，可继续执行'}`);
    } else {
      suggestion.reasons.forEach((reason, index) => {
        lines.push(`${index === 0 ? '│ 原因：' : '│       '}${reason}`);
      });
    }

    lines.push('└──────────────────────────────────────────────────┘');
    return lines;
  }

  formatProposalBlock(scene: string, proposal: GuidanceProposal, taskTitle: string): string[] {
    return [
      '',
      '┌─ 操作提案 ───────────────────────────────────────┐',
      `│ 场景：${scene}`,
      `│ 动作：${proposal.recommendedAction}`,
      proposal.taskId ? `│ 目标任务：#${proposal.taskId}${taskTitle ? ` ${taskTitle}` : ''}` : '│ 目标任务：无',
      ...proposal.reasons.map((reason, index) => `${index === 0 ? '│ 理由：' : '│       '}${reason}`),
      `│ 置信度：${proposal.confidence.toFixed(2)}`,
      '│ 策略：无需用户确认；高置信提案自动执行，低置信提案自动跳过',
      '└──────────────────────────────────────────────────┘',
    ];
  }

  formatTaskClearResult(input: {
    scope: TaskClearScope;
    cancelled: Task[];
    runningCancelled?: boolean;
  }): string {
    const lines = [
      `已清空${CLEAR_SCOPE_LABELS[input.scope]}：取消 ${input.cancelled.length} 个任务`,
    ];

    if (input.cancelled.length === 0) {
      lines.push('→ 没有匹配的可清空任务');
      return lines.join('\n');
    }

    if (input.runningCancelled) {
      lines.push('→ 已中止当前执行器，避免被取消任务继续输出');
    }

    lines.push(
      ...input.cancelled.map(task => `  - #${task.id} [${task.status.toUpperCase()}] ${task.title}`),
    );
    return lines.join('\n');
  }

  formatTaskStatus(input: {
    scope: TaskStatusQueryScope;
    blockedTasks: Array<Task & { blockReason: string }>;
    runningTask: Task | null;
    activeTasks: Task[];
    latestDone: Task | null;
    dashboard: Dashboard;
  }): string {
    if (input.scope === 'blocked') {
      if (input.blockedTasks.length === 0) {
        return '当前没有阻塞任务。';
      }

      return [
        `当前有 ${input.blockedTasks.length} 个阻塞任务：`,
        ...input.blockedTasks.map(task => [
          `  #${task.id} [BLOCKED] ${task.title}`,
          `    → 阻塞原因：${task.blockReason}`,
          `    → 建议动作：/task resume ${task.id}，或直接补充材料/说明后让我继续`,
        ].join('\n')),
      ].join('\n');
    }

    if (input.scope === 'running') {
      if (input.runningTask) {
        return [
          '当前有 1 个正在执行的任务：',
          `  #${input.runningTask.id} [RUNNING] ${input.runningTask.title}`,
          `    → 调度原因：${input.runningTask.lastSchedulingReason || '等待执行器返回'}`,
          `    → 最近更新时间：${input.runningTask.updatedAt}`,
        ].join('\n');
      }

      const lines = [
        '当前没有正在执行的任务。',
        `  总览：待执行 ${input.activeTasks.filter(task => task.status === 'ready' || task.status === 'created').length} / 挂起 ${input.activeTasks.filter(task => task.status === 'parked').length} / 阻塞 ${input.activeTasks.filter(task => task.status === 'blocked').length}`,
      ];
      if (input.latestDone) {
        lines.push(`  最近完成：#${input.latestDone.id} ${input.latestDone.title}`);
        if (input.latestDone.summary) {
          lines.push(`  摘要：${input.latestDone.summary}`);
        }
      }
      return lines.join('\n');
    }

    const lines = [
      '当前任务状态：',
      `  总览：活跃 ${input.dashboard.summary.active} / 阻塞 ${input.dashboard.summary.blocked} / 挂起 ${input.dashboard.summary.parked} / 已完成 ${input.dashboard.summary.done}`,
    ];

    if (input.dashboard.blockedTasks.length > 0) {
      lines.push('  阻塞任务：');
      lines.push(...input.dashboard.blockedTasks.map(task => `    #${task.id} ${task.title}，原因：${task.blockReason}`));
    }

    if (input.dashboard.readyTasks.length > 0) {
      lines.push('  待执行任务：');
      lines.push(...input.dashboard.readyTasks.slice(0, this.queueLimit).map(task => `    #${task.id} ${task.title}`));
      if (input.dashboard.readyTasks.length > this.queueLimit) {
        lines.push(`    ... 还有 ${input.dashboard.readyTasks.length - this.queueLimit} 个待执行任务`);
      }
    }

    if (!input.dashboard.priorityTask) {
      lines.push('  当前没有需要优先提示的任务。');
    } else {
      lines.push(`  建议优先：#${input.dashboard.priorityTask.id} ${input.dashboard.priorityTask.title}`);
      lines.push(...input.dashboard.priorityTask.reasons.map(reason => `    → ${reason}`));
    }

    return lines.join('\n');
  }

  formatLastTaskAutoDecisionBlock(input: {
    completedTask: Task;
    unfinishedTask: Task | null;
    decision: 'resume-unfinished' | 'follow-up';
  }): string[] {
    const { completedTask, unfinishedTask, decision } = input;
    return [
      '',
      '┌─ 上次任务自动处理 ───────────────────────────────┐',
      `│ 上一个任务：#${completedTask.id} ${completedTask.title}`,
      '│ 上一个任务已完成。',
      decision === 'resume-unfinished' && unfinishedTask
        ? `│ 自动决策：恢复最近未完成任务 #${unfinishedTask.id} ${unfinishedTask.title}`
        : '│ 自动决策：基于上一个任务创建 follow-up',
      '│ 策略：无需用户确认；优先恢复未完成任务，否则创建跟进任务',
      '└──────────────────────────────────────────────────┘',
    ];
  }

  formatTaskPoolWatchdogReminder(input: {
    blockedTasks: Task[];
    parkedTasks: Task[];
    getWaitingBlockReason: (task: Task) => string | null;
  }): string[] {
    const { blockedTasks, parkedTasks, getWaitingBlockReason } = input;
    const lines = [
      '',
      '┌─ 任务池看护提醒 ─────────────────────────────────┐',
      `│ 当前不可自动执行：阻塞 ${blockedTasks.length} / 挂起 ${parkedTasks.length}`,
    ];

    if (blockedTasks.length > 0) {
      lines.push('│ 阻塞任务：');
      for (const task of blockedTasks.slice(0, this.queueLimit)) {
        const reason = getWaitingBlockReason(task) || '等待解除阻塞';
        lines.push(`│   #${task.id} ${task.title}`);
        lines.push(`│     原因：${reason}`);
        lines.push(`│     还差：${this.describeBlockedTaskMissingCondition(reason, task.id)}`);
      }
      if (blockedTasks.length > this.queueLimit) {
        lines.push(`│   ... 还有 ${blockedTasks.length - this.queueLimit} 个阻塞任务`);
      }
    }

    if (parkedTasks.length > 0) {
      lines.push('│ 挂起任务：');
      for (const task of parkedTasks.slice(0, this.queueLimit)) {
        const latestSnapshot = task.snapshots.at(-1);
        lines.push(`│   #${task.id} ${task.title}`);
        lines.push(`│     原因：${task.lastInterruptionReason || latestSnapshot?.pauseReason || '等待恢复'}`);
        lines.push(`│     下一步：${latestSnapshot?.nextStep || '继续推进当前任务'}`);
      }
      if (parkedTasks.length > this.queueLimit) {
        lines.push(`│   ... 还有 ${parkedTasks.length - this.queueLimit} 个挂起任务`);
      }
    }

    lines.push('└──────────────────────────────────────────────────┘');
    return lines;
  }

  formatBlockedExecutionGuidance(task: Task, newlyProvidedResources: string[] | undefined): GuidanceSuggestion {
    const reasons = ['阻塞已解除，任务重新具备执行条件'];
    if (newlyProvidedResources && newlyProvidedResources.length > 0) {
      reasons.push(`已补充 ${newlyProvidedResources.length} 份新材料`);
    }

    return {
      taskId: task.id,
      recommendedAction: `继续处理任务 #${task.id}: ${task.title}`,
      reasons,
    };
  }

  formatResumeExecutionGuidance(task: Task): GuidanceSuggestion {
    return {
      taskId: task.id,
      recommendedAction: `继续处理任务 #${task.id}: ${task.title}`,
      reasons: this.buildResumeGuidanceReasons(task),
    };
  }

  buildTaskQueueSnapshotEntries(input: {
    tasks: Task[];
    runningTaskId: string | null;
    evaluateTask: (task: Task) => { score: { total: number }; reasons: string[] };
  }): TaskQueueSnapshotEntry[] {
    const scored = input.tasks
      .filter(task => ['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status))
      .map(task => {
        const evaluated = input.evaluateTask(task);
        return {
          task,
          score: evaluated.score.total,
          reason: evaluated.reasons[0] ?? this.defaultQueueSnapshotReason(task),
        };
      });

    scored.sort((left, right) => {
      const statusDelta = this.queueSnapshotStatusRank(right.task, input.runningTaskId)
        - this.queueSnapshotStatusRank(left.task, input.runningTaskId);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return new Date(left.task.createdAt).getTime() - new Date(right.task.createdAt).getTime();
    });

    let runnableOrder = 0;
    return scored.slice(0, this.queueLimit).map(item => {
      const executable = ['running', 'ready', 'created'].includes(item.task.status)
        || (item.task.status === 'parked' && item.task.prioritySignals.isReady);
      let executionOrder = '-';
      if (item.task.id === input.runningTaskId) {
        executionOrder = '正在执行';
      } else if (executable) {
        runnableOrder += 1;
        executionOrder = `第 ${runnableOrder} 顺位`;
      } else if (item.task.status === 'parked') {
        executionOrder = '挂起待恢复';
      } else if (item.task.status === 'blocked') {
        executionOrder = '阻塞待解除';
      }

      return {
        ...item,
        executionOrder,
      };
    });
  }

  formatTaskQueueSnapshot(input: {
    trigger: string;
    runtimeState: RuntimeState;
    entries: TaskQueueSnapshotEntry[];
  }): string[] {
    return [
      '',
      '┌─ 任务队列前五 ───────────────────────────────────┐',
      `│ 触发：${input.trigger}`,
      `│ 总览：执行中 ${input.runtimeState.runningTaskId ? 1 : 0} / 待执行 ${input.runtimeState.readyTaskIds.length} / 挂起 ${input.runtimeState.parkedTaskIds.length} / 阻塞 ${input.runtimeState.blockedTaskIds.length}`,
      ...input.entries.map((entry, index) => this.formatTaskQueueSnapshotEntry(entry, index + 1)),
      '└──────────────────────────────────────────────────┘',
    ];
  }

  formatExecutorRegisterWizardSummary(profile: ExecutorRegisterWizardSummaryInput): string {
    return [
      'Executor 注册信息：',
      `  name=${profile.name ?? '-'}`,
      `  projectUrl=${profile.projectUrl ?? '-'}`,
      `  command=${profile.runtimeCommand ?? '-'}`,
      `  args=${(profile.runtimeArgs ?? []).join(' ') || '{prompt}'}`,
      `  check=${profile.runtimeCheckCommand ?? `which ${profile.runtimeCommand ?? '<command>'}`}`,
      `  domains=${(profile.domains ?? []).join(',') || '-'}`,
      `  capabilities=${(profile.capabilities ?? []).join(',') || '-'}`,
    ].join('\n');
  }

  buildVerificationFailureHint(taskId: string): string {
    return `→ 任务 #${taskId} 已转为阻塞；请补充缺失的测试证据、产物或验收材料后执行 /task resume ${taskId}，或直接说“继续完成刚才的任务”`;
  }

  buildRecoverableFailureHint(taskId: string, errorMessage: string): string {
    if (isPermissionFailure(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞，请先确认相关目录权限或系统授权；确认后执行 /task resume ${taskId}，或直接说“已授权，继续刚才那个任务”`;
    }

    if (/执行器空闲超时|executor idle timeout/i.test(errorMessage)) {
      return `→ 任务 #${taskId} 已转为阻塞；执行器长时间没有输出或状态变化，可能卡住。请检查执行器是否仍在正常推进，必要时补充信息后执行 /task resume ${taskId} 继续`;
    }

    return `→ 任务 #${taskId} 已转为阻塞，排除问题后执行 /task resume ${taskId} 继续`;
  }

  private describeBlockedTaskMissingCondition(reason: string, taskId: string): string {
    if (/材料|文件|链接|文档|资料|补充|缺少|等待/i.test(reason)) {
      return `补充材料/文件/链接后，我会自动恢复；也可执行 /task resume ${taskId} [材料路径]`;
    }

    if (/授权|权限|permission|authorized|access/i.test(reason)) {
      return `确认权限/授权后，直接说“已授权，继续任务 ${taskId}”或执行 /task resume ${taskId}`;
    }

    if (isRecoverableExecutorFailure(reason)) {
      return '等待执行器或网络恢复；定时检查会自动重试';
    }

    return `确认阻塞条件已解除后执行 /task resume ${taskId}`;
  }

  private buildResumeGuidanceReasons(task: Task): string[] {
    const reasons: string[] = [];
    const latestSnapshot = task.snapshots[task.snapshots.length - 1];

    if (/抢占/.test(task.lastInterruptionReason)) {
      reasons.push('刚被高优任务打断，恢复连续性收益最高');
    }

    if (latestSnapshot?.done.length) {
      reasons.push(`上次做到：${latestSnapshot.done.join('；')}`);
    }

    if (latestSnapshot?.nextStep) {
      reasons.push(`下一步已明确：${latestSnapshot.nextStep}`);
    }

    if (reasons.length === 0) {
      reasons.push('上下文已恢复，可继续推进');
    }

    return reasons;
  }

  private queueSnapshotStatusRank(task: Task, runningTaskId: string | null): number {
    if (task.id === runningTaskId || task.status === 'running') {
      return 5;
    }
    if (task.status === 'ready' || task.status === 'created') {
      return 4;
    }
    if (task.status === 'parked' && task.prioritySignals.isReady) {
      return 3;
    }
    if (task.status === 'parked') {
      return 2;
    }
    if (task.status === 'blocked') {
      return 1;
    }
    return 0;
  }

  private defaultQueueSnapshotReason(task: Task): string {
    if (task.status === 'running') {
      return '当前正在执行';
    }
    if (task.status === 'parked') {
      return task.lastInterruptionReason || '任务已挂起';
    }
    if (task.status === 'blocked') {
      return task.dependencies.find(dependency => dependency.status === 'waiting')?.description || '等待解除阻塞';
    }
    if (task.prioritySignals.semanticPriorityReason) {
      return `语义优先级：${task.prioritySignals.semanticPriorityReason}`;
    }
    return task.lastSchedulingReason || '等待调度';
  }

  private formatTaskQueueSnapshotEntry(entry: TaskQueueSnapshotEntry, index: number): string {
    const marker = entry.task.status === 'running'
      ? '执行中'
      : entry.task.status === 'parked'
        ? '挂起'
        : entry.task.status === 'blocked'
          ? '阻塞'
          : entry.task.status === 'ready'
            ? '待执行'
            : '已创建';
    const progress = Math.round(entry.task.prioritySignals.progressRatio * 100);
    return `│ ${index}. [${marker}] #${entry.task.id} ${entry.task.title} | 优先级 ${entry.score.toFixed(1)} | ${entry.executionOrder} | 进度 ${progress}% | ${entry.reason}`;
  }
}
