import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type {
  AttemptSandboxPort,
  AttemptSandboxRecord,
  CreateAttemptSandboxInput,
} from './attempt-sandbox.js';

const MANAGED_LABEL = 'io.metaclaw.attempt-sandbox';
const MAX_LOG_BYTES = 16 * 1024 * 1024;

interface WorktreeAttempt {
  input: CreateAttemptSandboxInput;
  record: AttemptSandboxRecord;
  workspacePath: string;
  child: ChildProcess | null;
  logs: string;
  waitPromise: Promise<number> | null;
  resolveWait: ((exitCode: number) => void) | null;
}

/**
 * Runs an Executor CLI as a child process in its already-isolated Git worktree.
 *
 * This deliberately implements the existing AttemptSandboxPort so the durable
 * attempt, cancellation, checkpoint, and recovery paths remain unchanged while
 * the Runtime moves away from sibling Executor containers.
 */
export class WorktreeAttemptSandboxAdapter implements AttemptSandboxPort {
  readonly kind = 'worktree' as const;
  readonly pathMode = 'native' as const;
  private readonly attempts = new Map<string, WorktreeAttempt>();

  async resolveImage(imageRef: string): Promise<string> {
    if (!imageRef.trim()) throw new Error('executor runtime profile is required');
    return `sha256:${createHash('sha256').update(`worktree:${imageRef}`).digest('hex')}`;
  }

  async probeControlNetwork(_controlNetwork: string): Promise<void> {
    // Native Executor processes share the Runtime network namespace. The
    // Docker-internal network check is only meaningful for container attempts.
  }

  async create(input: CreateAttemptSandboxInput): Promise<AttemptSandboxRecord> {
    const workspace = input.mounts.find(mount => mount.target === '/workspace');
    if (!workspace || workspace.mode !== 'rw') {
      throw new Error('worktree attempt requires one writable /workspace binding');
    }
    if (!input.command.trim()) throw new Error('worktree executor command is required');
    const workspaceInfo = await stat(workspace.source).catch(() => null);
    if (!workspaceInfo?.isDirectory()) {
      throw new Error(`worktree workspace does not exist: ${workspace.source}`);
    }
    const containerId = `worktree:${input.attemptId}`;
    const labels = {
      [MANAGED_LABEL]: 'true',
      'io.metaclaw.execution-backend': 'worktree',
      'io.metaclaw.task-id': input.taskId,
      'io.metaclaw.generation-id': input.generationId,
      'io.metaclaw.subtask-id': input.subtaskId,
      'io.metaclaw.attempt-id': input.attemptId,
      'io.metaclaw.work-unit-id': input.workUnitId,
      'io.metaclaw.lease-token': input.leaseToken,
      'io.metaclaw.idempotency-key': input.idempotencyKey,
    };
    const record: AttemptSandboxRecord = {
      containerId,
      imageId: await this.resolveImage(input.imageRef),
      status: 'created',
      exitCode: null,
      labels,
    };
    this.attempts.set(containerId, {
      input,
      record,
      workspacePath: workspace.source,
      child: null,
      logs: '',
      waitPromise: null,
      resolveWait: null,
    });
    return record;
  }

  async start(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    if (attempt.child) return;
    const child = spawn(attempt.input.command, attempt.input.args, {
      cwd: attempt.workspacePath,
      env: {
        ...process.env,
        ...attempt.input.environment,
        METACLAW_EXECUTION_BACKEND: 'worktree',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    attempt.child = child;
    attempt.record.status = 'running';
    attempt.waitPromise = new Promise(resolve => {
      attempt.resolveWait = resolve;
    });
    const append = (chunk: Buffer | string) => {
      if (attempt.logs.length >= MAX_LOG_BYTES) return;
      const remaining = MAX_LOG_BYTES - Buffer.byteLength(attempt.logs, 'utf8');
      attempt.logs += Buffer.from(chunk).toString('utf8').slice(0, remaining);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', error => {
      append(`\n${error instanceof Error ? error.message : String(error)}\n`);
      this.finish(attempt, 127);
    });
    child.once('exit', (code, signal) => {
      if (signal) append(`\nprocess terminated by ${signal}\n`);
      this.finish(attempt, code ?? 1);
    });
  }

  async wait(containerId: string): Promise<number> {
    const attempt = this.requireAttempt(containerId);
    if (!attempt.waitPromise) {
      if (attempt.record.status === 'created') throw new Error('worktree attempt has not started');
      return attempt.record.exitCode ?? 1;
    }
    return attempt.waitPromise;
  }

  async logs(containerId: string): Promise<string> {
    return this.requireAttempt(containerId).logs;
  }

  async pause(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || attempt.record.status !== 'running') return;
    if (process.platform === 'win32') throw new Error('worktree attempt pause is unavailable on Windows');
    process.kill(-pid, 'SIGSTOP');
    attempt.record.status = 'paused';
  }

  async resume(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || attempt.record.status !== 'paused') return;
    if (process.platform === 'win32') throw new Error('worktree attempt resume is unavailable on Windows');
    process.kill(-pid, 'SIGCONT');
    attempt.record.status = 'running';
  }

  async inspect(containerId: string): Promise<AttemptSandboxRecord | null> {
    const attempt = this.attempts.get(containerId);
    return attempt ? { ...attempt.record, labels: { ...attempt.record.labels } } : null;
  }

  async stop(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    const pid = attempt.child?.pid;
    if (!pid || ['created', 'exited', 'missing'].includes(attempt.record.status)) return;
    try {
      if (process.platform === 'win32') attempt.child?.kill('SIGTERM');
      else process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (attempt.waitPromise) {
      await Promise.race([
        attempt.waitPromise,
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
      if (attempt.record.status !== 'exited') {
        try {
          if (process.platform === 'win32') attempt.child?.kill('SIGKILL');
          else process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await attempt.waitPromise;
      }
    }
  }

  async remove(containerId: string): Promise<void> {
    const attempt = this.requireAttempt(containerId);
    if (!['created', 'exited', 'missing'].includes(attempt.record.status)) {
      throw new Error('worktree attempt must be stopped before removal');
    }
    this.attempts.delete(containerId);
  }

  async listManaged(): Promise<AttemptSandboxRecord[]> {
    return [...this.attempts.values()].map(attempt => ({
      ...attempt.record,
      labels: { ...attempt.record.labels },
    }));
  }

  private requireAttempt(containerId: string): WorktreeAttempt {
    const attempt = this.attempts.get(containerId);
    if (!attempt) throw new Error(`worktree attempt not found: ${containerId}`);
    return attempt;
  }

  private finish(attempt: WorktreeAttempt, exitCode: number): void {
    if (attempt.record.status === 'exited') return;
    attempt.record.status = 'exited';
    attempt.record.exitCode = exitCode;
    attempt.resolveWait?.(exitCode);
    attempt.resolveWait = null;
  }
}
