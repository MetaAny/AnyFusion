import { spawn } from 'node:child_process';
import { buildPlannerMcpLaunchEnv } from '../planning/planner-mcp-launch-env.js';
import { buildEnvFromFile } from '../utils/env-file.js';

export interface PlannerTuiProcessOptions {
  socketPath: string;
  sessionId: string;
  cwd: string;
}

/** Launches the downstream AnyFusion-Pi Planner with isolated home/config. */
export async function runPlannerTuiProcess(options: PlannerTuiProcessOptions): Promise<void> {
  const command = process.env.METACLAW_PLANNER_TUI_COMMAND?.trim();
  if (!command) {
    throw new Error('METACLAW_PLANNER_TUI_COMMAND is required for the AnyFusion TUI');
  }
  const args = parsePlannerTuiArgs(process.env.METACLAW_PLANNER_TUI_ARGS);
  const env = buildEnvFromFile(process.env.METACLAW_PLANNER_ENV_FILE);
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env: {
      ...env,
      ANYFUSION_PLANNER_HOME: process.env.METACLAW_PLANNER_HOME,
      ANYFUSION_PLANNER_SESSION_ID: options.sessionId,
      METACLAW_PLANNER_SESSION_ID: options.sessionId,
      METACLAW_PLANNER_TUI_SOCKET: options.socketPath,
      ANYFUSION_BRIDGE_SOCKET: options.socketPath,
      ANYFUSION_PLANNER_MODE: '1',
      ANYFUSION_PLANNER_SCHEMA_PATH: process.env.ANYFUSION_PLANNER_SCHEMA_PATH
        ?? process.env.METACLAW_PLANNER_SCHEMA_PATH,
      ...buildPlannerMcpLaunchEnv(),
    },
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 && result.signal === null) {
    throw new Error(`AnyFusion Planner TUI exited with code ${result.code ?? 'unknown'}`);
  }
}

export function parsePlannerTuiArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('METACLAW_PLANNER_TUI_ARGS must be a JSON string array');
  }
  return parsed;
}
