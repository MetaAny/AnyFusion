import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/utils/config.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

describe('loadConfig defaults', () => {
  it('uses codex as the default executor command', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.executor.command).toBe('codex');
  });

  it('keeps idle timeout and legacy max duration defaults in config', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.executor.timeout).toBe(300);
    expect(config.executor.max_duration).toBe(3600);
  });

  it('defaults global attempt concurrency to four', () => {
    expect(loadConfig('/path/that/does/not/exist.yaml').orchestration.max_concurrent_attempts).toBe(4);
  });

  it.each(['0', '-1', '1.5', 'many'])(
    'fails startup for invalid max_concurrent_attempts value %s',
    value => {
      const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-concurrency-'));
      const configPath = resolve(dir, 'config.yaml');
      writeFileSync(configPath, [
        'orchestration:',
        `  max_concurrent_attempts: ${value}`,
        '',
      ].join('\n'));

      expect(() => loadConfig(configPath)).toThrow('max_concurrent_attempts must be a positive integer');
    },
  );

  it('disables Feishu notifications by default', () => {
    const config = loadConfig('/path/that/does/not/exist.yaml');

    expect(config.notifications?.feishu?.enabled).toBe(false);
  });

  it('loads Feishu notification config from yaml', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(configPath, [
      'notifications:',
      '  feishu:',
      '    enabled: true',
      '    webhook_url: https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      '    secret: test-secret',
      '',
    ].join('\n'));

    const config = loadConfig(configPath);

    expect(config.notifications?.feishu).toEqual({
      enabled: true,
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
      secret: 'test-secret',
    });
  });

  it('loads canonical Gateway Feishu config', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(configPath, [
      'gateway:',
      '  enabled: true',
      '  platforms:',
      '    feishu:',
      '      enabled: true',
      '      app_id: cli_test',
      '      app_secret_env: TEST_FEISHU_SECRET',
      '      event_port: 9898',
      '      event_path: /feishu/callback',
      '      verification_token: token',
      '',
    ].join('\n'));

    const config = loadConfig(configPath);

    expect(config.gateway?.enabled).toBe(true);
    expect(config.gateway?.platforms?.feishu).toEqual({
      enabled: true,
      domain: 'feishu',
      connection_mode: 'websocket',
      app_id: 'cli_test',
      app_secret_env: 'TEST_FEISHU_SECRET',
      event_port: 9898,
      event_path: '/feishu/callback',
      verification_token: 'token',
      access: {
        dm_policy: 'pairing',
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
    });
  });

  it('falls back to config.json in the same directory when config.yaml is missing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
      gateway: {
        enabled: true,
        platforms: {
          feishu: {
            enabled: true,
            app_id: 'cli_json',
            app_secret_env: 'TEST_FEISHU_SECRET',
            event_port: 9898,
            event_path: '/feishu/json',
          },
        },
      },
    }));

    const config = loadConfig(configPath);

    expect(config.gateway?.platforms?.feishu?.app_id).toBe('cli_json');
    expect(config.gateway?.platforms?.feishu?.connection_mode).toBe('websocket');
    expect(config.gateway?.platforms?.feishu?.event_path).toBe('/feishu/json');
  });

  it('loads Markdown preview config for generated document links', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-config-'));
    const configPath = resolve(dir, 'config.yaml');
    writeFileSync(configPath, [
      'integrations:',
      '  markdown_preview:',
      '    enabled: true',
      '    host: 0.0.0.0',
      '    port: 8899',
      '    public_base_url: https://preview.example.com',
      '',
    ].join('\n'));

    const config = loadConfig(configPath);

    expect(config.integrations?.markdown_preview).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 8899,
      public_base_url: 'https://preview.example.com',
    });
  });
});
