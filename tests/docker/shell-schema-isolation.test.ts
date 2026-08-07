import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Docker shell SQLite schema isolation', () => {
  it('builds one Node 22 runtime from both repository contexts', () => {
    const runtimeDockerfile = readFileSync(resolve('docker/Dockerfile.runtime'), 'utf-8');
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const smoke = readFileSync(resolve('scripts/smoke-metaclaw-real-task.mjs'), 'utf-8');

    expect(runtimeDockerfile).toContain('FROM node:22.19.0-bookworm-slim AS runtime');
    expect(runtimeDockerfile).toContain('COPY --from=anyfusion-pi . .');
    expect(runtimeDockerfile).toContain('exec /usr/local/bin/node /opt/anyfusion-planner/app/');
    expect(runtimeDockerfile).toContain('test ! -e /opt/anyfusion-planner/node');
    expect(runtimeDockerfile).toContain('@openai/codex@0.144.1');
    expect(runtimeDockerfile).toContain('@earendil-works/pi-coding-agent@0.80.2');
    expect(runtimeDockerfile).toContain('/app/dist/pi-attempt-tools.ts /opt/metaclaw/pi-attempt-tools.ts');
    expect(runtimeDockerfile).toContain('/app/dist/capability-request-cli.js');
    expect(runtimeDockerfile).toContain('/app/dist/capability-use-cli.js');
    expect(runtimeDockerfile).not.toContain('ANYFUSION_PI_IMAGE');
    expect(runtimeDockerfile).not.toContain('FROM ${ANYFUSION_PI_IMAGE}');
    expect(shell).toContain('docker build --build-context "anyfusion-pi=$anyFusionPiRoot"');
    expect(shell).not.toContain('Build-AnyFusionPiImage');
    expect(shell).not.toContain('Build-Image');
    expect(shell).not.toContain('Build-BaseImage');
    expect(shell).not.toContain('Dockerfile.ssh');
    expect(shell).not.toContain('metaclaw-tui-ssh');
    expect(shell).not.toContain('anyfusion-pi-planner:local');
    expect(smoke).toContain("'--build-context', `anyfusion-pi=${anyFusionPiRoot}`");
    expect(smoke).not.toContain('ANYFUSION_PI_IMAGE');
  });

  it('keeps the package, setup, CI, and image Node baselines aligned', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
      engines: { node: string };
    };
    const setup = readFileSync(resolve('setup.sh'), 'utf-8');
    const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf-8');

    expect(packageJson.engines.node).toBe('>=22.19.0');
    expect(setup).toContain('const minimum = [22, 19, 0]');
    expect(setup).toContain('Node.js >= 22.19.0');
    expect(ci).toContain('node-version: 22.19.0');
  });

  it('uses the Responses API with one supported model across Planner and Executors', () => {
    const plannerModels = JSON.parse(
      readFileSync(resolve('docker/planner-pi-config/models.json'), 'utf-8'),
    ) as {
      providers: { anyint: { api: string; models: Array<{ id: string; thinkingLevelMap?: unknown }> } };
    };
    const plannerSettings = JSON.parse(
      readFileSync(resolve('docker/planner-pi-config/settings.json'), 'utf-8'),
    ) as { defaultModel: string; defaultThinkingLevel: string };
    const piModels = JSON.parse(
      readFileSync(resolve('docker/pi-config/models.json'), 'utf-8'),
    ) as {
      providers: { anyint: { api: string; models: Array<{ id: string; thinkingLevelMap?: unknown }> } };
    };
    const piSettings = JSON.parse(
      readFileSync(resolve('docker/pi-config/settings.json'), 'utf-8'),
    ) as { defaultModel: string; defaultThinkingLevel: string };
    const codexConfig = readFileSync(
      resolve('docker/codex-config/executor/config.toml'),
      'utf-8',
    );
    const model = 'gpt-5.6-terra';

    expect(plannerModels.providers.anyint.api).toBe('openai-responses');
    expect(plannerModels.providers.anyint.models).toContainEqual(
      expect.objectContaining({ id: model }),
    );
    expect(plannerSettings.defaultModel).toBe(model);
    expect(plannerSettings.defaultThinkingLevel).toBe('high');
    expect(plannerModels.providers.anyint.models[0]).not.toHaveProperty('thinkingLevelMap');
    expect(piModels.providers.anyint.api).toBe('openai-responses');
    expect(piModels.providers.anyint.models).toContainEqual(
      expect.objectContaining({ id: model }),
    );
    expect(piSettings.defaultModel).toBe(model);
    expect(piSettings.defaultThinkingLevel).toBe('high');
    expect(piModels.providers.anyint.models[0]).not.toHaveProperty('thinkingLevelMap');
    expect(codexConfig).toContain(`model = "${model}"`);
  });

  it('uses a data volume scoped to the current pre-release schema', () => {
    const migrations = readFileSync(
      resolve('src/storage/migrations.ts'),
      'utf-8',
    );
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const version = migrations.match(/CURRENT_SCHEMA_VERSION = (\d+);/)?.[1];

    expect(version).toBeTruthy();
    expect(shell).toContain(
      `$dataVolume = 'metaclaw-shell-data-v${version}-anyfusion-planner'`,
    );
  });

  it('uses the worktree backend without mounting the Docker socket', () => {
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const runtimeDockerfile = readFileSync(resolve('docker/Dockerfile.runtime'), 'utf-8');

    expect(shell).toContain('-e METACLAW_EXECUTOR_BACKEND=worktree');
    expect(runtimeDockerfile).toContain('METACLAW_EXECUTOR_BACKEND=worktree');
    expect(shell).not.toContain('/var/run/docker.sock');
    expect(shell).not.toContain('function Test-ContainerHasDockerSocket');
    expect(shell).toContain('Start-ShellContainer');
  });

  it('refreshes rendered provider configs from mounted env files before interactive entry', () => {
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');

    expect(shell).toContain('function Refresh-ContainerProviderConfigs');
    expect(shell).toContain('docker exec $container /opt/metaclaw/entrypoint.sh :');

    const mainDispatch = shell.slice(shell.indexOf('# --- main dispatch ---'));
    expect(mainDispatch.indexOf('Ensure-ContainerRunning')).toBeLessThan(
      mainDispatch.indexOf('Refresh-ContainerProviderConfigs'),
    );
    expect(mainDispatch.indexOf('Refresh-ContainerProviderConfigs')).toBeLessThan(
      mainDispatch.indexOf('if ($Bash)'),
    );
  });

  it('does not bootstrap sibling-container topology for the default demo', () => {
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const persistEnv = readFileSync(resolve('docker/persist-ssh-environment.sh'), 'utf-8');
    const smoke = readFileSync(resolve('scripts/smoke-metaclaw-real-task.mjs'), 'utf-8');

    expect(shell).toContain('--network bridge');
    expect(shell).not.toContain('docker network create --internal');
    expect(shell).not.toContain('function Build-DockerHostPathMap');
    expect(shell).not.toContain('function Ensure-AttemptImages');
    expect(shell).not.toContain('Dockerfile.attempt-codex');
    expect(shell).not.toContain('Dockerfile.attempt-pi');
    expect(smoke).toContain("'-e', 'METACLAW_EXECUTOR_BACKEND=worktree'");
    expect(smoke).toContain("'-e', `METACLAW_PLANNER_TIMEOUT_MS=${plannerTimeoutMs}`");
    expect(smoke).not.toContain('src=//var/run/docker.sock');
    expect(smoke).not.toContain("['network', 'create', '--internal'");
    expect(smoke).not.toContain("['network', 'connect'");
    expect(smoke).not.toContain("'docker/Dockerfile.attempt-codex'");
    expect(smoke).not.toContain("'docker/Dockerfile.attempt-pi'");
    expect(persistEnv).toContain('METACLAW_EXECUTOR_BACKEND');
    expect(persistEnv).not.toContain('METACLAW_DOCKER_HOST_PATH_MAP');
  });

  it('does not mutate persisted Executor image pins in worktree mode', () => {
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');

    expect(shell).not.toContain('function Reset-BuiltinExecutorImagePins');
    expect(shell).not.toContain('UPDATE agent_classes SET resolved_image_id');
  });
});
