import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  resolveFeishuGatewayConfig,
  resolveFeishuGatewayEnv,
  toFeishuAppConfig,
} from '../../src/gateway/feishu-config.js';

function baseConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 300,
    },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 300,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('Feishu Gateway config resolution', () => {
  it('uses Gateway Feishu config as the canonical runtime source', () => {
    const config: Config = {
      ...baseConfig(),
      gateway: {
        enabled: true,
        platforms: {
          feishu: {
            enabled: true,
            domain: 'lark',
            connection_mode: 'websocket',
            app_id: 'cli_gateway',
            app_secret_env: 'NEW_SECRET',
            event_port: 8787,
            event_path: '/feishu/events',
            verification_token: 'new-token',
          },
        },
      },
    };

    expect(resolveFeishuGatewayConfig(config)).toEqual({
      enabled: true,
      domain: 'lark',
      connectionMode: 'websocket',
      appId: 'cli_gateway',
      appSecretEnv: 'NEW_SECRET',
      eventPort: 8787,
      eventPath: '/feishu/events',
      verificationToken: 'new-token',
      publicationApproval: 'manual',
      source: 'gateway',
    });
  });

  it('falls back to disabled defaults when Gateway Feishu config is absent', () => {
    expect(resolveFeishuGatewayConfig(baseConfig())).toEqual({
      enabled: false,
      domain: 'feishu',
      connectionMode: 'websocket',
      appId: undefined,
      appSecretEnv: 'FEISHU_APP_SECRET',
      eventPort: 8787,
      eventPath: '/feishu/events',
      verificationToken: undefined,
      encryptKeyEnv: undefined,
      publicationApproval: 'manual',
      source: 'default',
    });
  });

  it('converts canonical Gateway config to the existing Feishu bridge adapter shape', () => {
    expect(toFeishuAppConfig({
      enabled: true,
      domain: 'feishu',
      connectionMode: 'websocket',
      appId: 'cli_gateway',
      appSecretEnv: 'FEISHU_APP_SECRET',
      eventPort: 8787,
      eventPath: '/feishu/events',
      publicationApproval: 'manual',
      source: 'gateway',
    })).toEqual({
      enabled: true,
      mode: 'websocket',
      app_id: 'cli_gateway',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
      verification_token: undefined,
    });
  });

  it('lets mounted credential environment override YAML app identity and domain', () => {
    const config = baseConfig();
    expect(resolveFeishuGatewayConfig(config, {
      FEISHU_APP_ID: 'cli_env',
      FEISHU_DOMAIN: 'lark',
    })).toMatchObject({
      appId: 'cli_env',
      domain: 'lark',
    });
  });

  it('lets the Gateway service override publication approval without rewriting persistent config', () => {
    expect(resolveFeishuGatewayConfig(baseConfig(), {
      METACLAW_FEISHU_PUBLICATION_APPROVAL: 'auto',
    }).publicationApproval).toBe('auto');
  });

  it('loads a mounted credential file into a scoped environment only', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-env-'));
    const envPath = resolve(dir, 'feishu.env');
    writeFileSync(envPath, 'FEISHU_APP_ID=cli_mounted\nFEISHU_APP_SECRET=mounted-secret\n');
    const originalSecret = process.env.FEISHU_APP_SECRET;
    const scoped = resolveFeishuGatewayEnv({
      METACLAW_FEISHU_ENV_FILE: envPath,
      FEISHU_APP_ID: 'stale-app-id',
      FEISHU_APP_SECRET: 'stale-secret',
    });

    expect(scoped.FEISHU_APP_ID).toBe('cli_mounted');
    expect(scoped.FEISHU_APP_SECRET).toBe('mounted-secret');
    expect(process.env.FEISHU_APP_SECRET).toBe(originalSecret);
  });
});
