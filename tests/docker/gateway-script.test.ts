import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const gatewayScript = readFileSync(resolve(repoRoot, 'docker', 'gateway.ps1'), 'utf-8');
const entrypoint = readFileSync(resolve(repoRoot, 'docker', 'entrypoint.sh'), 'utf-8');
const gatewayConfig = readFileSync(resolve(repoRoot, 'docker', 'gateway-config.yaml'), 'utf-8');

describe('persistent Docker Gateway orchestration', () => {
  it('uses a foreground Gateway, stable volumes, restart policy, and no published port', () => {
    expect(gatewayScript).toContain("$container = 'anyfusion-gateway'");
    expect(gatewayScript).toContain("$dataVolume = 'anyfusion-gateway-data-v35-anyfusion-planner'");
    expect(gatewayScript).toContain("$workspaceVolume = 'anyfusion-gateway-workspace'");
    expect(gatewayScript).toContain('--restart unless-stopped');
    expect(gatewayScript).toContain("--health-cmd 'node /app/dist/index.js gateway health'");
    expect(gatewayScript).toContain('node /app/dist/index.js gateway run --project /workspace/default');
    expect(gatewayScript).not.toMatch(/(?:^|\s)-p\s+/m);
  });

  it('mounts credential files read-only without Docker env-file expansion', () => {
    expect(gatewayScript).toContain("${feishuEnvFile}:${feishuEnvContainerPath}:ro");
    expect(gatewayScript).toContain('METACLAW_FEISHU_ENV_FILE=$feishuEnvContainerPath');
    expect(gatewayScript).not.toContain('--env-file');
  });

  it('lets packaging select a non-TUI default config through the shared entrypoint', () => {
    expect(entrypoint).toContain('ANYFUSION_DEFAULT_CONFIG="${ANYFUSION_DEFAULT_CONFIG:-/opt/metaclaw/default-config.yaml}"');
  });

  it('auto-approves repository publication only in the Feishu Gateway profile', () => {
    expect(gatewayConfig).toContain('publication_approval: auto');
    expect(gatewayScript).toContain('METACLAW_FEISHU_PUBLICATION_APPROVAL=auto');
  });
});
