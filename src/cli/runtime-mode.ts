import type { CliArgs } from './args.js';

export function shouldRunPlannerTui(
  cliArgs: Pick<CliArgs, 'gateway'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !cliArgs.gateway && env.METACLAW_STANDBY_TUI !== '1';
}
