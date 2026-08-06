import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AttemptSandboxPort,
  AttemptSandboxRecord,
  CreateAttemptSandboxInput,
} from './attempt-sandbox.js';

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = 'io.metaclaw.attempt-sandbox';

export interface DockerCommandRunner {
  run(args: string[]): Promise<string>;
}

export interface DockerCliAttemptSandboxOptions {
  /** Maps paths visible in a containerized control plane to paths understood by the sibling-container Engine. */
  sourcePathMappings?: Record<string, string>;
}

class DockerCliCommandRunner implements DockerCommandRunner {
  async run(args: string[]): Promise<string> {
    const result = await execFileAsync('docker', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return `${result.stdout}${result.stderr}`.trim();
  }
}

interface DockerInspectPayload {
  Id: string;
  Image: string;
  State: { Status: string; ExitCode: number; Paused?: boolean };
  Config: { Labels?: Record<string, string> };
}

export class DockerCliAttemptSandboxAdapter implements AttemptSandboxPort {
  readonly kind = 'container' as const;
  readonly pathMode = 'container' as const;
  private readonly sourcePathMappings: Array<[string, string]>;

  constructor(
    private readonly runner: DockerCommandRunner = new DockerCliCommandRunner(),
    options: DockerCliAttemptSandboxOptions = {},
  ) {
    const mappings = options.sourcePathMappings ?? mappingsFromEnvironment();
    this.sourcePathMappings = Object.entries(mappings)
      .map(([containerPath, enginePath]) => [trimTrailingSeparator(containerPath), trimTrailingSeparator(enginePath)] as [string, string])
      .sort((left, right) => right[0].length - left[0].length);
  }

  async resolveImage(imageRef: string): Promise<string> {
    if (!imageRef.trim()) throw new Error('attempt image reference is required');
    return this.runner.run(['image', 'inspect', '--format', '{{.Id}}', imageRef]);
  }

  async probeControlNetwork(controlNetwork: string): Promise<void> {
    if (!controlNetwork.trim() || controlNetwork === 'host' || controlNetwork === 'none') {
      throw new Error('attempt sandbox requires a dedicated MetaClaw control network');
    }
    const internal = await this.runner.run([
      'network', 'inspect', '--format', '{{.Internal}}', controlNetwork,
    ]);
    if (internal.trim().toLowerCase() !== 'true') {
      throw new Error('MetaClaw control network must be Docker-internal');
    }
  }

