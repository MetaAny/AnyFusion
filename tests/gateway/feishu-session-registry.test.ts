import { describe, expect, it, vi } from 'vitest';
import { createFeishuSessionId, FeishuSessionRegistry } from '../../src/gateway/feishu-session-registry.js';

describe('Feishu session registry', () => {
  it('uses stable opaque session ids and isolates chats', async () => {
    const sessions: Array<{
      initialize: ReturnType<typeof vi.fn>;
      shutdown: ReturnType<typeof vi.fn>;
      waitForInitialization: ReturnType<typeof vi.fn>;
    }> = [];
    const createSession = vi.fn(() => {
      const session = {
        initialize: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        waitForInitialization: vi.fn().mockResolvedValue(undefined),
        getBlockedRecheckIntervalMs: vi.fn(() => 60_000),
        maybeReviewTaskPoolOnTimer: vi.fn().mockResolvedValue(undefined),
        appendSystemMessage: vi.fn(),
      };
      sessions.push(session);
      return session as any;
    });
    const registry = new FeishuSessionRegistry(createSession);

    const recoveredSessionId = createFeishuSessionId('oc_recovered');
    await registry.preload([recoveredSessionId, recoveredSessionId]);
    expect(createSession).toHaveBeenNthCalledWith(1, recoveredSessionId);

    const first = await registry.get('oc_private');
    expect(await registry.get('oc_private')).toBe(first);
    expect(await registry.get('oc_group')).not.toBe(first);
    expect(createSession).toHaveBeenNthCalledWith(2, createFeishuSessionId('oc_private'));
    expect(await registry.get('oc_recovered')).toBe(sessions[0]);
    expect(sessions.every(session => session.waitForInitialization.mock.calls.length === 1)).toBe(true);
    expect(createFeishuSessionId('oc_private')).toMatch(/^sess_feishu_[a-f0-9]{24}$/);
    expect(createFeishuSessionId('oc_private')).not.toContain('oc_private');
    expect(registry.size).toBe(3);

    await registry.stop();
    expect(sessions.every(session => session.shutdown.mock.calls.length === 1)).toBe(true);
    expect(registry.size).toBe(0);
  });
});
