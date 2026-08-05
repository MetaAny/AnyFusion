import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlannerTuiProcess } from '../../src/tui-bridge/planner-tui-process.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('runPlannerTuiProcess', () => {
  it('injects one authoritative session id for the Pi host client and MetaClaw MCP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'planner-tui-process-'));
    temporaryDirectories.push(directory);
    const probePath = join(directory, 'probe.mjs');
    const outputPath = join(directory, 'env.json');
    await writeFile(probePath, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2], JSON.stringify({
        anyfusion: process.env.ANYFUSION_PLANNER_SESSION_ID,
        metaclaw: process.env.METACLAW_PLANNER_SESSION_ID,
      }));
    `);

    vi.stubEnv('METACLAW_PLANNER_TUI_COMMAND', process.execPath);
    vi.stubEnv('METACLAW_PLANNER_TUI_ARGS', JSON.stringify([probePath, outputPath]));
    vi.stubEnv('METACLAW_PLANNER_ENV_FILE', '');
    vi.stubEnv('METACLAW_PLANNER_HOME', join(directory, 'planner-home'));

    await runPlannerTuiProcess({
      socketPath: join(directory, 'planner.sock'),
      sessionId: 'session-authoritative',
      cwd: directory,
    });

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({
      anyfusion: 'session-authoritative',
      metaclaw: 'session-authoritative',
    });
  });
});
