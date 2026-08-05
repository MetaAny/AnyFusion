import { vi } from 'vitest';
import type {
  AttemptSandboxPort,
  AttemptSandboxRecord,
  CreateAttemptSandboxInput,
} from '../../src/execution/attempt-sandbox.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';

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

  readonly resolveImage = vi.fn(async (_imageRef: string) => `sha256:${'a'.repeat(64)}`);

  readonly create = vi.fn(async (input: CreateAttemptSandboxInput) => {
    const containerId = `fake-sandbox-${input.attemptId}`;
    const record: AttemptSandboxRecord = {
      containerId,
      imageId: input.resolvedImageId,
      status: 'created',
      exitCode: null,
      labels: {
        'metaclaw.managed': 'true',
        'metaclaw.attempt-id': input.attemptId,
      },
    };
    this.records.set(containerId, record);
    this.inputs.set(containerId, input);
    this.responses.set(containerId, await this.responder(input, this.attemptIndex++));
    return record;
  });

  readonly start = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'running' });
  });

  readonly wait = vi.fn(async (containerId: string) => {
    const response = this.requireResponse(containerId);
    const exitCode = response.wait ? await response.wait : (response.exitCode ?? 0);
    this.updateRecord(containerId, { status: 'exited', exitCode });
    return exitCode;
  });

  readonly logs = vi.fn(async (containerId: string) => {
    const input = this.requireInput(containerId);
    const response = this.requireResponse(containerId);
    if (response.rawOutput !== undefined) return response.rawOutput;
    if ((response.exitCode ?? 0) !== 0) return response.body ?? 'fake sandbox failed';
    if (response.failure) {
      return `${response.body ?? response.failure.summary}\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
        failure: response.failure,
      })}`;
    }
    return completionResponseFromSandboxInput(input, response.body, response.artifacts);
  });

  readonly pause = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'paused' });
  });

  readonly resume = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'running' });
  });

  readonly inspect = vi.fn(async (containerId: string) => this.records.get(containerId) ?? null);

  readonly stop = vi.fn(async (containerId: string) => {
    this.updateRecord(containerId, { status: 'exited', exitCode: 137 });
  });

  readonly remove = vi.fn(async (containerId: string) => {
    this.records.delete(containerId);
  });

  readonly listManaged = vi.fn(async () => [...this.records.values()]);

  private requireInput(containerId: string): CreateAttemptSandboxInput {
    const input = this.inputs.get(containerId);
    if (!input) throw new Error(`unknown fake sandbox ${containerId}`);
    return input;
  }

  private requireResponse(containerId: string): FakeAttemptSandboxResponse {
    const response = this.responses.get(containerId);
    if (!response) throw new Error(`unknown fake sandbox ${containerId}`);
    return response;
  }

  private updateRecord(containerId: string, changes: Partial<AttemptSandboxRecord>): void {
    const current = this.records.get(containerId);
    if (!current) throw new Error(`unknown fake sandbox ${containerId}`);
    this.records.set(containerId, { ...current, ...changes });
  }
}

export function completionResponseFromSandboxInput(
  input: CreateAttemptSandboxInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  const isEdit = input.args.join('\n').includes('Delivery kind: edit');
  return `${body}\n\n${COMPLETION_MARKER_V3}\n${JSON.stringify({
    evidence: ['tests were not run: deterministic fake sandbox'],
    noChangeReason: isEdit && artifacts.length === 0
      ? 'The deterministic test executor made no workspace changes.'
      : null,
  })}`;
}
