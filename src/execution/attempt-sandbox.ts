export type SandboxMountMode = 'ro' | 'rw';

/** Execution backends supported by the Runtime. */
export type AttemptSandboxKind = 'worktree';

/** Whether Executor prompts use container aliases or native Runtime paths. */
export type AttemptSandboxPathMode = 'native';

export interface AttemptSandboxMount {
  source: string;
  target: string;
  mode: SandboxMountMode;
}

export interface AttemptSandboxLimits {
  cpus: number;
  memoryBytes: number;
  pids: number;
  tmpfsBytes: number;
  logSize: string;
  logFiles: number;
}

export interface CreateAttemptSandboxInput {
  attemptId: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  workUnitId: string;
  leaseToken: string;
  idempotencyKey: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  mounts: AttemptSandboxMount[];
  egressMode: 'disabled' | 'proxy';
  nestedSandbox?: 'codex-workspace-write';
  limits: AttemptSandboxLimits;
}

export interface AttemptSandboxRecord {
  runtimeHandle: string;
  processId: number | null;
  status: 'created' | 'running' | 'paused' | 'exited' | 'missing';
  exitCode: number | null;
  labels: Record<string, string>;
}

export interface AttemptSandboxPort {
  readonly kind?: AttemptSandboxKind;
  readonly pathMode?: AttemptSandboxPathMode;
  create(input: CreateAttemptSandboxInput): Promise<AttemptSandboxRecord>;
  start(runtimeHandle: string): Promise<AttemptSandboxRecord>;
  wait(runtimeHandle: string): Promise<number>;
  logs(runtimeHandle: string): Promise<string>;
  pause(runtimeHandle: string): Promise<void>;
  resume(runtimeHandle: string): Promise<void>;
  inspect(runtimeHandle: string): Promise<AttemptSandboxRecord | null>;
  stop(runtimeHandle: string): Promise<void>;
  stopProcess(processId: number): Promise<void>;
  remove(runtimeHandle: string): Promise<void>;
  listManaged(): Promise<AttemptSandboxRecord[]>;
}

export const DEFAULT_ATTEMPT_SANDBOX_LIMITS: AttemptSandboxLimits = {
  cpus: 2,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
  tmpfsBytes: 512 * 1024 * 1024,
  logSize: '10m',
  logFiles: 3,
};
