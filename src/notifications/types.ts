import type { ExecutionMode, TaskRecoveryTrigger } from '../core/types.js';

export interface TaskCompletedNotification {
  taskId: string;
  title: string;
  summary: string;
  output: string;
  artifactPaths: string[];
  durationMs: number;
  executionMode: ExecutionMode;
  origin: 'user' | 'system';
  recoveryTrigger?: TaskRecoveryTrigger;
}

export interface NotificationService {
  notifyTaskCompleted(input: TaskCompletedNotification): Promise<void>;
}

export class NoopNotificationService implements NotificationService {
  async notifyTaskCompleted(): Promise<void> {
    // Notifications are optional integrations; disabled config should be silent.
  }
}
