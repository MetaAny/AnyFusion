export type GatewayPlatform = 'feishu' | 'local' | 'slack' | 'dingtalk' | 'wecom';

export interface GatewayAttachment {
  id: string;
  type: 'file' | 'image' | 'audio' | 'unknown';
  name?: string;
  path?: string;
  url?: string;
}

export interface GatewayMention {
  id: string;
  name?: string;
  isBot?: boolean;
}

export interface GatewayInboundEvent {
  id: string;
  platform: GatewayPlatform;
  transport: 'websocket' | 'webhook' | 'socket' | 'http';
  messageId: string;
  chatId: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  chatName?: string;
  chatType: 'dm' | 'group' | 'thread' | 'unknown';
  text: string;
  messageType: 'text' | 'post' | 'file' | 'image' | 'audio' | 'command' | 'unknown';
  attachments: GatewayAttachment[];
  mentions: GatewayMention[];
  raw: unknown;
  receivedAt: string;
}

export interface GatewayTarget {
  kind: 'origin' | 'local' | 'home' | 'platform';
  platform?: GatewayPlatform;
  id?: string;
}

export interface GatewayArtifact {
  path: string;
  name?: string;
  contentType?: string;
}

export interface GatewayOutboundMessage {
  kind: 'progress' | 'final' | 'artifact' | 'notice' | 'error';
  markdown?: string;
  text?: string;
  artifacts?: GatewayArtifact[];
  taskId?: string;
  sourceEventId?: string;
  visibility: 'user' | 'admin' | 'debug';
  fallbackPolicy: 'split' | 'file' | 'local-only';
}

export interface GatewaySendResult {
  ok: boolean;
  target: GatewayTarget;
  method: 'card' | 'post' | 'file' | 'local' | 'noop';
  error?: string;
}

export interface GatewaySignalHandle {
  id: string;
}

export interface GatewayContext {
  emit(event: GatewayInboundEvent): Promise<void>;
}

export interface GatewayPlatformAdapter {
  readonly platform: GatewayPlatform;
  start(context: GatewayContext): Promise<void>;
  stop(): Promise<void>;
  send(target: GatewayTarget, message: GatewayOutboundMessage): Promise<GatewaySendResult>;
  uploadArtifact?(target: GatewayTarget, artifact: GatewayArtifact): Promise<GatewaySendResult>;
  addProcessingSignal?(event: GatewayInboundEvent): Promise<GatewaySignalHandle | null>;
  removeProcessingSignal?(handle: GatewaySignalHandle): Promise<void>;
}
