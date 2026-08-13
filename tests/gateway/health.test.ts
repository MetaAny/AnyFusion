import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { GatewayStatusReporter, inspectGatewayHealth } from '../../src/gateway/health.js';

describe('Gateway health', () => {
  it('requires a live process, socket path, and connected Feishu state', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'anyfusion-gateway-health-'));
    const socketPath = resolve(dir, 'gateway.sock');
    mkdirSync(socketPath);
    const reporter = new GatewayStatusReporter(dir, socketPath);

    reporter.update('connected');
    expect(inspectGatewayHealth(dir).healthy).toBe(true);

    reporter.update('reconnecting', 'authorization=secret-value');
    const result = inspectGatewayHealth(dir);
    expect(result.healthy).toBe(false);
    expect(result.status?.feishu.lastError).toContain('authorization=[redacted]');
    expect(result.status?.feishu.lastError).not.toContain('secret-value');
  });
});
