// Owns the core task state machine and snapshot persistence primitives.
import type { Task, TaskStatus, TaskSnapshot, Dependency, ResumeSummary } from '../core/types.js';
import type { TaskRepo } from '../storage/task-repo.js';
import { generateTaskId } from '../utils/id.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import dayjs from 'dayjs';

// 合法状态迁移表
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ['ready', 'parked', 'cancelled'],
  ready: ['running', 'parked', 'cancelled'],
  running: ['parked', 'blocked', 'done'],
  parked: ['ready', 'cancelled'],
  blocked: ['ready', 'parked', 'done'],
  done: ['archived'],
  archived: [],
  cancelled: [],
};

/** Encapsulates task creation, state transitions, blocking, parking, resuming, and resource attachment. */
export class TaskEngine {
  constructor(
    private taskRepo: TaskRepo,
    private snapshotDir: string,
  ) {}

  getTaskRepo(): TaskRepo {
    return this.taskRepo;
  }

  /**
   * 列出所有任务
   */
  list(): Task[] {
    return this.taskRepo.findAll();
  }

  /**
   * 创建任务
   */
  create(input: { id?: string; title: string; goal: string; resources?: string[] }): Task {
    const now = new Date().toISOString();
    const taskId = input.id?.trim() ? input.id : generateTaskId();
    const task: Task = {
      id: taskId,
      title: input.title,
      goal: input.goal,
      status: 'created',
      summary: '',
      snapshots: [],
      resources: input.resources || [],
      artifacts: [],
      dependencies: [],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0,
        blocksOthers: false,
        idleHours: 0,
      },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.taskRepo.insert(task);
    return task;
  }

  /**
   * 状态迁移
   */
  transition(taskId: string, targetStatus: TaskStatus, context?: object): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);

    const validTargets = VALID_TRANSITIONS[task.status];
    if (!validTargets.includes(targetStatus)) {
      throw new Error(`非法状态迁移: ${task.status} -> ${targetStatus}`);
    }

    this.taskRepo.updateStatus(taskId, targetStatus);
    return this.taskRepo.findById(taskId)!;
  }

  /**
   * 取消任务。用于批量清理时保留任务审计记录，同时阻止后续调度继续执行。
   */
  cancel(taskId: string, reason = '用户取消任务'): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (['done', 'archived', 'cancelled'].includes(task.status)) {
      throw new Error(`只能取消未完成任务，当前状态: ${task.status}`);
    }

    this.taskRepo.update(taskId, {
      status: 'cancelled',
      lastInterruptionReason: reason,
    });
    return this.taskRepo.findById(taskId)!;
  }

  /**
   * 挂起任务：RUNNING → PARKED
   */
  park(taskId: string, reason: string, snapshot: Omit<TaskSnapshot, 'createdAt'>): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'running') {
      throw new Error(`只能挂起 RUNNING 状态的任务，当前状态: ${task.status}`);
    }

    // 生成快照
    const fullSnapshot: TaskSnapshot = {
      ...snapshot,
      createdAt: new Date().toISOString(),
    };

    // 保存快照到文件
    this.saveSnapshot(taskId, fullSnapshot);

    // 更新任务
    this.taskRepo.appendSnapshot(taskId, fullSnapshot);
    this.taskRepo.updateStatus(taskId, 'parked');

    return this.taskRepo.findById(taskId)!;
  }

  /**
   * 恢复任务：PARKED → READY
   */
  resume(taskId: string): { task: Task; resumeSummary: ResumeSummary } {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'parked') {
      throw new Error(`只能恢复 PARKED 状态的任务，当前状态: ${task.status}`);
    }

    const latestSnapshot = this.getLatestSnapshot(taskId);
    const idleHours = dayjs().diff(dayjs(task.updatedAt), 'hour');

    const resumeSummary: ResumeSummary = {
      taskTitle: task.title,
      lastProgress: latestSnapshot?.done.join('; ') || '尚未开始',
      pauseReason: latestSnapshot?.pauseReason || '未知',
      currentStatus: '已恢复，可以继续',
      nextStep: latestSnapshot?.nextStep || '继续推进任务',
      resources: task.resources,
      idleHours,
    };

    this.taskRepo.updateStatus(taskId, 'ready');
    return { task: this.taskRepo.findById(taskId)!, resumeSummary };
  }

  /**
   * 标记阻塞：RUNNING → BLOCKED
   */
  block(taskId: string, dependency: Omit<Dependency, 'createdAt'>): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'running') {
      throw new Error(`只能阻塞 RUNNING 状态的任务，当前状态: ${task.status}`);
    }

    const fullDep: Dependency = {
      ...dependency,
      createdAt: new Date().toISOString(),
    };

    const dependencies = [...task.dependencies, fullDep];
    this.taskRepo.update(taskId, { dependencies });
    this.taskRepo.updateStatus(taskId, 'blocked');

    return this.taskRepo.findById(taskId)!;
  }

  /**
   * 解除阻塞：BLOCKED → READY
   */
  unblock(taskId: string): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'blocked') {
      throw new Error(`只能解除 BLOCKED 状态的任务，当前状态: ${task.status}`);
    }

    // 标记所有依赖为已解决
    const dependencies = task.dependencies.map(d => ({ ...d, status: 'resolved' as const }));
    this.taskRepo.update(taskId, { dependencies });
    this.taskRepo.updateStatus(taskId, 'ready');

    return this.taskRepo.findById(taskId)!;
  }

  /**
   * 关联资源
   */
  attachResource(taskId: string, resourcePath: string): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);

    const resources = Array.from(new Set([...task.resources, resourcePath]));
    this.taskRepo.update(taskId, { resources });

    return this.taskRepo.findById(taskId)!;
  }

  /**
   * 获取最新快照
   */
  getLatestSnapshot(taskId: string): TaskSnapshot | null {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.snapshots.length === 0) return null;
    return task.snapshots[task.snapshots.length - 1];
  }

  /**
   * 保存快照到文件
   */
  private saveSnapshot(taskId: string, snapshot: TaskSnapshot): void {
    const taskSnapshotDir = resolve(this.snapshotDir, taskId);
    if (!existsSync(taskSnapshotDir)) {
      mkdirSync(taskSnapshotDir, { recursive: true });
    }

    const filename = `snapshot_${Date.now()}.json`;
    const filepath = resolve(taskSnapshotDir, filename);
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }
}
