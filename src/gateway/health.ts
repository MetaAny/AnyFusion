import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FeishuConnectionState = 'starting' | 'connected' | 'reconnecting' | 'failed' | 'stopped';

export interface GatewayStatus {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  socketPath: string;
  feishu: {
    state: FeishuConnectionState;
    lastError?: string;
  };
}

export function resolveGatewayStatusPath(metaclawDir: string): string {
  return resolve(metaclawDir, 'gateway-status.json');
}

export class GatewayStatusReporter {
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly metaclawDir: string,
    private readonly socketPath: string,
  ) {}

  update(state: FeishuConnectionState, error?: string): void {
    const status: GatewayStatus = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      socketPath: this.socketPath,
      feishu: {
        state,
        ...(error ? { lastError: sanitizeGatewayError(error) } : {}),
      },
    };
    const statusPath = resolveGatewayStatusPath(this.metaclawDir);
    const temporaryPath = `${statusPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(temporaryPath, statusPath);
  }
}

export function inspectGatewayHealth(metaclawDir: string): {
  healthy: boolean;
  message: string;
  status?: GatewayStatus;
} {
  const statusPath = resolveGatewayStatusPath(metaclawDir);
  if (!existsSync(statusPath)) {
    return { healthy: false, message: 'Gateway status file is missing' };
  }
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as GatewayStatus;
    const socketPresent = existsSync(status.socketPath);
    const processPresent = isProcessAlive(status.pid);
    const healthy = processPresent && socketPresent && status.feishu.state === 'connected';
    return {
      healthy,
      status,
      message: healthy
        ? `Gateway healthy: Feishu ${status.feishu.state}`
        : `Gateway unhealthy: process=${processPresent} socket=${socketPresent} feishu=${status.feishu.state}`,
    };
  } catch (error) {
    return { healthy: false, message: `Gateway status is invalid: ${(error as Error).message}` };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sanitizeGatewayError(value: string): string {
  return value
    .replace(/(app_secret|authorization|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}
