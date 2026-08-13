import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { evaluateFeishuGatewayPolicy, FeishuPairingStore } from '../../src/gateway/feishu-policy.js';

describe('Feishu Gateway policy', () => {
  it('allows only configured allowlist users for DM access', () => {
    const decision = evaluateFeishuGatewayPolicy({
      chatId: 'oc_chat',
      chatType: 'dm',
      senderId: 'ou_denied',
      mentionOpenIds: [],
    }, {
      dmPolicy: 'allowlist',
      allowedUsers: ['ou_allowed'],
      groupPolicy: 'open',
      requireMention: true,
    });

    expect(decision).toEqual({ allowed: false, reason: 'dm_allowlist_denied' });
  });

  it('requires bot mention in groups when mention gate is enabled', () => {
    expect(evaluateFeishuGatewayPolicy({
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      mentionOpenIds: [],
    }, {
      dmPolicy: 'pairing',
      allowedUsers: [],
      groupPolicy: 'open',
      requireMention: true,
    }).reason).toBe('bot_identity_missing');

    expect(evaluateFeishuGatewayPolicy({
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      mentionOpenIds: [],
    }, {
      dmPolicy: 'pairing',
      allowedUsers: [],
      groupPolicy: 'open',
      requireMention: true,
      botOpenId: 'ou_bot',
    }).reason).toBe('mention_required');

    expect(evaluateFeishuGatewayPolicy({
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      mentionOpenIds: ['ou_bot'],
    }, {
      dmPolicy: 'pairing',
      allowedUsers: [],
      groupPolicy: 'open',
      requireMention: true,
      botOpenId: 'ou_bot',
    }).allowed).toBe(true);
  });

  it('approves the first DM user to preserve existing single-user Feishu deployments', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-policy-'));
    const storePath = resolve(dir, 'pairings.json');
    const store = new FeishuPairingStore(storePath);

    const firstDecision = evaluateFeishuGatewayPolicy({
      chatId: 'oc_dm',
      chatType: 'dm',
      senderId: 'ou_first',
      mentionOpenIds: [],
    }, {
      dmPolicy: 'pairing',
      allowedUsers: [],
      groupPolicy: 'open',
      requireMention: true,
    }, store);

    const secondDecision = evaluateFeishuGatewayPolicy({
      chatId: 'oc_dm',
      chatType: 'dm',
      senderId: 'ou_second',
      mentionOpenIds: [],
    }, {
      dmPolicy: 'pairing',
      allowedUsers: [],
      groupPolicy: 'open',
      requireMention: true,
    }, store);

    expect(firstDecision).toEqual({ allowed: true, reason: 'dm_pairing_first_use' });
    expect(secondDecision).toEqual({ allowed: false, reason: 'dm_pairing_pending' });
    expect(JSON.parse(readFileSync(storePath, 'utf-8'))).toMatchObject({
      approvedUsers: {
        ou_first: {
          source: 'first_use',
        },
      },
      pendingUsers: {
        ou_second: {
          chatId: 'oc_dm',
        },
      },
    });
  });
});
