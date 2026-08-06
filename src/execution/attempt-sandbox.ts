export type SandboxMountMode = 'ro' | 'rw';

/** Execution backends supported by the Runtime. */
export type AttemptSandboxKind = 'container' | 'worktree';

/** Whether Executor prompts use container aliases or native Runtime paths. */
export type AttemptSandboxPathMode = 'container' | 'native';

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
  imageRef: string;
  resolvedImageId: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  mounts: AttemptSandboxMount[];
  controlNetwork: string;
  egressMode: 'disabled' | 'proxy';
  nestedSandbox?: 'codex-workspace-write';
  limits: AttemptSandboxLimits;
}

export interface AttemptSandboxRecord {
  containerId: string;
  imageId: string;
  status: 'created' | 'running' | 'paused' | 'exited' | 'missing';
  exitCode: number | null;
  labels: Record<string, string>;
}

export interface AttemptSandboxPort {
  readonly kind?: AttemptSandboxKind;
  readonly pathMode?: AttemptSandboxPathMode;
  resolveImage(imageRef: string): Promise<string>;
  probeControlNetwork?(controlNetwork: string): Promise<void>;
  create(input: CreateAttemptSandboxInput): Promise<AttemptSandboxRecord>;
  start(containerId: string): Promise<void>;
  wait(containerId: string): Promise<number>;
  logs(containerId: string): Promise<string>;
  pause(containerId: string): Promise<void>;
  resume(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<AttemptSandboxRecord | null>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
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
