import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function readEnvironmentFile(path: string): Map<string, string> {
  return new Map(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

describe.skipIf(process.platform === 'win32')('SSH login environment', () => {
  it('persists MetaClaw runtime paths for sessions started by sshd', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-ssh-environment-'));
    const environmentPath = join(directory, 'environment');
    const helperPath = resolve('docker/persist-ssh-environment.sh');

    try {
      writeFileSync(environmentPath, 'LANG=C.UTF-8\n');
      execFileSync(
        'bash',
        ['-c', 'source "$1"; persist_ssh_environment "$2"', 'bash', helperPath, environmentPath],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: 'must-not-be-persisted',
            OPENAI_BASE_URL: 'https://example.invalid/v1',
            METACLAW_PLANNER_ENV_FILE: '/run/metaclaw/env/planner-pi.env',
            METACLAW_CODEX_EXECUTOR_ENV_FILE: '/run/metaclaw/env/executor-codex.env',
            METACLAW_PI_EXECUTOR_ENV_FILE: '/run/metaclaw/env/executor-pi.env',
            METACLAW_HOME: '/test/data/metaclaw',
            ANYFUSION_PLANNER_HOME: '/test/anyfusion/planner',
        METACLAW_PLANNER_HOME: '/test/anyfusion/planner',
            METACLAW_EXECUTOR_CODEX_HOME: '/test/codex/executor',
            METACLAW_PLANNER_SCHEMA_PATH: '/test/schema/planning-agent-plan-v7.schema.json',
            METACLAW_PLANNER_WORKDIR: '/test/workdir/planner',
          },
        },
      );

      expect(Object.fromEntries(readEnvironmentFile(environmentPath))).toMatchObject({
        LANG: 'C.UTF-8',
        METACLAW_PLANNER_ENV_FILE: '/run/metaclaw/env/planner-pi.env',
        METACLAW_CODEX_EXECUTOR_ENV_FILE: '/run/metaclaw/env/executor-codex.env',
        METACLAW_PI_EXECUTOR_ENV_FILE: '/run/metaclaw/env/executor-pi.env',
        METACLAW_HOME: '/test/data/metaclaw',
        ANYFUSION_PLANNER_HOME: '/test/anyfusion/planner',
            METACLAW_PLANNER_HOME: '/test/anyfusion/planner',
        METACLAW_EXECUTOR_CODEX_HOME: '/test/codex/executor',
        METACLAW_PLANNER_SCHEMA_PATH: '/test/schema/planning-agent-plan-v7.schema.json',
        METACLAW_PLANNER_WORKDIR: '/test/workdir/planner',
      });
      const persisted = Object.fromEntries(readEnvironmentFile(environmentPath));
      expect(persisted).not.toHaveProperty('OPENAI_API_KEY');
      expect(persisted).not.toHaveProperty('OPENAI_BASE_URL');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