  async create(input: CreateAttemptSandboxInput): Promise<AttemptSandboxRecord> {
    this.validateCreateInput(input);
    const currentImageId = await this.resolveImage(input.imageRef);
    if (currentImageId !== input.resolvedImageId) {
      throw new Error(`AgentClass image drift: expected ${input.resolvedImageId}, got ${currentImageId}`);
    }
    await this.probeControlNetwork(input.controlNetwork);

    const labels = {
      [MANAGED_LABEL]: 'true',
      'io.metaclaw.task-id': input.taskId,
      'io.metaclaw.generation-id': input.generationId,
      'io.metaclaw.subtask-id': input.subtaskId,
      'io.metaclaw.attempt-id': input.attemptId,
      'io.metaclaw.work-unit-id': input.workUnitId,
      'io.metaclaw.lease-token': input.leaseToken,
      'io.metaclaw.idempotency-key': input.idempotencyKey,
    };
    const args = [
      'create',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      ...(input.nestedSandbox === 'codex-workspace-write' ? ['--security-opt=seccomp=unconfined'] : []),
      '--user=1000:1000',
      `--pids-limit=${input.limits.pids}`,
      `--memory=${input.limits.memoryBytes}`,
      `--cpus=${input.limits.cpus}`,
      '--log-driver=json-file',
      `--log-opt=max-size=${input.limits.logSize}`,
      `--log-opt=max-file=${input.limits.logFiles}`,
      `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${input.limits.tmpfsBytes}`,
      `--network=${input.controlNetwork}`,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      ...Object.entries(input.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      ...input.mounts.flatMap(mount => [
        '--mount',
        `type=bind,src=${this.engineSourcePath(mount.source)},dst=${mount.target}${mount.mode === 'ro' ? ',readonly' : ''}`,
      ]),
      input.imageRef,
      input.command,
      ...input.args,
    ];
    const containerId = await this.runner.run(args);
    return { containerId, imageId: currentImageId, status: 'created', exitCode: null, labels };
  }

  async start(containerId: string): Promise<void> {
    await this.runner.run(['start', containerId]);
  }

  async wait(containerId: string): Promise<number> {
    const output = await this.runner.run(['wait', containerId]);
    const exitCode = Number.parseInt(output, 10);
    if (!Number.isInteger(exitCode)) throw new Error(`invalid Docker exit code: ${output}`);
    return exitCode;
  }

  async logs(containerId: string): Promise<string> {
    return this.runner.run(['logs', containerId]);
  }

  async pause(containerId: string): Promise<void> {
    await this.runner.run(['pause', containerId]);
  }

  async resume(containerId: string): Promise<void> {
    await this.runner.run(['unpause', containerId]);
  }

  async inspect(containerId: string): Promise<AttemptSandboxRecord | null> {
    try {
      const output = await this.runner.run(['inspect', containerId]);
      const payload = (JSON.parse(output) as DockerInspectPayload[])[0];
      if (!payload) return null;
      return this.fromInspect(payload);
    } catch (error) {
      if (error instanceof Error && /no such (object|container)/iu.test(error.message)) return null;
      throw error;
    }
  }

  async stop(containerId: string): Promise<void> {
    const existing = await this.inspect(containerId);
    if (!existing || existing.status === 'exited') return;
    await this.runner.run(['stop', '--time', '10', containerId]);
  }

  async remove(containerId: string): Promise<void> {
    const existing = await this.inspect(containerId);
    if (!existing) return;
    if (existing.status !== 'exited' && existing.status !== 'created') {
      throw new Error('attempt sandbox must be stopped before removal');
    }
    await this.runner.run(['rm', containerId]);
  }

  async listManaged(): Promise<AttemptSandboxRecord[]> {
    const ids = (await this.runner.run([
      'ps', '-aq', '--filter', `label=${MANAGED_LABEL}=true`,
    ])).split(/\s+/u).filter(Boolean);
    const records = await Promise.all(ids.map(id => this.inspect(id)));
    return records.filter((record): record is AttemptSandboxRecord => Boolean(record));
  }

  private validateCreateInput(input: CreateAttemptSandboxInput): void {
    if (!input.resolvedImageId.startsWith('sha256:')) {
      throw new Error('resolved image ID must be immutable');
    }
    if (!input.controlNetwork.trim() || input.controlNetwork === 'host' || input.controlNetwork === 'none') {
      throw new Error('attempt sandbox requires a dedicated MetaClaw control network');
    }
    if (input.nestedSandbox === 'codex-workspace-write' && input.imageRef !== 'metaclaw-executor-codex:phase5') {
      throw new Error('nested Codex sandbox syscall profile is restricted to the canonical pinned Codex image');
    }
    const targets = new Set<string>();
    for (const mount of input.mounts) {
      const source = mount.source.toLowerCase();
      if (source.includes('docker.sock') || source.includes('docker_engine') || source.includes('pipe/docker')) {
        throw new Error('Docker Engine endpoints cannot be mounted into attempt sandboxes');
      }
      if (!mount.target.startsWith('/') || targets.has(mount.target)) {
        throw new Error(`invalid or duplicate sandbox mount target: ${mount.target}`);
      }
      targets.add(mount.target);
    }
    const workspace = input.mounts.find(mount => mount.target === '/workspace');
    if (!workspace || workspace.mode !== 'rw') throw new Error('/workspace must be the only explicit writable workspace mount');
    for (const target of ['/source', '/inputs', '/handoffs', '/workspace/.git']) {
      const mount = input.mounts.find(candidate => candidate.target === target);
      if (mount && mount.mode !== 'ro') throw new Error(`${target} must be read-only`);
    }
    if (input.egressMode === 'proxy') {
      const proxy = input.environment.HTTPS_PROXY ?? input.environment.HTTP_PROXY;
      if (!proxy || !/^http:\/\/metaclaw-egress(?::\d+)?\/?$/u.test(proxy)) {
        throw new Error('public-web-research requires the policy egress proxy on the internal control network');
      }
    }
  }

  private fromInspect(payload: DockerInspectPayload): AttemptSandboxRecord {
    const status = payload.State.Paused
      ? 'paused'
      : payload.State.Status === 'running'
        ? 'running'
        : payload.State.Status === 'created'
          ? 'created'
          : 'exited';
    return {
      containerId: payload.Id,
      imageId: payload.Image,
      status,
      exitCode: status === 'exited' ? payload.State.ExitCode : null,
      labels: payload.Config.Labels ?? {},
    };
  }

  private engineSourcePath(source: string): string {
    if (this.sourcePathMappings.length === 0) return source;
    const mapping = this.sourcePathMappings.find(([containerPath]) => (
      source === containerPath || source.startsWith(`${containerPath}/`) || source.startsWith(`${containerPath}\\`)
    ));
    if (!mapping) throw new Error(`sandbox mount is outside configured Engine path mappings: ${source}`);
    const [containerPath, enginePath] = mapping;
    const suffix = source.slice(containerPath.length).replace(/^[/\\]+/u, '');
    if (!suffix) return enginePath;
    const separator = enginePath.includes('\\') ? '\\' : '/';
    return `${enginePath}${separator}${suffix.replaceAll(/[\\/]/gu, separator)}`;
  }
}

function mappingsFromEnvironment(): Record<string, string> {
  const raw = process.env.METACLAW_DOCKER_HOST_PATH_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) {
      throw new Error('mapping keys and values must be non-empty strings');
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    throw new Error(`invalid METACLAW_DOCKER_HOST_PATH_MAP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trimTrailingSeparator(value: string): string {
  return value.replace(/[\\/]+$/u, '');
}
