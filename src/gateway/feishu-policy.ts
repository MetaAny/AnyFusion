import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { resolveMetaclawDir } from '../utils/paths.js';

export type FeishuChatType = 'dm' | 'group' | 'unknown';

export interface FeishuGatewayAccessPolicy {
  dmPolicy: 'pairing' | 'allow_all' | 'allowlist';
  allowedUsers: string[];
  groupPolicy: 'open' | 'disabled' | 'allowlist' | 'admin_only';
  requireMention: boolean;
  botOpenId?: string;
}

export interface FeishuGatewayInboundIdentity {
  chatId: string;
  chatType: FeishuChatType;
  senderId?: string;
  senderType?: string;
  mentionOpenIds: string[];
}

export interface FeishuPolicyDecision {
  allowed: boolean;
  reason: string;
}

interface FeishuPairingState {
  approvedUsers: Record<string, { approvedAt: string; source: 'first_use' | 'manual' }>;
  pendingUsers: Record<string, { requestedAt: string; chatId: string }>;
}

export interface FeishuPairingList {
  approvedUsers: Array<{ userId: string; approvedAt: string; source: 'first_use' | 'manual' }>;
  pendingUsers: Array<{ userId: string; requestedAt: string; chatId: string }>;
}

export class FeishuPairingStore {
  constructor(private readonly statePath = resolve(resolveMetaclawDir(), 'feishu-pairings.json')) {}

  isApproved(userId: string): boolean {
    return Boolean(this.readState().approvedUsers[userId]);
  }

  list(): FeishuPairingList {
    const state = this.readState();
    return {
      approvedUsers: Object.entries(state.approvedUsers).map(([userId, value]) => ({
        userId,
        approvedAt: value.approvedAt,
        source: value.source,
      })),
      pendingUsers: Object.entries(state.pendingUsers).map(([userId, value]) => ({
        userId,
        requestedAt: value.requestedAt,
        chatId: value.chatId,
      })),
    };
  }

  approve(userId: string): boolean {
    const state = this.readState();
    const existed = Boolean(state.pendingUsers[userId] || state.approvedUsers[userId]);
    state.approvedUsers[userId] = {
      approvedAt: new Date().toISOString(),
      source: 'manual',
    };
    delete state.pendingUsers[userId];
    this.writeState(state);
    return existed;
  }

  revoke(userId: string): boolean {
    const state = this.readState();
    const existed = Boolean(state.approvedUsers[userId] || state.pendingUsers[userId]);
    delete state.approvedUsers[userId];
    delete state.pendingUsers[userId];
    this.writeState(state);
    return existed;
  }

  approveFirstUser(userId: string): void {
    const state = this.readState();
    if (Object.keys(state.approvedUsers).length > 0) {
      return;
    }
    state.approvedUsers[userId] = {
      approvedAt: new Date().toISOString(),
      source: 'first_use',
    };
    delete state.pendingUsers[userId];
    this.writeState(state);
  }

  addPending(userId: string, chatId: string): void {
    const state = this.readState();
    if (state.approvedUsers[userId] || state.pendingUsers[userId]) {
      return;
    }
    state.pendingUsers[userId] = {
      requestedAt: new Date().toISOString(),
      chatId,
    };
    this.writeState(state);
  }

  private readState(): FeishuPairingState {
    if (!existsSync(this.statePath)) {
      return { approvedUsers: {}, pendingUsers: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf-8')) as Partial<FeishuPairingState>;
      return {
        approvedUsers: parsed.approvedUsers ?? {},
        pendingUsers: parsed.pendingUsers ?? {},
      };
    } catch {
      return { approvedUsers: {}, pendingUsers: {} };
    }
  }

  private writeState(state: FeishuPairingState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  }
}

export function evaluateFeishuGatewayPolicy(
  event: FeishuGatewayInboundIdentity,
  policy: FeishuGatewayAccessPolicy,
  pairingStore = new FeishuPairingStore(),
): FeishuPolicyDecision {
  if (event.senderType === 'bot' || event.senderType === 'app') {
    return { allowed: false, reason: 'bot_sender' };
  }

  if (event.chatType === 'group') {
    if (policy.groupPolicy === 'disabled') {
      return { allowed: false, reason: 'group_disabled' };
    }
    if (policy.requireMention) {
      if (!policy.botOpenId) {
        return { allowed: false, reason: 'bot_identity_missing' };
      }
      if (!event.mentionOpenIds.includes(policy.botOpenId)) {
        return { allowed: false, reason: 'mention_required' };
      }
    }
    return { allowed: true, reason: 'group_allowed' };
  }

  if (policy.dmPolicy === 'allow_all') {
    return { allowed: true, reason: 'dm_allow_all' };
  }

  if (!event.senderId) {
    // Some test/webhook payloads omit sender identity; keep the current bridge usable.
    return { allowed: true, reason: 'missing_sender_identity' };
  }

  if (policy.dmPolicy === 'allowlist') {
    return policy.allowedUsers.includes(event.senderId)
      ? { allowed: true, reason: 'dm_allowlist' }
      : { allowed: false, reason: 'dm_allowlist_denied' };
  }

  if (pairingStore.isApproved(event.senderId)) {
    return { allowed: true, reason: 'dm_pairing_approved' };
  }

  pairingStore.approveFirstUser(event.senderId);
  if (pairingStore.isApproved(event.senderId)) {
    return { allowed: true, reason: 'dm_pairing_first_use' };
  }

  pairingStore.addPending(event.senderId, event.chatId);
  return { allowed: false, reason: 'dm_pairing_pending' };
}
