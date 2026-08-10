import { createConnection } from 'node:net';
import type { PlannerExecutorRegistryProjection } from '../executor/executor-registry-types.js';
import { ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION } from '../tui-bridge/planner-host-protocol.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface PlannerHostRegistryClientOptions {
  socketPath: string;
  sessionId: string;
  timeoutMs?: number;
}

/** Reads the Registry projection owned by the live Session over the existing host socket. */
export function readPlannerHostRegistryProjection(
  options: PlannerHostRegistryClientOptions,
): Promise<PlannerExecutorRegistryProjection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    let phase: 'hello' | 'snapshot' = 'hello';

    const finish = (error: Error | null, projection?: PlannerExecutorRegistryProjection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(projection!);
    };
    const timer = setTimeout(() => finish(new Error(
      `Planner host Registry query timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
    )), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const write = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
    const accept = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        finish(new Error(`Planner host returned invalid JSON: ${(error as Error).message}`));
        return;
      }
      if (!isRecord(message)) {
        finish(new Error('Planner host returned a non-object response'));
        return;
      }
      if (message.type === 'error') {
        const detail = isRecord(message.error) ? String(message.error.message ?? 'unknown error') : 'unknown error';
        finish(new Error(`Planner host Registry query failed: ${detail}`));
        return;
      }
      if (phase === 'hello') {
        if (message.type !== 'hello' || message.accepted !== true) {
          finish(new Error('Planner host rejected the Registry reader hello'));
          return;
        }
        phase = 'snapshot';
        write({
          protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
          type: 'snapshot_get',
          requestId: 'planner-mcp-registry-snapshot',
        });
        return;
      }
      const snapshot = isRecord(message.snapshot) ? message.snapshot : null;
      const projection = snapshot && isRecord(snapshot.executorRegistry)
        ? snapshot.executorRegistry
        : null;
      if (message.type !== 'snapshot'
        || !projection
        || typeof projection.configDigest !== 'string'
        || !isRecord(projection.planner)
        || !Array.isArray(projection.tui)) {
        finish(new Error('Planner host snapshot is missing the Executor Registry projection'));
        return;
      }
      finish(null, structuredClone(projection) as unknown as PlannerExecutorRegistryProjection);
    };

    socket.on('connect', () => write({
      protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'planner-mcp-registry-hello',
      runtimeVersion: 'planner-mcp',
      sessionId: options.sessionId,
      mode: 'rpc',
    }));
    socket.on('data', chunk => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0 && !settled) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) accept(line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error(
      'Planner host closed before returning the Registry projection',
    )));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
