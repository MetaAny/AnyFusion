import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentClass, ExecutorResult } from '../core/types.js';
import type { AttemptSandboxPort } from '../execution/attempt-sandbox.js';
import { DEFAULT_ATTEMPT_SANDBOX_LIMITS } from '../execution/attempt-sandbox.js';
import type { ExecutorAdapter, ExecutorInput } from './adapter.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';
import { buildExecutorContextPrompt } from './prompt-builder.js';
import type { AttemptSandboxRepositoryPort } from '../execution/repositories.js';
import { buildEnvFromFile } from '../utils/env-file.js';
import { AttemptModelGatewayServer } from '../execution/attempt-model-gateway.js';
import { normalizeExecutorFailure } from './error-utils.js';

const EXECUTOR_PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
] as const;

const SANDBOX_SAFE_PROVIDER_ENV_KEYS = [
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
] as const;

interface NativeExecutorEnvironment {
  environment: Record<string, string>;
  temporaryRoot: string;
}

export class SandboxedExecutorAdapter implements ExecutorAdapter {
  readonly name: string;
  readonly supportsContinuation = false;
  private readonly activeContainers = new Map<string, string>();

  constructor(
    private readonly agentClass: AgentClass,
    private readonly sandbox: AttemptSandboxPort,
    private readonly repository?: AttemptSandboxRepositoryPort,
  ) {
    this.name = agentClass.name;
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const binding = input.sandbox;
    if (!binding) return failed('sandbox binding is required', 'sandbox_binding_missing', startedAt);
    if (!this.agentClass.permissionProfileId) {
      return failed(`AgentClass ${this.name} has no permission profile`, 'agent_class_sandbox_unconfigured', startedAt);
    }
    const worktreeBackend = (this.sandbox.kind ?? 'container') === 'worktree';
    if (worktreeBackend && !['codex-cli', 'pi-agent'].includes(this.name)) {
      return failed(
        `Worktree execution supports only canonical Codex and Pi AgentClasses: ${this.name}`,
        'worktree_executor_not_canonical',
        startedAt,
      );
    }
    const nativePaths = (this.sandbox.pathMode
      ?? (this.sandbox.kind === 'worktree' ? 'native' : 'container')) === 'native';
    const usesDockerProxy = !nativePaths && this.agentClass.permissionProfileId === 'public-web-research';
    const executionWorkspacePath = nativePaths ? binding.workspacePath : '/workspace';
    const resultPath = join(binding.workspacePath, '.metaclaw', 'results', `${binding.attemptId}.md`);
    const prompt = buildExecutorContextPrompt({
      ...input,
      context: {
        ...input.context,
        workspaceContext: {
          ...input.context.workspaceContext,
          workingDirectory: executionWorkspacePath,
          targetPaths: input.context.workspaceContext.targetPaths.map(target => (
            nativePaths
              ? target
              : target === binding.workspacePath || target.startsWith(`${binding.workspacePath}/`) || target.startsWith(`${binding.workspacePath}\\`)
              ? `/workspace${target.slice(binding.workspacePath.length).replaceAll('\\', '/')}`
              : target
          )),
        },
      },
    });
    const { command, args } = this.commandAndArgs(
      prompt,
      `${executionWorkspacePath}/.metaclaw/results/${binding.attemptId}.md`,
      input,
      nativePaths,
    );
    let modelGateway: AttemptModelGatewayServer | null = null;
    let nativeExecutorTemporaryRoot: string | null = null;
    try {
      const providerEnvironment = this.providerEnvironment();
      const upstreamBaseUrl = providerEnvironment.OPENAI_BASE_URL;
      const upstreamApiKey = providerEnvironment.OPENAI_API_KEY;
      if (!upstreamBaseUrl || !upstreamApiKey) {
        throw new Error('attempt model gateway requires OPENAI_BASE_URL and OPENAI_API_KEY');
      }
      const sandboxProviderEnvironment = Object.fromEntries(SANDBOX_SAFE_PROVIDER_ENV_KEYS.flatMap(key => {
        const value = providerEnvironment[key];
        return value ? [[key, value]] : [];
      }));
      modelGateway = new AttemptModelGatewayServer({
        upstreamBaseUrl,
        upstreamApiKey,
        advertisedHost: nativePaths ? '127.0.0.1' : process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control',
      });
      const gateway = await modelGateway.start();
      sandboxProviderEnvironment.OPENAI_BASE_URL = gateway.baseUrl;
      sandboxProviderEnvironment.OPENAI_API_KEY = gateway.apiKey;
      const nativeExecutor = nativePaths
        ? await this.prepareNativeExecutorEnvironment(upstreamBaseUrl, gateway.baseUrl)
        : null;
      nativeExecutorTemporaryRoot = nativeExecutor?.temporaryRoot ?? null;
      const imageRef = this.agentClass.executionImageRef ?? `worktree:${this.name}`;
      const resolvedImageId = this.agentClass.resolvedImageId ?? await this.sandbox.resolveImage(imageRef);
      const record = await this.sandbox.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        leaseToken: binding.leaseToken,
        idempotencyKey: binding.idempotencyKey,
        imageRef,
        resolvedImageId,
        command,
        args,
        environment: {
          ...nativeExecutor?.environment,
          ...sandboxProviderEnvironment,
          METACLAW_ATTEMPT_ID: binding.attemptId,
          METACLAW_CAPABILITY_MCP_URL: binding.capabilityBinding?.mcpUrl ?? '',
          METACLAW_CAPABILITY_URL: binding.capabilityBinding?.jsonUrl ?? '',
          METACLAW_CAPABILITY_USE_URL: binding.capabilityBinding?.useUrl ?? '',
          METACLAW_CAPABILITY_TOKEN: binding.capabilityBinding?.bearerToken ?? '',
          METACLAW_EVIDENCE_MCP_URL: input.context.evidenceTools.binding?.mcpUrl ?? '',
          METACLAW_EVIDENCE_JSON_URL: input.context.evidenceTools.binding?.jsonUrl ?? '',
          METACLAW_EVIDENCE_TOKEN: input.context.evidenceTools.binding?.bearerToken ?? '',
          ...(usesDockerProxy ? {
            HTTP_PROXY: 'http://metaclaw-egress:8080',
            HTTPS_PROXY: 'http://metaclaw-egress:8080',
            NO_PROXY: 'metaclaw-control',
          } : {}),
        },
        mounts: [
          { source: binding.workspacePath, target: '/workspace', mode: 'rw' },
          { source: binding.sourcePath, target: '/source', mode: 'ro' },
          { source: binding.inputsPath, target: '/inputs', mode: 'ro' },
          { source: binding.handoffsPath, target: '/handoffs', mode: 'ro' },
          ...(binding.gitMetadataPath
            ? [{ source: binding.gitMetadataPath, target: '/workspace/.git', mode: 'ro' as const }]
            : []),
        ],
        controlNetwork: binding.controlNetwork,
        egressMode: usesDockerProxy ? 'proxy' : 'disabled',
        nestedSandbox: !nativePaths && this.name === 'codex-cli' ? 'codex-workspace-write' : undefined,
        limits: DEFAULT_ATTEMPT_SANDBOX_LIMITS,
      });
      const createdAt = new Date().toISOString();
      this.repository?.create({
        attemptId: binding.attemptId,
        taskId: binding.taskId,
        generationId: binding.generationId,
        subtaskId: binding.subtaskId,
        workUnitId: binding.workUnitId,
        workspaceId: binding.workspaceId,
        containerId: record.containerId,
        imageRef,
        imageId: record.imageId,
        status: 'created',
        leaseToken: binding.leaseToken,
        labels: record.labels,
        exitCode: null,
        resultCollectedAt: null,
        cleanupStatus: null,
        cleanupError: null,
        createdAt,
        updatedAt: createdAt,
      });
      this.activeContainers.set(binding.attemptId, record.containerId);
      binding.onContainerCreated?.(record.containerId);
      input.onProgress?.({ kind: 'status', text: `${this.sandbox.kind ?? 'container'} execution ${record.containerId.slice(0, 12)} started` });
      await this.sandbox.start(record.containerId);
      this.repository?.update(binding.attemptId, { status: 'running', updatedAt: new Date().toISOString() });
      const exitCode = await this.sandbox.wait(record.containerId);
      const logs = await this.sandbox.logs(record.containerId);
      this.repository?.update(binding.attemptId, {
        status: 'exited', exitCode, resultCollectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      let output = logs.trim();
      if (this.name === 'codex-cli' && exitCode === 0) {
        output = (await readFile(resultPath, 'utf8').catch(() => logs)).trim();
      }
      if (output && !nativePaths) {
        const runtimeWorkspacePath = binding.workspacePath.replaceAll('\\', '/');
        output = output.replaceAll(/\/workspace(?=\/|[\s`"')\]}]|$)/gu, runtimeWorkspacePath);
      }
      await this.sandbox.remove(record.containerId);
      this.repository?.update(binding.attemptId, { status: 'removed', cleanupStatus: 'removed', updatedAt: new Date().toISOString() });
      this.activeContainers.delete(binding.attemptId);
      return exitCode === 0 && output
        ? { success: true, output, exitCode, durationMs: Date.now() - startedAt }
        : failedExecution(logs.trim() || `sandbox exited with code ${exitCode}`, startedAt, exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let cleanupError: string | null = null;
      const activeContainerId = this.activeContainers.get(binding.attemptId) ?? null;
      if (activeContainerId) {
        try {
          await this.sandbox.stop(activeContainerId);
          await this.sandbox.remove(activeContainerId);
          this.repository?.update(binding.attemptId, {
            status: 'removed', cleanupStatus: 'removed', cleanupError: null, updatedAt: new Date().toISOString(),
          });
        } catch (cleanup) {
          cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup);
        }
      }
      if (cleanupError || !activeContainerId) {
        this.repository?.update(binding.attemptId, {
          cleanupStatus: 'failed', cleanupError: cleanupError ?? message, updatedAt: new Date().toISOString(),
        });
      }
      this.activeContainers.delete(binding.attemptId);
      return failed(message, 'sandbox_configuration_failure', startedAt);
    } finally {
      await modelGateway?.close().catch(() => undefined);
      if (nativeExecutorTemporaryRoot) {
        await rm(nativeExecutorTemporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async probe(
    previousFailure?: import('../core/kernel-failure.js').KernelFailure | null,
  ): Promise<import('./adapter.js').ExecutorProbeResult> {
    if (this.sandbox.kind === 'worktree' && !['codex-cli', 'pi-agent'].includes(this.name)) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'worktree_executor_not_canonical',
          summary: `Worktree execution supports only canonical Codex and Pi AgentClasses: ${this.name}`,
        },
      };
    }
    if (!this.agentClass.permissionProfileId || (!this.agentClass.runtimeCommand && this.name !== 'codex-cli' && this.name !== 'pi-agent')) {
      return {
        available: false,
        failure: {
          kind: 'configuration',
          scope: 'agent_class',
          code: 'agent_class_sandbox_unconfigured',
          summary: `AgentClass ${this.name} has no verified image or permission profile`,
        },
      };
    }
    try {
      if (this.sandbox.kind !== 'worktree') {
        if (!this.agentClass.executionImageRef || !this.agentClass.resolvedImageId) {
          return {
            available: false,
            failure: {
              kind: 'configuration',
              scope: 'agent_class',
              code: 'agent_class_sandbox_unconfigured',
              summary: `AgentClass ${this.name} has no verified image or permission profile`,
            },
          };
        }
        const imageId = await this.sandbox.resolveImage(this.agentClass.executionImageRef);
        if (imageId !== this.agentClass.resolvedImageId) {
          return {
            available: false,
            failure: {
              kind: 'configuration',
              scope: 'agent_class',
              code: 'agent_class_image_drift',
              summary: `AgentClass ${this.name} image does not match its pinned image ID`,
            },
          };
        }
      }
      const provider = this.providerEnvironment();
      if (!provider.OPENAI_BASE_URL || !provider.OPENAI_API_KEY) {
        return {
          available: false,
          failure: {
            kind: 'authentication',
            scope: 'agent_class',
            code: 'provider_configuration_missing',
            summary: 'OPENAI_BASE_URL and OPENAI_API_KEY are required',
          },
        };
      }
      if (previousFailure && ['authentication', 'network'].includes(previousFailure.kind)) {
        try {
          const baseUrl = provider.OPENAI_BASE_URL.endsWith('/')
            ? provider.OPENAI_BASE_URL
            : `${provider.OPENAI_BASE_URL}/`;
          const response = await fetch(new URL('models', baseUrl), {
            method: 'GET',
            headers: { Authorization: `Bearer ${provider.OPENAI_API_KEY}` },
          });
          if (!response.ok) {
            return {
              available: false,
              failure: {
                kind: response.status === 401 || response.status === 403
                  ? 'authentication'
                  : 'network',
                scope: 'agent_class',
                code: `provider_probe_http_${response.status}`,
                summary: `Provider validation returned HTTP ${response.status}`,
              },
            };
          }
        } catch (error) {
          return {
            available: false,
            failure: {
              kind: 'network',
              scope: 'agent_class',
              code: 'provider_remote_probe_failed',
              summary: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      return { available: true, failure: null };
    } catch (error) {
      return {
        available: false,
        failure: {
          kind: 'adapter',
          scope: 'agent_class',
          code: 'executor_local_probe_failed',
          summary: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  abort(attemptId?: string): void {
    const containerIds = attemptId
      ? [this.activeContainers.get(attemptId)].filter((id): id is string => Boolean(id))
      : [...this.activeContainers.values()];
    for (const containerId of containerIds) {
      void this.sandbox.stop(containerId).catch(() => undefined);
    }
  }

  private commandAndArgs(
    prompt: string,
    outputPath: string,
    input: ExecutorInput,
    nativePaths: boolean,
  ): { command: string; args: string[] } {
    const command = this.agentClass.runtimeCommand
      ?? (this.name === 'codex-cli' ? 'codex' : this.name === 'pi-agent' ? 'pi' : null);
    if (!command) throw new Error(`AgentClass ${this.name} has no executor runtime command`);
    if (this.name === 'codex-cli') {
      const args = buildCodexNonInteractiveArgs(prompt, {
        ephemeral: false,
        outputLastMessagePath: outputPath,
        sandbox: nativePaths ? 'danger-full-access' : 'workspace-write',
      });
      const runtimeMcpArgs: string[] = [];
      const evidenceMcpUrl = input.context.evidenceTools.binding?.mcpUrl;
      const capabilityMcpUrl = input.sandbox?.capabilityBinding?.mcpUrl;
      if (evidenceMcpUrl) {
        runtimeMcpArgs.push(
          '-c', `mcp_servers.metaclaw_evidence.url=${JSON.stringify(evidenceMcpUrl)}`,
          '-c', 'mcp_servers.metaclaw_evidence.bearer_token_env_var=\"METACLAW_EVIDENCE_TOKEN\"',
        );
      }
      if (capabilityMcpUrl) {
        runtimeMcpArgs.push(
          '-c', `mcp_servers.metaclaw_capability.url=${JSON.stringify(capabilityMcpUrl)}`,
          '-c', 'mcp_servers.metaclaw_capability.bearer_token_env_var=\"METACLAW_CAPABILITY_TOKEN\"',
        );
      }
      args.splice(args.length - 1, 0, ...runtimeMcpArgs);
      return { command, args };
    }
    if (this.name === 'pi-agent') {
      return {
        command,
        args: [
          '--no-extensions', '--extension', '/opt/metaclaw/pi-attempt-tools.ts', '--tools',
          'web_search,web_fetch,evidence_list,evidence_search,evidence_get,bash,read,write,edit,grep,find,ls',
          '-p', prompt,
        ],
      };
    }
    const template = this.agentClass.runtimeArgs;
    return {
      command,
      args: template.some(arg => arg.includes('{prompt}'))
        ? template.map(arg => arg.replaceAll('{prompt}', prompt))
        : [...template, prompt],
    };
  }

  private async prepareNativeExecutorEnvironment(
    upstreamBaseUrl: string,
    gatewayBaseUrl: string,
  ): Promise<NativeExecutorEnvironment> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'metaclaw-executor-attempt-'));
    try {
      if (this.name === 'codex-cli') {
        const sourceHome = process.env.METACLAW_EXECUTOR_CODEX_HOME ?? process.env.CODEX_HOME;
        if (!sourceHome) throw new Error('Codex worktree execution requires an Executor CODEX_HOME');
        const source = await readFile(join(sourceHome, 'config.toml'), 'utf8');
        if (!source.includes(upstreamBaseUrl)) {
          throw new Error('Codex Executor config does not contain the configured provider base URL');
        }
        const attemptHome = join(temporaryRoot, 'codex');
        await mkdir(attemptHome, { recursive: true });
        await writeFile(
          join(attemptHome, 'config.toml'),
          source.replaceAll(upstreamBaseUrl, gatewayBaseUrl),
          { encoding: 'utf8', mode: 0o600 },
        );
        return { environment: { CODEX_HOME: attemptHome }, temporaryRoot };
      }

      const sourceHome = process.env.METACLAW_EXECUTOR_PI_HOME ?? process.env.HOME;
      if (!sourceHome) throw new Error('Pi worktree execution requires an Executor HOME');
      const sourceAgentHome = join(sourceHome, '.pi', 'agent');
      const [modelsSource, settingsSource] = await Promise.all([
        readFile(join(sourceAgentHome, 'models.json'), 'utf8'),
        readFile(join(sourceAgentHome, 'settings.json'), 'utf8'),
      ]);
      const models = JSON.parse(modelsSource) as unknown;
      if (!isRecord(models) || !isRecord(models.providers)) {
        throw new Error('Pi Executor models.json has no providers object');
      }
      let replacements = 0;
      for (const provider of Object.values(models.providers)) {
        if (isRecord(provider) && provider.baseUrl === upstreamBaseUrl) {
          provider.baseUrl = gatewayBaseUrl;
          replacements += 1;
        }
      }
      if (replacements === 0) {
        throw new Error('Pi Executor config does not contain the configured provider base URL');
      }
      const attemptHome = join(temporaryRoot, 'pi');
      const attemptAgentHome = join(attemptHome, '.pi', 'agent');
      const attemptSessionHome = join(attemptAgentHome, 'sessions');
      await mkdir(attemptSessionHome, { recursive: true });
      await Promise.all([
        writeFile(join(attemptAgentHome, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 }),
        writeFile(join(attemptAgentHome, 'settings.json'), settingsSource, { mode: 0o600 }),
      ]);
      return {
        environment: {
          HOME: attemptHome,
          PI_CODING_AGENT_DIR: attemptAgentHome,
          PI_CODING_AGENT_SESSION_DIR: attemptSessionHome,
        },
        temporaryRoot,
      };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private providerEnvironment(): Record<string, string> {
    const envFile = this.name === 'codex-cli'
      ? process.env.METACLAW_CODEX_EXECUTOR_ENV_FILE
      : this.name === 'pi-agent'
        ? process.env.METACLAW_PI_EXECUTOR_ENV_FILE
        : undefined;
    const source = buildEnvFromFile(envFile, process.env);
    return Object.fromEntries(EXECUTOR_PROVIDER_ENV_KEYS.flatMap(key => {
      const value = source[key];
      return value ? [[key, value]] : [];
    }));
  }
}

function failed(message: string, code: string, startedAt: number, exitCode = 1): ExecutorResult {
  return {
    success: false,
    output: '',
    error: message,
    failure: { kind: 'configuration', scope: 'agent_class', code, summary: message },
    exitCode,
    durationMs: Date.now() - startedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failedExecution(message: string, startedAt: number, exitCode: number): ExecutorResult {
  const failure = normalizeExecutorFailure(message);
  return {
    success: false,
    output: '',
    error: failure.summary,
    failure,
    exitCode,
    durationMs: Date.now() - startedAt,
  };
}
