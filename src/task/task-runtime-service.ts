import type { TaskRepo } from '../storage/task-repo.js';
import type { TaskEngine } from './task-engine.js';
import type { TaskClearScope } from './task-control-types.js';
import type { Dependency, Task, TaskSnapshot, TaskStatus } from '../core/types.js';

export interface TaskRuntimeServiceDeps {
  taskEngine: TaskEngine;
  taskRepo: TaskRepo;
  includeSystemSmoke?: boolean;
}

const CLEAR_SCOPE_STATUSES: Record<TaskClearScope, TaskStatus[]> = {
  all: ['created', 'ready', 'running', 'parked', 'blocked'],
  parked: ['parked'],
  blocked: ['blocked'],
};

/** Task Domain facade. It owns lifecycle commands but contains no scheduling policy. */
export class TaskRuntimeService {
  constructor(private readonly deps: TaskRuntimeServiceDeps) {}

  listTasks(): Task[] {
    return this.deps.taskRepo.findAll({ includeSystemSmoke: this.deps.includeSystemSmoke });
  }

  listActiveTasks(): Task[] {
    return this.deps.taskRepo.findActive({ includeSystemSmoke: this.deps.includeSystemSmoke });
  }

  listTasksByStatus(status: TaskStatus): Task[] {
    return this.deps.taskRepo.findByStatus(status, { includeSystemSmoke: this.deps.includeSystemSmoke });
  }

  findTask(taskId: string): Task | null {
    return this.deps.taskRepo.findById(taskId);
  }

  createTask(input: {
    id?: string;
    projectId?: string;
    title: string;
    goal: string;
    resources?: string[];
    source?: Task['source'];
    smokeRunId?: string | null;
  }): Task {
    return this.deps.taskEngine.create(input);
  }

  updateTask(taskId: string, changes: Partial<Task>): Task | null {
    if (!this.findTask(taskId)) return null;
    this.deps.taskRepo.update(taskId, changes);
    return this.findTask(taskId);
  }

  transitionTask(taskId: string, status: TaskStatus): Task {
    return this.deps.taskEngine.transition(taskId, status);
  }

  cancelTask(taskId: string, reason?: string): Task {
    return this.deps.taskEngine.cancel(taskId, reason);
  }

  parkTask(taskId: string, reason: string, snapshot: Omit<TaskSnapshot, 'createdAt'>): Task {
    return this.deps.taskEngine.park(taskId, reason, snapshot);
  }

  blockTask(taskId: string, dependency: Omit<Dependency, 'createdAt'>): Task {
    return this.deps.taskEngine.block(taskId, dependency);
  }

  unblockTask(taskId: string): Task {
    return this.deps.taskEngine.unblock(taskId);
  }

  resumeParkedTask(taskId: string): Task {
    return this.deps.taskEngine.resume(taskId).task;
  }

  attachResource(taskId: string, resourcePath: string): Task {
    return this.deps.taskEngine.attachResource(taskId, resourcePath);
  }

  getCurrentRunningTask(): Task | null {
    return this.listTasksByStatus('running')[0] ?? null;
  }

  clearTasks(scope: TaskClearScope, reason = `user cleared ${scope} tasks`): {
    cancelled: Task[];
    runningCancelled: boolean;
  } {
    const candidates = this.listTasks().filter(task => CLEAR_SCOPE_STATUSES[scope].includes(task.status));
    const runningCancelled = candidates.some(task => task.status === 'running');
    for (const task of candidates) this.deps.taskEngine.cancel(task.id, reason);
    return { cancelled: candidates, runningCancelled };
  }
}
