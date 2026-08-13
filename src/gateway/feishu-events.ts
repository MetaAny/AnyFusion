import type { GatewayInboundEvent } from './types.js';

export interface FeishuRawMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: unknown;
      user_id?: unknown;
      union_id?: unknown;
    };
    sender_type?: unknown;
  };
  message?: {
    message_id?: unknown;
    chat_id?: unknown;
    chat_type?: unknown;
    message_type?: unknown;
    content?: unknown;
    mentions?: Array<{
      id?: {
        open_id?: unknown;
        user_id?: unknown;
      };
      name?: unknown;
    }>;
  };
}

export function normalizeFeishuInboundEvent(
  event: FeishuRawMessageEvent,
  input: { transport: 'websocket' | 'webhook'; receivedAt?: string },
): GatewayInboundEvent | null {
  const messageId = stringValue(event.message?.message_id);
  const chatId = stringValue(event.message?.chat_id);
  if (!messageId || !chatId) {
    return null;
  }

  const messageType = normalizeMessageType(event.message?.message_type);
  return {
    id: `feishu:${messageId}`,
    platform: 'feishu',
    transport: input.transport,
    messageId,
    chatId,
    chatType: normalizeChatType(event.message?.chat_type),
    text: messageType === 'text' ? parseFeishuText(event.message?.content) ?? '' : '',
    messageType,
    attachments: [],
    mentions: (event.message?.mentions ?? [])
      .map(mention => ({
        id: stringValue(mention.id?.open_id) ?? stringValue(mention.id?.user_id) ?? '',
        ...(typeof mention.name === 'string' ? { name: mention.name } : {}),
      }))
      .filter(mention => mention.id.length > 0),
    raw: event,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    ...(stringValue(event.sender?.sender_id?.open_id)
      ?? stringValue(event.sender?.sender_id?.user_id)
      ?? stringValue(event.sender?.sender_id?.union_id)
      ? {
          userId: stringValue(event.sender?.sender_id?.open_id)
            ?? stringValue(event.sender?.sender_id?.user_id)
            ?? stringValue(event.sender?.sender_id?.union_id)
            ?? undefined,
        }
      : {}),
  };
}

export function parseFeishuText(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : null;
  } catch {
    return content.trim();
  }
}

function normalizeChatType(value: unknown): GatewayInboundEvent['chatType'] {
  if (value === 'group' || value === 'chat') {
    return 'group';
  }
  if (value === 'p2p' || value === 'dm') {
    return 'dm';
  }
  return 'unknown';
}

function normalizeMessageType(value: unknown): GatewayInboundEvent['messageType'] {
  if (value === 'text' || value === 'post' || value === 'file' || value === 'image' || value === 'audio') {
    return value;
  }
  return 'unknown';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
