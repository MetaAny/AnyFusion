import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'anyfusion-launcher-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('native AnyFusion Linux launcher', () => {
  it('is valid Bash and documents the host-process runtime', () => {
    const launcher = resolve('anyfusion');
    const syntax = spawnSync('bash', ['-n', launcher], { encoding: 'utf8' });
    const help = spawnSync('bash', [launcher, '--launcher-help'], { encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('anyfusion smoke [smoke options]');
    expect(help.stdout).toContain('anyfusion gateway run');
    expect(help.stdout).toContain('Codex and Pi use the existing host-installed commands');
    expect(help.stdout).toContain('Docker is not required');
  });

  it('routes the installed anyfusion command through the native launcher', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(packageJson.bin.anyfusion).toBe('./anyfusion');
    expect(packageJson.bin.metaclaw).toBe('./dist/index.js');
  });

  it('prepares isolated Planner and Executor homes without invoking Docker', () => {
    const fakeBin = join(tempRoot, 'bin');
    const piRoot = join(tempRoot, 'AnyFusion-Pi');
    const configHome = join(tempRoot, 'config');
    const dataHome = join(tempRoot, 'data');
    const envDir = join(tempRoot, 'env');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(piRoot, 'packages/coding-agent/dist'), { recursive: true });
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(piRoot, 'package.json'), '{}\n');
    writeFileSync(join(piRoot, 'packages/coding-agent/dist/cli.js'), '#!/usr/bin/env node\n');

    for (const command of ['codex', 'pi']) {
      const commandPath = join(fakeBin, command);
      const version = command === 'codex' ? 'codex-cli 0.146.0' : '0.81.1';
      writeFileSync(commandPath, `#!/usr/bin/env bash\nprintf '%s\\n' '${version}'\n`);
      chmodSync(commandPath, 0o755);
    }

    const providerEnv = 'OPENAI_API_KEY=test-key\nOPENAI_BASE_URL=http://provider.test/v1\n';
    const plannerEnv = join(envDir, 'planner.env');
    const codexEnv = join(envDir, 'codex.env');
    const piEnv = join(envDir, 'pi.env');
    writeFileSync(plannerEnv, providerEnv);
    writeFileSync(codexEnv, providerEnv);
    writeFileSync(piEnv, providerEnv);

    const result = spawnSync('bash', [resolve('anyfusion'), '--check'], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        ANYFUSION_PI_ROOT: piRoot,
        ANYFUSION_CONFIG_HOME: configHome,
        ANYFUSION_PLANNER_HOME: join(configHome, 'planner'),
        METACLAW_PLANNER_HOME: join(configHome, 'planner'),
        METACLAW_EXECUTOR_CODEX_HOME: join(configHome, 'codex'),
        METACLAW_EXECUTOR_PI_HOME: join(configHome, 'pi-home'),
        METACLAW_HOME: dataHome,
        ANYFUSION_PLANNER_ENV_FILE: plannerEnv,
        ANYFUSION_CODEX_EXECUTOR_ENV_FILE: codexEnv,
        ANYFUSION_PI_EXECUTOR_ENV_FILE: piEnv,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Native AnyFusion runtime is ready');
    expect(readFileSync(join(configHome, 'planner/models.json'), 'utf8')).toContain(
      'http://provider.test/v1',
    );
    expect(readFileSync(join(configHome, 'codex/config.toml'), 'utf8')).toContain(
      'http://provider.test/v1',
    );
    expect(readFileSync(join(configHome, 'pi-home/.pi/agent/models.json'), 'utf8')).toContain(
      'http://provider.test/v1',
    );
    expect(readFileSync(join(configHome, 'bin/anyfusion-planner'), 'utf8')).toContain(
      join(piRoot, 'packages/coding-agent/dist/cli.js'),
    );
    const registry = readFileSync(join(configHome, 'executors.yaml'), 'utf8');
    expect(registry).toContain('id: codex');
    expect(registry).toContain('id: pi');
    expect(registry).toContain('executors: []');
    expect(readFileSync(resolve('anyfusion'), 'utf8')).not.toContain('docker run');
    expect(readFileSync(resolve('anyfusion'), 'utf8')).not.toContain('docker build');
    expect(readFileSync(resolve('anyfusion'), 'utf8')).toContain('source "$BOOTSTRAP"');
  });

  it('keeps one native startup script', () => {
    expect(existsSync(resolve('anyfusion'))).toBe(true);
    expect(existsSync(resolve('anyfusion.sh'))).toBe(false);
    expect(existsSync(resolve('metaclaw.sh'))).toBe(false);
  });
});
