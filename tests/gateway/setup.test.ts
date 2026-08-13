import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { loadConfig } from '../../src/utils/config.js';
import { runGatewaySetup } from '../../src/gateway/setup.js';
import { createFeishuBridge } from '../../src/integrations/feishu-app.js';

describe('gateway setup', () => {
  it('writes QR-registered Feishu config into canonical Gateway config only', async () => {
    const metaclawDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-gateway-setup-'));
    const choices = [0, 0, 2, 0];
    const prompts = ['', 'oc_home'];
    const outputLines: string[] = [];
    const previousSecret = process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_SECRET;

    try {
      await runGatewaySetup({
        metaclawDir,
        deps: {
          registerFeishuBotByQr: async () => ({
            appId: 'cli_qr',
            appSecret: 'secret_qr',
            domain: 'feishu',
            userOpenId: 'ou_user',
            botName: 'MetaClaw Bot',
            botOpenId: 'ou_bot',
          }),
          choose: async () => choices.shift() ?? 0,
          prompt: async () => prompts.shift() ?? '',
          writeLine: line => outputLines.push(line ?? ''),
        },
      });

      const config = loadConfig(resolve(metaclawDir, 'config.yaml'));
      expect(config.gateway?.enabled).toBe(true);
      expect(config.gateway?.platforms?.feishu).toEqual({
        enabled: true,
        domain: 'feishu',
        connection_mode: 'websocket',
        app_id: 'cli_qr',
        app_secret_env: 'FEISHU_APP_SECRET',
        event_port: 8787,
        event_path: '/feishu/events',
        verification_token: '',
        access: {
          dm_policy: 'allowlist',
          allowed_users: [],
          group_policy: 'open',
          require_mention: true,
        },
        delivery: {
          final_markdown_mode: 'card',
          fallback_mode: 'post',
          final_file_fallback: true,
          publication_approval: 'manual',
        },
        home_channel: 'oc_home',
      });
      expect(createFeishuBridge(config, {} as never)).not.toBeNull();
      expect(readFileSync(resolve(metaclawDir, '.env'), 'utf-8')).toContain('FEISHU_BOT_OPEN_ID=ou_bot');
      expect(outputLines.join('\n')).toContain('metaclaw gateway run');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FEISHU_APP_SECRET;
      } else {
        process.env.FEISHU_APP_SECRET = previousSecret;
      }
    }
  });

  it('falls back to manual Feishu credentials when QR setup does not complete', async () => {
    const metaclawDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-gateway-manual-'));
    const choices = [0, 0, 1, 1, 1, 1];
    const prompts = ['cli_manual', 'secret_manual', ''];
    const previousSecret = process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_SECRET;

    try {
      await runGatewaySetup({
        metaclawDir,
        deps: {
          registerFeishuBotByQr: async () => null,
          choose: async () => choices.shift() ?? 0,
          prompt: async () => prompts.shift() ?? '',
          writeLine: () => undefined,
        },
      });

      const config = loadConfig(resolve(metaclawDir, 'config.yaml'));
      expect(config.gateway?.platforms?.feishu?.domain).toBe('lark');
      expect(config.gateway?.platforms?.feishu?.connection_mode).toBe('webhook');
      expect(config.gateway?.platforms?.feishu?.access?.dm_policy).toBe('allow_all');
      expect(config.gateway?.platforms?.feishu?.access?.group_policy).toBe('disabled');
      expect(createFeishuBridge(config, {} as never)).not.toBeNull();
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FEISHU_APP_SECRET;
      } else {
        process.env.FEISHU_APP_SECRET = previousSecret;
      }
    }
  });

  it('preserves existing canonical Gateway endpoint values while rewriting credentials', async () => {
    const metaclawDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-gateway-existing-setup-'));
    writeFileSync(resolve(metaclawDir, 'config.yaml'), [
      'integrations:',
      '  markdown_preview:',
      '    enabled: true',
      '    host: 127.0.0.1',
      '    port: 8790',
      'gateway:',
      '  enabled: true',
      '  platforms:',
      '    feishu:',
      '      enabled: true',
      '      app_id: cli_old',
      '      event_port: 9898',
      '      event_path: /old/events',
      '      verification_token: old-token',
      '',
    ].join('\n'));
    const previousSecret = process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_SECRET;

    try {
      await runGatewaySetup({
        metaclawDir,
        deps: {
          registerFeishuBotByQr: async () => ({
            appId: 'cli_new',
            appSecret: 'secret_new',
            domain: 'feishu',
          }),
          choose: async () => 0,
          prompt: async () => '',
          writeLine: () => undefined,
        },
      });

      const rawConfig = load(readFileSync(resolve(metaclawDir, 'config.yaml'), 'utf-8')) as any;
      expect(rawConfig.integrations.markdown_preview).toEqual({
        enabled: true,
        host: '127.0.0.1',
        port: 8790,
      });
      expect(rawConfig.gateway.platforms.feishu).toMatchObject({
        enabled: true,
        app_id: 'cli_new',
        event_port: 9898,
        event_path: '/old/events',
        verification_token: 'old-token',
      });
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FEISHU_APP_SECRET;
      } else {
        process.env.FEISHU_APP_SECRET = previousSecret;
      }
    }
  });
});
