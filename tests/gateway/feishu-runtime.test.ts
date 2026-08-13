import { describe, expect, it, vi } from 'vitest';
import { startFeishuRuntimeBridge } from '../../src/gateway/feishu-runtime.js';
import type { Config } from '../../src/core/types.js';

describe('Feishu runtime bridge', () => {
  const baseConfig: Config = {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 300,
      max_duration: 3600,
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
    gateway: {
      enabled: true,
      platforms: {
        feishu: {
          enabled: true,
          connection_mode: 'websocket',
          app_id: 'cli_test',
          app_secret_env: 'FEISHU_APP_SECRET',
          event_port: 8787,
          event_path: '/feishu/events',
        },
      },
    },
    integrations: {
      markdown_preview: {
        enabled: true,
        host: '127.0.0.1',
        port: 8790,
      },
    },
  };

  it('starts the existing Feishu bridge and reports websocket readiness', async () => {
    process.env.FEISHU_APP_SECRET = 'secret';
    const bridge = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      waitForFailure: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const session = {
      appendSystemMessage: vi.fn(),
    };

    const runtimeBridge = await startFeishuRuntimeBridge(
      baseConfig,
      {
        session: session as any,
        probeBot: vi.fn().mockResolvedValue({ botOpenId: 'ou_bot' }),
      },
      () => bridge,
    );

    expect(bridge.start).toHaveBeenCalledTimes(1);
    await runtimeBridge?.stop();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('fails startup when Feishu bridge creation fails', async () => {
    process.env.FEISHU_APP_SECRET = 'secret';
    const session = {
      appendSystemMessage: vi.fn(),
    };

    await expect(startFeishuRuntimeBridge(
      baseConfig,
      {
        session: session as any,
        probeBot: vi.fn().mockResolvedValue({ botOpenId: 'ou_bot' }),
      },
      () => {
        throw new Error('missing secret');
      },
    )).rejects.toThrow('missing secret');
  });
});
