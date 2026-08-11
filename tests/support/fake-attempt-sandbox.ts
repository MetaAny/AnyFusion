import { vi } from 'vitest';
import { execFile } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { promisify } from 'node:util';
import type {
  AttemptSandboxPort,
  AttemptSandboxRecord,
  CreateAttemptSandboxInput,
} from '../../src/execution/attempt-sandbox.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';

export interface FakeAttemptSandboxResponse {
  body?: string;
  artifacts?: string[];
  exitCode?: number;
  rawOutput?: string;
  wait?: Promise<number>;
  failure?: {
    kind: 'capability_mismatch' | 'task_failed' | 'quality_failed';
    code: string;
    summary: string;
  };
}

export type FakeAttemptSandboxResponder = (
  input: CreateAttemptSandboxInput,
  attemptIndex: number,
) => FakeAttemptSandboxResponse | Promise<FakeAttemptSandboxResponse>;

export class FakeAttemptSandbox implements AttemptSandboxPort {
  private readonly records = new Map<string, AttemptSandboxRecord>();
  private readonly inputs = new Map<string, CreateAttemptSandboxInput>();
  private readonly responses = new Map<string, FakeAttemptSandboxResponse>();
  private attemptIndex = 0;

  constructor(private readonly responder: FakeAttemptSandboxResponder = () => ({})) {}

  readonly create = vi.fn(async (input: CreateAttemptSandboxInput) => {
    const runtimeHandle = `fake-sandbox-${input.attemptId}`;
    const record: AttemptSandboxRecord = {
      runtimeHandle,
      processId: null,
      status: 'created',
      exitCode: null,
      labels: {
        'metaclaw.managed': 'true',
        'metaclaw.attempt-id': input.attemptId,
      },
    };
    this.records.set(runtimeHandle, record);
    this.inputs.set(runtimeHandle, input);
    this.responses.set(runtimeHandle, await this.responder(input, this.attemptIndex++));
    return record;
  });

  readonly start = vi.fn(async (runtimeHandle: string) => {
    this.updateRecord(runtimeHandle, { status: 'running', processId: 10_000 + this.attemptIndex });
    return this.inspect(runtimeHandle) as Promise<AttemptSandboxRecord>;
  });

  readonly wait = vi.fn(async (runtimeHandle: string) => {
    const response = this.requireResponse(runtimeHandle);
    const exitCode = response.wait ? await response.wait : (response.exitCode ?? 0);
    if (exitCode === 0) {
      const workspacePath = this.requireInput(runtimeHandle).mounts
        .find(mount => mount.target === '/workspace' && mount.mode === 'rw')?.source;
      if (workspacePath) await prepareGitCandidate(workspacePath);
    }
    this.updateRecord(runtimeHandle, { status: 'exited', exitCode });
    return exitCode;
  });

  readonly logs = vi.fn(async (runtimeHandle: string) => {
    const input = this.requireInput(runtimeHandle);
    const response = this.requireResponse(runtimeHandle);
    if (response.rawOutput !== undefined) return response.rawOutput;
    if ((response.exitCode ?? 0) !== 0) return response.body ?? 'fake sandbox failed';
    if (response.failure) {
      return `${response.body ?? response.failure.summary}\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
        failure: response.failure,
      })}`;
    }
    return completionResponseFromSandboxInput(input, response.body, response.artifacts);
  });

  readonly pause = vi.fn(async (runtimeHandle: string) => {
    this.updateRecord(runtimeHandle, { status: 'paused' });
  });

  readonly resume = vi.fn(async (runtimeHandle: string) => {
    this.updateRecord(runtimeHandle, { status: 'running' });
  });

  readonly inspect = vi.fn(async (runtimeHandle: string) => this.records.get(runtimeHandle) ?? null);

  readonly stop = vi.fn(async (runtimeHandle: string) => {
    this.updateRecord(runtimeHandle, { status: 'exited', exitCode: 137 });
  });

  readonly stopProcess = vi.fn(async (_processId: number) => undefined);

  readonly remove = vi.fn(async (runtimeHandle: string) => {
    this.records.delete(runtimeHandle);
  });

  readonly listManaged = vi.fn(async () => [...this.records.values()]);

  private requireInput(runtimeHandle: string): CreateAttemptSandboxInput {
    const input = this.inputs.get(runtimeHandle);
    if (!input) throw new Error(`unknown fake sandbox ${runtimeHandle}`);
    return input;
  }

  private requireResponse(runtimeHandle: string): FakeAttemptSandboxResponse {
    const response = this.responses.get(runtimeHandle);
    if (!response) throw new Error(`unknown fake sandbox ${runtimeHandle}`);
    return response;
  }

  private updateRecord(runtimeHandle: string, changes: Partial<AttemptSandboxRecord>): void {
    const current = this.records.get(runtimeHandle);
    if (!current) throw new Error(`unknown fake sandbox ${runtimeHandle}`);
    this.records.set(runtimeHandle, { ...current, ...changes });
  }
}

const exec = promisify(execFile);

async function prepareGitCandidate(workspacePath: string): Promise<void> {
  const prefix = ['-c', `safe.directory=${workspacePath}`, '-C', workspacePath];
  await exec('git', [...prefix, 'config', 'user.name', 'AnyFusion Test Executor']);
  await exec('git', [...prefix, 'config', 'user.email', 'test-executor@anyfusion.local']);
  await exec('git', [...prefix, 'add', '-A']);
  await exec('git', [...prefix, 'commit', '--allow-empty', '-m', 'test: executor result']);
  await exec('git', [...prefix, 'merge', '--no-edit', 'main']);
}

export function completionResponseFromSandboxInput(
  input: CreateAttemptSandboxInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  const workspaceRoot = input.mounts.find(mount => mount.target === '/workspace')?.source ?? '';
  const resultFilePaths = artifacts.map(path => (
    isAbsolute(path) ? relative(workspaceRoot, path).replaceAll('\\', '/') : path
  ));
  return `${body}\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
    ...(resultFilePaths.length > 0 ? { resultFilePaths } : {}),
  })}`;
}
