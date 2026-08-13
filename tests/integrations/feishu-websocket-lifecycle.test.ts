import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  mode: 'ready' as 'ready' | 'silent',
  options: null as Record<string, (...args: any[]) => void> | null,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class {
    register(): this { return this; }
  },
  WSClient: class {
    constructor(options: Record<string, (...args: any[]) => void>) {
      sdk.options = options;
    }
    async start(): Promise<void> {
      if (sdk.mode === 'ready') sdk.options?.onReady?.();
    }
    close(): void {}
  },
}));

import { FeishuWebSocketBridge } from '../../src/integrations/feishu-app.js';

function createBridge(onConnectionState = vi.fn(), readyTimeoutMs = 50): FeishuWebSocketBridge {
  return new FeishuWebSocketBridge({
    client: {
      addReactionToMessage: vi.fn(),
      removeReactionFromMessage: vi.fn(),
      sendMarkdownCardToChat: vi.fn(),
    },
    session: {
      getSnapshot: () => ({ output: [] }),
      submit: vi.fn(),
      appendSystemMessage: vi.fn(),
    } as any,
    appId: 'cli_test',
    appSecret: 'secret',
    onConnectionState,
    readyTimeoutMs,
  });
}

describe('Feishu WebSocket lifecycle', () => {
  beforeEach(() => {
    sdk.mode = 'ready';
    sdk.options = null;
  });

  it('waits for onReady and projects reconnect transitions', async () => {
    const onConnectionState = vi.fn();
    const bridge = createBridge(onConnectionState);
    await bridge.start();
    expect(onConnectionState).toHaveBeenNthCalledWith(1, 'starting');
    expect(onConnectionState).toHaveBeenNthCalledWith(2, 'connected');

    sdk.options?.onReconnecting?.();
    sdk.options?.onReconnected?.();
    expect(onConnectionState).toHaveBeenCalledWith('reconnecting');
    expect(onConnectionState).toHaveBeenCalledWith('connected');

    const failure = bridge.waitForFailure();
    sdk.options?.onError?.(new Error('terminal websocket failure'));
    await expect(failure).rejects.toThrow('terminal websocket failure');
  });

  it('fails when the SDK never reports ready', async () => {
    sdk.mode = 'silent';
    const bridge = createBridge(vi.fn(), 5);
    await expect(bridge.start()).rejects.toThrow('在 5ms 内未就绪');
  });
});
