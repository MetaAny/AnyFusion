import { fileURLToPath } from 'node:url';

export interface PlannerMcpLaunchEnv {
  ANYFUSION_PLANNER_MCP_COMMAND: string;
  ANYFUSION_PLANNER_MCP_ARGS_JSON: string;
}

/** Pins Planner MCP to the MetaClaw Node runtime instead of the Pi Node 22 process. */
export function buildPlannerMcpLaunchEnv(): PlannerMcpLaunchEnv {
  return {
    ANYFUSION_PLANNER_MCP_COMMAND: process.execPath,
    ANYFUSION_PLANNER_MCP_ARGS_JSON: JSON.stringify([
      fileURLToPath(new URL('./planner-mcp.js', import.meta.url)),
    ]),
  };
}
