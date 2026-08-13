// Feishu app integration module for tokens, inbound events, message delivery, and file exchange.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { createDecipheriv, createHash } from 'crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../core/types.js';
import type {
  PlannerTuiExecutorResult,
  PlannerTuiPermissionRequest,
  PlannerTuiPermissionResolutionResult,
  PlannerTuiSnapshot,
  SessionSnapshot,
} from '../session/metaclaw-session.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import { createMarkdownPreviewBaseUrl, createMarkdownPreviewLinks } from './markdown-preview.js';
import { resolveFeishuGatewayConfig, toFeishuAppConfig } from '../gateway/feishu-config.js';
import {
  evaluateFeishuGatewayPolicy,
  FeishuPairingStore,
  type FeishuGatewayAccessPolicy,
  type FeishuGatewayInboundIdentity,
} from '../gateway/feishu-policy.js';
import { dump, load } from 'js-yaml';
import { GatewayAuditLog } from '../gateway/audit.js';
import { normalizeFeishuInboundEvent, type FeishuRawMessageEvent } from '../gateway/feishu-events.js';

export interface FeishuAppConfig {
  enabled: boolean;
  mode?: 'websocket' | 'webhook';
  app_id?: string;
  app_secret?: string;
  app_secret_env?: string;
  event_port: number;
  event_path: string;
  verification_token?: string;
  encrypt_key_env?: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface FeishuAppClientDeps {
  postJson?: (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<JsonResponse>;
  postForm?: (url: string, form: FormData, headers?: Record<string, string>) => Promise<JsonResponse>;
  getBinary?: (url: string, headers?: Record<string, string>) => Promise<BinaryResponse>;
  deleteJson?: (url: string, headers?: Record<string, string>) => Promise<JsonResponse>;
  nowMs?: () => number;
}

interface TenantTokenState {
  token: string;
  expiresAtMs: number;
}

interface BinaryResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface DownloadedFeishuResource {
  path: string;
  fileName: string;
}

const FEISHU_TYPING_REACTION = 'Typing';
const FEISHU_REPLY_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const FEISHU_REPLY_MESSAGE_MAX_LENGTH = 1200;
const FEISHU_POST_ROW_MAX_LENGTH = 900;
const FEISHU_CARD_MARKDOWN_ELEMENT_MAX_LENGTH = 900;
const FEISHU_REPLY_TERMINAL_SETTLE_MS = 300;

type FeishuPostRow = Array<{
  tag: 'md';
  text: string;
}>;

type FeishuRichTextPostRow = Array<{
  tag: 'text';
  text: string;
}>;

interface FeishuPostContent {
  zh_cn: {
    title?: string;
    content: FeishuPostRow[];
  };
}

interface FeishuRichTextPostContent {
  zh_cn: {
    title?: string;
    content: FeishuRichTextPostRow[];
  };
}

interface FeishuWebhookPostContent {
  post: FeishuPostContent;
}

interface FeishuWebhookCardContent {
  card: FeishuMarkdownCard;
}

type FeishuMarkdownCard = FeishuMarkdownCardV1 | FeishuMarkdownCardV2;

interface FeishuMarkdownCardV1 {
  config: {
    wide_screen_mode: boolean;
  };
  header?: {
    template: 'blue';
    title: {
      tag: 'plain_text';
      content: string;
    };
  };
  elements: FeishuMarkdownCardElement[];
}

interface FeishuMarkdownCardV2 {
  schema: '2.0';
  config: {
    wide_screen_mode: boolean;
  };
  header?: FeishuMarkdownCardV1['header'];
  body: {
    elements: FeishuMarkdownCardV2Element[];
  };
}

type FeishuMarkdownCardElement =
  {
      tag: 'div';
      text: {
        tag: 'lark_md' | 'plain_text';
        content: string;
      };
    };

type FeishuMarkdownCardV2Element =
  | {
      tag: 'markdown';
      content: string;
    }
  | {
      tag: 'table';
      page_size: number;
      row_height: 'low';
      columns: Array<{
        name: string;
        display_name: string;
        data_type: 'text';
        width: 'auto';
      }>;
      rows: Array<Record<string, string>>;
    };

const MARKDOWN_FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const MARKDOWN_FENCE_CLOSE_RE = /^```\s*$/;

export class FeishuAppClient {
  private tenantToken: TenantTokenState | null = null;
  private readonly postJson: (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly postForm: (url: string, form: FormData, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly getBinary: (url: string, headers?: Record<string, string>) => Promise<BinaryResponse>;
  private readonly deleteJson: (url: string, headers?: Record<string, string>) => Promise<JsonResponse>;
  private readonly nowMs: () => number;

  constructor(
    private readonly config: Required<Pick<FeishuAppConfig, 'app_id' | 'app_secret'>>,
    deps: FeishuAppClientDeps = {},
  ) {
    this.postJson = deps.postJson ?? defaultPostJson;
    this.postForm = deps.postForm ?? defaultPostForm;
    this.getBinary = deps.getBinary ?? defaultGetBinary;
    this.deleteJson = deps.deleteJson ?? defaultDeleteJson;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAtMs > this.nowMs()) {
      return this.tenantToken.token;
    }

    const response = await this.postJson(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: this.config.app_id,
        app_secret: this.config.app_secret,
      },
    );
    const payload = await response.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`飞书 tenant_access_token 获取失败: ${payload.msg ?? response.status}`);
    }

    const ttlMs = Math.max((payload.expire ?? 7200) - 300, 60) * 1000;
    this.tenantToken = {
      token: payload.tenant_access_token,
      expiresAtMs: this.nowMs() + ttlMs,
    };
    return this.tenantToken.token;
  }

  async sendTextToChat(chatId: string, text: string): Promise<void> {
    await this.sendMarkdownCardToChat(chatId, text);
  }

  async sendMarkdownPostToChat(chatId: string, markdown: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.postJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify(createFeishuPlainTextPostContent(markdown)),
      },
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书富文本消息发送失败: ${payload.code ?? response.status}${payload.msg ? ` ${payload.msg}` : ''}`);
    }
  }

  async sendMarkdownCardToChat(chatId: string, markdown: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const sendCard = async (card: FeishuMarkdownCard) => {
      const response = await this.postJson(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
        {
          authorization: `Bearer ${token}`,
        },
      );
      const payload = await response.json() as { code?: number; msg?: string };
      if (!response.ok || payload.code !== 0) {
        throw new Error(`飞书消息发送失败: ${payload.code ?? response.status}${payload.msg ? ` ${payload.msg}` : ''}`);
      }
    };

    const card = createFeishuMarkdownCard(markdown);
    try {
      await sendCard(card);
    } catch (error) {
      let fallbackError = error;
      if (isFeishuTableCard(card) && isFeishuCardContentError(error)) {
        try {
          await sendCard(createFeishuMarkdownCard(markdown, { tableMode: 'markdown' }));
          return;
        } catch (tableFallbackError) {
          fallbackError = tableFallbackError;
        }
      }
      if (isFeishuCardContentError(fallbackError)) {
        await sendCard(createFeishuPlainTextCard(markdown));
        return;
      }
      throw fallbackError;
    }
  }

  async uploadFile(filePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const fileStats = statSync(filePath);
    const form = new FormData();
    form.set('file_type', 'stream');
    form.set('file_name', basename(filePath));
    form.set('file', new Blob([readFileSync(filePath)]), basename(filePath));
    form.set('duration', '0');

    const response = await this.postForm(
      'https://open.feishu.cn/open-apis/im/v1/files',
      form,
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as {
      code?: number;
      msg?: string;
      data?: { file_key?: string };
      file_key?: string;
    };
    const fileKey = payload.data?.file_key ?? payload.file_key;
    if (!response.ok || payload.code !== 0 || !fileKey) {
      throw new Error(`飞书文件上传失败: ${payload.msg ?? response.status}`);
    }
    void fileStats;
    return fileKey;
  }

  async sendFileToChat(chatId: string, fileKey: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.postJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书文件消息发送失败: ${payload.msg ?? response.status}`);
    }
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    resourceType: 'file' | 'image';
    fileName?: string;
    outputDir?: string;
  }): Promise<DownloadedFeishuResource> {
    const token = await this.getTenantAccessToken();
    const url = [
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}`,
      `/resources/${encodeURIComponent(input.fileKey)}?type=${encodeURIComponent(input.resourceType)}`,
    ].join('');
    const response = await this.getBinary(url, {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`飞书消息资源下载失败: ${body || response.status}`);
    }

    const outputDir = input.outputDir ?? resolve(resolveMetaclawDir(), 'feishu-uploads', sanitizePathPart(input.messageId));
    mkdirSync(outputDir, { recursive: true });
    const fileName = sanitizeFileName(
      input.fileName
        ?? extractFilenameFromContentDisposition(response.headers.get('content-disposition'))
        ?? `${input.fileKey}${input.resourceType === 'image' ? '.jpg' : ''}`,
    );
    const outputPath = resolve(outputDir, fileName);
    writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));

    return { path: outputPath, fileName };
  }

  async addReactionToMessage(messageId: string, emojiType: string): Promise<string | null> {
    const token = await this.getTenantAccessToken();
    const response = await this.postJson(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string; data?: { reaction_id?: string }; reaction_id?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书表情添加失败: ${payload.msg ?? response.status}`);
    }
    return payload.data?.reaction_id ?? payload.reaction_id ?? null;
  }

  async removeReactionFromMessage(messageId: string, reactionId: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await this.deleteJson(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        authorization: `Bearer ${token}`,
      },
    );
    const payload = await response.json() as { code?: number; msg?: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书表情删除失败: ${payload.msg ?? response.status}`);
    }
  }
}

interface FeishuEventBridgeDeps {
  client: FeishuMessageClient;
  session: MetaclawSession;
  config: FeishuAppConfig;
  gatewayConfig?: ResolvedFeishuRuntimeBridgeConfig;
  markdownPreview?: FeishuMessageHandlerDeps['markdownPreview'];
}

export interface FeishuBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForFailure(): Promise<never>;
}

type FeishuIncomingMessageEvent = FeishuRawMessageEvent;

interface FeishuMessageSession {
  getSnapshot(): Pick<SessionSnapshot, 'output'>;
  subscribe?: (listener: (snapshot: Pick<SessionSnapshot, 'output'>) => void) => () => void;
  submit(rawInput: string, options?: { awaitAsyncWork?: boolean }): Promise<{ exitRequested: boolean }>;
  appendSystemMessage(...lines: string[]): void;
  getPlannerTuiSnapshot?: () => Pick<PlannerTuiSnapshot, 'taskPool'>;
  getPlannerTuiPermissionRequests?: () => PlannerTuiPermissionRequest[];
  getPlannerTuiExecutorResults?: () => PlannerTuiExecutorResult[];
  resolvePlannerTuiPermission?: (
    permissionRequestId: string,
    resolution: 'approve' | 'deny',
  ) => Promise<PlannerTuiPermissionResolutionResult>;
}

export interface FeishuMarkdownPreviewOptions {
  baseUrl: string;
  workspaceRoot: string;
}

type FeishuMessageClient = Pick<
  FeishuAppClient,
  'addReactionToMessage' | 'removeReactionFromMessage' | 'sendMarkdownCardToChat'
>
  & Partial<Pick<FeishuAppClient, 'sendMarkdownPostToChat' | 'downloadMessageResource' | 'uploadFile' | 'sendFileToChat'>>;

interface FeishuMessageHandlerDeps {
  client: FeishuMessageClient;
  session: FeishuMessageSession;
  seenMessageIds: Set<string>;
  accessPolicy?: FeishuGatewayAccessPolicy;
  pairingStore?: FeishuPairingStore;
  setHomeChannel?: (chatId: string) => void;
  audit?: FeishuDeliveryAudit;
  transport?: 'websocket' | 'webhook';
  pendingResourcesByChatId?: Map<string, string[]>;
  uploadDir?: string;
  markdownPreview?: FeishuMarkdownPreviewOptions;
  autoApproveRepositoryPromotion?: boolean;
}

type FeishuMessageDispatchDeps = Omit<FeishuMessageHandlerDeps, 'session'> & {
  session?: FeishuMessageSession;
  resolveSession?: (chatId: string) => Promise<FeishuMessageSession>;
};

interface FeishuDeliveryAudit {
  record(event: FeishuDeliveryAuditEvent): void;
}

interface FeishuDeliveryAuditEvent {
  kind: 'inbound' | 'policy' | 'session' | 'progress' | 'final' | 'artifact' | 'fallback' | 'permission';
  chatId: string;
  requestId?: string;
  reason?: string;
  chunkIndex?: number;
  chunkCount?: number;
  method: 'card' | 'post' | 'file' | 'local' | 'notice' | 'skipped';
  ok: boolean;
  error?: string;
}

type FeishuWebSocketEventHandlers = Parameters<InstanceType<typeof Lark.EventDispatcher>['register']>[0];

export class FeishuEventBridge {
  private server: Server | null = null;
  private readonly seenMessageIds = new Set<string>();
  private readonly pendingResourcesByChatId = new Map<string, string[]>();

  constructor(private readonly deps: FeishuEventBridgeDeps) {}

  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.config.event_port, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    const server = this.server;
    this.server = null;
    return new Promise((resolve, reject) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(error => error ? reject(error) : resolve());
    });
  }

  waitForFailure(): Promise<never> {
    return new Promise<never>(() => undefined);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url?.split('?')[0] !== this.deps.config.event_path) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    try {
      const payload = this.decryptPayloadIfNeeded(JSON.parse(await readRequestBody(request)) as Record<string, unknown>);
      const challenge = this.extractChallenge(payload);
      if (challenge) {
        writeJson(response, 200, { challenge });
        return;
      }

      if (!this.isVerified(payload)) {
        writeJson(response, 403, { error: 'invalid_token' });
        return;
      }

      writeJson(response, 200, { code: 0 });
      await this.handleEvent(payload);
    } catch (error) {
      writeJson(response, 400, { error: (error as Error).message });
    }
  }

  private extractChallenge(payload: Record<string, unknown>): string | null {
    if (typeof payload.challenge === 'string') {
      return payload.challenge;
    }

    const event = payload.event as Record<string, unknown> | undefined;
    return typeof event?.challenge === 'string' ? event.challenge : null;
  }

  private decryptPayloadIfNeeded(payload: Record<string, unknown>): Record<string, unknown> {
    if (typeof payload.encrypt !== 'string') {
      return payload;
    }
    const encryptKeyEnv = this.deps.config.encrypt_key_env;
    const encryptKey = encryptKeyEnv ? process.env[encryptKeyEnv] : undefined;
    if (!encryptKey) {
      throw new Error(`飞书事件已加密，但缺少 encrypt key 环境变量 ${encryptKeyEnv ?? 'FEISHU_ENCRYPT_KEY'}`);
    }
    return decryptFeishuEventPayload(payload.encrypt, encryptKey);
  }

  private isVerified(payload: Record<string, unknown>): boolean {
    const expectedToken = this.deps.config.verification_token;
    if (!expectedToken) {
      return true;
    }

    const header = payload.header as Record<string, unknown> | undefined;
    return payload.token === expectedToken || header?.token === expectedToken;
  }

  private async handleEvent(payload: Record<string, unknown>): Promise<void> {
    const header = payload.header as Record<string, unknown> | undefined;
    const eventType = header?.event_type ?? payload.type;
    if (eventType !== 'im.message.receive_v1') {
      return;
    }

    const event = payload.event as Record<string, unknown> | undefined;
    await handleFeishuMessageEvent(event, {
      client: this.deps.client,
      session: this.deps.session,
      seenMessageIds: this.seenMessageIds,
      accessPolicy: this.deps.gatewayConfig?.accessPolicy,
      pairingStore: this.deps.gatewayConfig ? new FeishuPairingStore() : undefined,
      setHomeChannel: this.deps.gatewayConfig
        ? chatId => writeFeishuHomeChannel(this.deps.gatewayConfig!.configPath, chatId)
        : undefined,
      audit: createFeishuDeliveryAudit(),
      transport: 'webhook',
      pendingResourcesByChatId: this.pendingResourcesByChatId,
      markdownPreview: this.deps.markdownPreview,
      autoApproveRepositoryPromotion: this.deps.gatewayConfig?.autoApproveRepositoryPromotion,
    });
  }
}

interface FeishuWebSocketBridgeDeps {
  client: FeishuMessageClient;
  session?: MetaclawSession;
  resolveSession?: (chatId: string) => Promise<MetaclawSession>;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  gatewayConfig?: ResolvedFeishuRuntimeBridgeConfig;
  markdownPreview?: FeishuMessageHandlerDeps['markdownPreview'];
  onConnectionState?: (state: 'starting' | 'connected' | 'reconnecting' | 'failed' | 'stopped', error?: Error) => void;
  readyTimeoutMs?: number;
}

interface ResolvedFeishuRuntimeBridgeConfig {
  accessPolicy: FeishuGatewayAccessPolicy;
  configPath: string;
  autoApproveRepositoryPromotion: boolean;
}

export class FeishuWebSocketBridge implements FeishuBridge {
  private wsClient: Lark.WSClient | null = null;
  private rejectFailure: ((error: Error) => void) | null = null;
  private failurePromise: Promise<never> = new Promise<never>((_resolve, reject) => {
    this.rejectFailure = reject;
  });
  private ready = false;
  private readonly seenMessageIds = new Set<string>();
  private readonly pendingResourcesByChatId = new Map<string, string[]>();

  constructor(private readonly deps: FeishuWebSocketBridgeDeps) {}

  async start(): Promise<void> {
    if (this.wsClient) {
      return;
    }

    this.deps.onConnectionState?.('starting');
    const eventDispatcher = new Lark.EventDispatcher({
      verificationToken: this.deps.verificationToken,
      loggerLevel: Lark.LoggerLevel.warn,
    }).register(createFeishuWebSocketEventHandlers({
      client: this.deps.client,
      session: this.deps.session,
      resolveSession: this.deps.resolveSession,
      seenMessageIds: this.seenMessageIds,
      accessPolicy: this.deps.gatewayConfig?.accessPolicy,
      pairingStore: this.deps.gatewayConfig ? new FeishuPairingStore() : undefined,
      setHomeChannel: this.deps.gatewayConfig
        ? chatId => writeFeishuHomeChannel(this.deps.gatewayConfig!.configPath, chatId)
        : undefined,
      audit: createFeishuDeliveryAudit(),
      transport: 'websocket',
      pendingResourcesByChatId: this.pendingResourcesByChatId,
      markdownPreview: this.deps.markdownPreview,
      autoApproveRepositoryPromotion: this.deps.gatewayConfig?.autoApproveRepositoryPromotion,
    }));

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.wsClient = new Lark.WSClient({
      appId: this.deps.appId,
      appSecret: this.deps.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      onReady: () => {
        this.ready = true;
        this.deps.onConnectionState?.('connected');
        resolveReady?.();
      },
      onError: error => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.deps.onConnectionState?.('failed', normalizedError);
        if (this.ready) {
          this.rejectFailure?.(normalizedError);
        } else {
          rejectReady?.(normalizedError);
        }
      },
      onReconnecting: () => {
        this.deps.onConnectionState?.('reconnecting');
      },
      onReconnected: () => {
        this.deps.onConnectionState?.('connected');
      },
    });

    await this.wsClient.start({ eventDispatcher });
    const timeoutMs = this.deps.readyTimeoutMs ?? 60_000;
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`飞书长连接在 ${timeoutMs}ms 内未就绪`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = null;
    this.ready = false;
    this.deps.onConnectionState?.('stopped');
    return Promise.resolve();
  }

  waitForFailure(): Promise<never> {
    return this.failurePromise;
  }
}

export function createFeishuWebSocketEventHandlers(deps: FeishuMessageDispatchDeps): FeishuWebSocketEventHandlers {
  return {
    'im.message.receive_v1': async data => {
      await handleFeishuMessageEvent(data, deps);
    },
    'im.message.message_read_v1': () => undefined,
    'im.message.reaction.created_v1': () => undefined,
    'im.message.reaction.deleted_v1': () => undefined,
  };
}

export async function handleFeishuMessageEvent(
  event: FeishuIncomingMessageEvent | undefined,
  deps: FeishuMessageDispatchDeps,
): Promise<boolean> {
  const normalizedEvent = event
    ? normalizeFeishuInboundEvent(event, { transport: deps.transport ?? 'websocket' })
    : null;
  const message = event?.message;
  if (!message || !normalizedEvent) {
    return false;
  }
  const messageId = normalizedEvent.messageId;
  const chatId = normalizedEvent.chatId;
  const messageType = normalizedEvent.messageType;
  const session = deps.resolveSession
    ? await deps.resolveSession(chatId)
    : deps.session;
  if (!session) {
    throw new Error('飞书消息没有可用的 Gateway session');
  }
  const { resolveSession: _resolveSession, ...baseDeps } = deps;
  const scopedDeps: FeishuMessageHandlerDeps = { ...baseDeps, session };
  if (deps.seenMessageIds.has(messageId)) {
    return false;
  }
  deps.seenMessageIds.add(messageId);
  recordFeishuAudit(scopedDeps, {
    kind: 'inbound',
    chatId,
    requestId: messageId,
    method: 'skipped',
    ok: true,
  });

  if (deps.accessPolicy) {
    const identity = extractFeishuGatewayInboundIdentity(event, chatId);
    const decision = evaluateFeishuGatewayPolicy(identity, deps.accessPolicy, deps.pairingStore);
    recordFeishuAudit(scopedDeps, {
      kind: 'policy',
      chatId,
      requestId: messageId,
      method: 'skipped',
      ok: decision.allowed,
      reason: decision.reason,
    });
    if (!decision.allowed) {
      if (decision.reason === 'dm_pairing_pending') {
        await deps.client.sendMarkdownCardToChat(chatId, '已收到你的授权请求。请等待 MetaClaw 管理员批准后再继续使用。')
          .catch(error => session.appendSystemMessage(`⚠️ 飞书授权提示发送失败: ${(error as Error).message}`));
      }
      session.appendSystemMessage(`→ 飞书消息已被 Gateway 策略拦截: ${decision.reason}`);
      return true;
    }
  }

  const permissionCommand = parseFeishuPermissionResolutionCommand(normalizedEvent.text);
  if (permissionCommand) {
    return await handleFeishuPermissionResolutionCommand(permissionCommand, chatId, scopedDeps);
  }
  if (normalizedEvent.text.trim() === '重发上次结果') {
    return await handleFeishuRedeliverLatestResult(chatId, scopedDeps);
  }
  const pendingPromotions = messageType === 'text' ? pendingRepositoryPromotions(session) : [];
  if (pendingPromotions.length > 0) {
    if (deps.autoApproveRepositoryPromotion) {
      await completeFeishuTaskWithAutoApproval(chatId, pendingPromotions[0]!.taskId, scopedDeps);
      return true;
    }
    const olderCount = pendingPromotions.length - 1;
    await deps.client.sendMarkdownCardToChat(
      chatId,
      [
        formatFeishuPermissionPrompt(pendingPromotions[0]!),
        ...(olderCount > 0 ? [`另有 ${olderCount} 个较早的待授权请求；“本次发布”始终指上面这条最新请求。`] : []),
      ].join('\n\n'),
    );
    return true;
  }

  let text = normalizedEvent.text;
  if (messageType === 'post') {
    const post = parseFeishuPostContent(message.content);
    if (!post) {
      return false;
    }
    let downloadedResources: DownloadedFeishuResource[] = [];
    try {
      downloadedResources = await downloadAndQueueFeishuResources(post.resources, messageId, chatId, scopedDeps);
    } catch (error) {
      session.appendSystemMessage(`⚠️ 飞书富文本附件下载失败: ${(error as Error).message}`);
      await deps.client.sendMarkdownCardToChat(chatId, `图文消息中的附件接收失败：${(error as Error).message}`)
        .catch(() => undefined);
      return true;
    }
    text = post.text;
    if (!text) {
      await sendFeishuResourceReceipt(chatId, downloadedResources.map(item => item.fileName), scopedDeps);
      return true;
    }
  } else if (messageType !== 'text') {
    return await handleFeishuResourceMessage(message, {
      chatId,
      messageId,
      messageType,
      client: deps.client,
      session,
      pendingResourcesByChatId: deps.pendingResourcesByChatId,
      uploadDir: deps.uploadDir,
    });
  }

  if (!text) {
    return false;
  }

  if (isFeishuSetHomeCommand(text)) {
    deps.setHomeChannel?.(chatId);
    await deps.client.sendMarkdownCardToChat(chatId, `已将当前飞书会话设置为 MetaClaw home channel：${chatId}`);
    session.appendSystemMessage(`→ 飞书 home channel 已更新: ${chatId}`);
    return true;
  }

  let typingReactionId: string | null = null;
  try {
    typingReactionId = await deps.client.addReactionToMessage(messageId, FEISHU_TYPING_REACTION);
  } catch (error) {
    session.appendSystemMessage(`⚠️ 飞书 ${FEISHU_TYPING_REACTION} 表情添加失败: ${(error as Error).message}`);
  }

  try {
    const before = session.getSnapshot().output.length;
    let observedOutputLength = before;
    let progressSendQueue = Promise.resolve();
    let progressFlushTimer: NodeJS.Timeout | null = null;
    const pendingProgressOutputs: string[] = [];
    const sentProgressSteps = new Set<string>();
    const flushProgress = () => {
      if (pendingProgressOutputs.length === 0) {
        return progressSendQueue;
      }
      const progressOutput = mergeFeishuProgressOutputs(pendingProgressOutputs.splice(0));
      progressSendQueue = progressSendQueue.then(() =>
        deps.client.sendMarkdownCardToChat(chatId, progressOutput)
          .catch((error) => {
            session.appendSystemMessage(`⚠️ 飞书步骤消息回发失败: ${(error as Error).message}`);
          })
      );
      return progressSendQueue;
    };
    const enqueueProgress = (progressOutput: string) => {
      pendingProgressOutputs.push(progressOutput);
      if (progressFlushTimer) {
        return;
      }
      progressFlushTimer = setTimeout(() => {
        progressFlushTimer = null;
        void flushProgress();
      }, 100);
    };
    let progressTargetTaskId: string | null = null;
    let unsubscribe: (() => void) | undefined;
    unsubscribe = session.subscribe?.((snapshot) => {
      const newLines = snapshot.output.slice(observedOutputLength);
      observedOutputLength = snapshot.output.length;
      const allMessageLines = snapshot.output.slice(before);
      progressTargetTaskId = progressTargetTaskId ?? extractFeishuReplyTargetTaskId(allMessageLines);
      const progressLines = progressTargetTaskId
        ? filterFeishuOutputLinesForTask(allMessageLines, progressTargetTaskId)
        : newLines;
      const guidanceLines = extractFeishuGuidanceProgressLines(allMessageLines);
      for (const progressOutput of formatFeishuStreamingProgressReplies([
        ...guidanceLines,
        ...progressLines,
      ], sentProgressSteps)) {
        enqueueProgress(progressOutput);
      }
    });
    let outputLines: string[];
    try {
      const textWithResources = appendPendingFeishuResourcesToText(text, chatId, deps.pendingResourcesByChatId);
      let submitSucceeded = false;
      const submitPromise = session.submit(textWithResources, { awaitAsyncWork: true }).then(result => {
        submitSucceeded = true;
        return result;
      });
      outputLines = await waitForFeishuReplyOutputLines(session, before, submitPromise);
      if (submitSucceeded && !hasReplayablePlannerFailure(outputLines)) {
        deps.pendingResourcesByChatId?.delete(chatId);
      }
    } finally {
      unsubscribe?.();
    }
    const targetTaskId = extractFeishuReplyTargetTaskId(outputLines);
    if (deps.autoApproveRepositoryPromotion && targetTaskId
      && pendingRepositoryPromotions(session).some(request => request.taskId === targetTaskId)) {
      await completeFeishuTaskWithAutoApproval(chatId, targetTaskId, scopedDeps);
      return true;
    }
    const replyOutputLines = targetTaskId
      ? filterFeishuOutputLinesForTask(outputLines, targetTaskId)
      : outputLines;
    const progressOutput = session.subscribe
      ? ''
      : formatFeishuProgressReply(replyOutputLines);
    const rawOutput = formatFeishuReply(replyOutputLines) || formatFeishuPendingReply(replyOutputLines);
    const output = sanitizeFeishuFinalReply(rawOutput, replyOutputLines);
    const reply = appendMarkdownPreviewLinks(output, replyOutputLines, deps.markdownPreview);
    if (!reply) {
      return true;
    }
    try {
      if (progressOutput) {
        enqueueProgress(progressOutput);
      }
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = null;
      }
      await flushProgress();
      await progressSendQueue;
      const chunks = splitForFeishu(reply);
      await sendFeishuFinalReplyChunks(chatId, chunks, scopedDeps);
      await sendArtifactFilesToFeishu(chatId, replyOutputLines, scopedDeps);
    } catch (error) {
      session.appendSystemMessage(`⚠️ 飞书消息回发失败: ${(error as Error).message}`);
    }
  } finally {
    if (typingReactionId) {
      try {
        await deps.client.removeReactionFromMessage(messageId, typingReactionId);
      } catch (error) {
        session.appendSystemMessage(`⚠️ 飞书 ${FEISHU_TYPING_REACTION} 表情删除失败: ${(error as Error).message}`);
      }
    }
  }
  return true;
}

export interface CreateFeishuBridgeOptions {
  resolveSession?: (chatId: string) => Promise<MetaclawSession>;
  botOpenId?: string;
  onConnectionState?: FeishuWebSocketBridgeDeps['onConnectionState'];
  readyTimeoutMs?: number;
  credentialEnv?: NodeJS.ProcessEnv;
}

export function createFeishuBridge(
  config: Config,
  session: MetaclawSession | undefined,
  options: CreateFeishuBridgeOptions = {},
): FeishuBridge | null {
  const gatewayFeishu = resolveFeishuGatewayConfig(config, options.credentialEnv);
  const feishu = toFeishuAppConfig(gatewayFeishu);
  if (!gatewayFeishu.enabled || !gatewayFeishu.appId) {
    return null;
  }

  const appSecret = resolveAppSecret(feishu, options.credentialEnv);
  if (!appSecret) {
    const secretEnvHint = feishu.app_secret_env
      ? `环境变量 ${feishu.app_secret_env} 未设置`
      : '未配置 app_secret_env';
    throw new Error(`飞书应用已启用，但缺少 app_secret，且${secretEnvHint}`);
  }

  const client = new FeishuAppClient({
    app_id: gatewayFeishu.appId,
    app_secret: appSecret,
  });
  const markdownPreview = buildFeishuMarkdownPreviewOptions(config);
  const gatewayConfig = {
    accessPolicy: buildFeishuGatewayAccessPolicy(config, options.botOpenId),
    configPath: resolve(resolveMetaclawDir(), 'config.yaml'),
    autoApproveRepositoryPromotion: gatewayFeishu.publicationApproval === 'auto',
  };

  if (gatewayFeishu.connectionMode === 'webhook') {
    if (!session) {
      throw new Error('飞书 Webhook 模式需要固定 session');
    }
    return new FeishuEventBridge({
      config: feishu,
      session,
      client,
      gatewayConfig,
      markdownPreview,
    });
  }

  return new FeishuWebSocketBridge({
    session,
    resolveSession: options.resolveSession,
    client,
    appId: gatewayFeishu.appId,
    appSecret,
    verificationToken: gatewayFeishu.verificationToken,
    gatewayConfig,
    markdownPreview,
    onConnectionState: options.onConnectionState,
    readyTimeoutMs: options.readyTimeoutMs,
  });
}

export const createFeishuEventBridge = createFeishuBridge;

export function buildFeishuGatewayAccessPolicy(
  config: Config,
  botOpenId?: string,
): FeishuGatewayAccessPolicy {
  const feishu = config.gateway?.platforms?.feishu;
  return {
    dmPolicy: feishu?.access?.dm_policy ?? 'pairing',
    allowedUsers: feishu?.access?.allowed_users ?? [],
    groupPolicy: feishu?.access?.group_policy ?? 'open',
    requireMention: feishu?.access?.require_mention ?? true,
    ...(botOpenId ? { botOpenId } : {}),
  };
}

function createFeishuDeliveryAudit(): FeishuDeliveryAudit {
  const auditLog = new GatewayAuditLog();
  return {
    record(event) {
      auditLog.record({
        platform: 'feishu',
        kind: event.kind,
        target: event.chatId,
        method: event.method,
        ok: event.ok,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.chunkIndex !== undefined ? { chunkIndex: event.chunkIndex } : {}),
        ...(event.chunkCount !== undefined ? { chunkCount: event.chunkCount } : {}),
        ...(event.error ? { error: event.error } : {}),
      });
    },
  };
}

export function buildFeishuMarkdownPreviewOptions(config: Config, workspaceRoot = process.cwd()): FeishuMarkdownPreviewOptions | undefined {
  const previewConfig = config.integrations?.markdown_preview;
  if (!previewConfig?.enabled) {
    return undefined;
  }

  return {
    baseUrl: createMarkdownPreviewBaseUrl(previewConfig),
    workspaceRoot,
  };
}

export function createFeishuMarkdownPostContent(markdown: string, options: { title?: string } = {}): FeishuPostContent {
  return {
    zh_cn: {
      ...(options.title ? { title: options.title } : {}),
      content: createFeishuMarkdownPostRows(markdown),
    },
  };
}

export function createFeishuPlainTextPostContent(markdown: string, options: { title?: string } = {}): FeishuRichTextPostContent {
  return {
    zh_cn: {
      ...(options.title ? { title: options.title } : {}),
      content: createFeishuPlainTextPostRows(markdown),
    },
  };
}

export function createFeishuWebhookMarkdownPost(markdown: string, title = 'Metaclaw'): FeishuWebhookPostContent {
  return {
    post: createFeishuMarkdownPostContent(markdown, { title }),
  };
}

export function createFeishuWebhookMarkdownCard(markdown: string): FeishuWebhookCardContent {
  return {
    card: createFeishuMarkdownCard(markdown),
  };
}

export function createFeishuMarkdownCard(
  markdown: string,
  options: { tableMode?: 'native' | 'markdown' } = {},
): FeishuMarkdownCard {
  const { title, content } = extractFeishuCardTitle(markdown);
  const tableMode = options.tableMode ?? 'native';
  if (tableMode === 'native' && hasFeishuMarkdownTable(content)) {
    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      ...(title
        ? {
            header: {
              template: 'blue' as const,
              title: {
                tag: 'plain_text' as const,
                content: title,
              },
            },
          }
        : {}),
      body: {
        elements: createFeishuMarkdownCardV2Elements(content),
      },
    };
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    ...(title
      ? {
          header: {
            template: 'blue' as const,
            title: {
              tag: 'plain_text' as const,
              content: title,
            },
          },
        }
      : {}),
    elements: createFeishuMarkdownCardElements(content, { tableMode }),
  };
}

function extractFeishuCardTitle(markdown: string): { title: string | null; content: string } {
  const lines = markdown.split('\n');
  const firstContentIndex = lines.findIndex(line => line.trim().length > 0);
  if (firstContentIndex === -1) {
    return { title: null, content: markdown };
  }

  const headingMatch = lines[firstContentIndex]?.match(/^#\s+(.+?)\s*$/);
  if (!headingMatch) {
    return { title: null, content: markdown };
  }

  const contentLines = [
    ...lines.slice(0, firstContentIndex),
    ...lines.slice(firstContentIndex + 1),
  ];

  return {
    title: headingMatch[1]?.trim() ?? null,
    content: contentLines.join('\n').replace(/^\n+/, ''),
  };
}

function createFeishuMarkdownCardElements(
  markdown: string,
  options: { tableMode?: 'native' | 'markdown'; textTag?: 'lark_md' | 'plain_text' } = {},
): FeishuMarkdownCardV1['elements'] {
  const segments = splitFeishuMarkdownTableSegments(markdown);
  const elements: FeishuMarkdownCardV1['elements'] = [];
  const textTag = options.textTag ?? 'lark_md';

  for (const segment of segments) {
    if (segment.kind === 'markdown') {
      const content = normalizeFeishuMarkdownContent(segment.content).trim();
      for (const contentChunk of splitFeishuMarkdownContent(content)) {
        elements.push({
          tag: 'div' as const,
          text: {
            tag: textTag,
            content: contentChunk,
          },
        });
      }
      continue;
    }

    if ((options.tableMode ?? 'native') === 'native') {
      elements.push({
        tag: 'div' as const,
        text: {
          tag: textTag,
          content: segmentToMarkdownTable(segment),
        },
      });
      continue;
    }

    for (const contentChunk of splitFeishuMarkdownContent(formatMarkdownTableAsFeishuMarkdown(segment))) {
      elements.push({
        tag: 'div' as const,
        text: {
          tag: textTag,
          content: contentChunk,
        },
      });
    }
  }

  return elements.length > 0
    ? elements
    : [{
        tag: 'div' as const,
        text: {
          tag: textTag,
          content: '',
        },
      }];
}

function createFeishuPlainTextCard(markdown: string): FeishuMarkdownCardV1 {
  const { title, content } = extractFeishuCardTitle(markdown);
  return {
    config: {
      wide_screen_mode: true,
    },
    ...(title
      ? {
          header: {
            template: 'blue' as const,
            title: {
              tag: 'plain_text' as const,
              content: title,
            },
          },
        }
      : {}),
    elements: createFeishuMarkdownCardElements(content, {
      tableMode: 'markdown',
      textTag: 'plain_text',
    }),
  };
}

function createFeishuMarkdownCardV2Elements(markdown: string): FeishuMarkdownCardV2Element[] {
  const segments = splitFeishuMarkdownTableSegments(markdown);
  const elements: FeishuMarkdownCardV2Element[] = [];

  for (const segment of segments) {
    if (segment.kind === 'markdown') {
      const content = normalizeFeishuMarkdownContent(segment.content).trim();
      for (const contentChunk of splitFeishuMarkdownContent(content)) {
        elements.push({
          tag: 'markdown' as const,
          content: contentChunk,
        });
      }
      continue;
    }

    elements.push(createFeishuNativeTableElement(segment));
  }

  return elements.length > 0
    ? elements
    : [{ tag: 'markdown' as const, content: '' }];
}

type FeishuMarkdownSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'table'; headers: string[]; rows: string[][] };

function splitFeishuMarkdownTableSegments(markdown: string): FeishuMarkdownSegment[] {
  const lines = markdown.split('\n');
  const segments: FeishuMarkdownSegment[] = [];
  let currentMarkdown: string[] = [];
  let inFence = false;
  let index = 0;

  const flushMarkdown = () => {
    if (currentMarkdown.length === 0) {
      return;
    }
    segments.push({ kind: 'markdown', content: currentMarkdown.join('\n') });
    currentMarkdown = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (MARKDOWN_FENCE_OPEN_RE.test(line) || MARKDOWN_FENCE_CLOSE_RE.test(line)) {
      inFence = !inFence;
      currentMarkdown.push(line);
      index += 1;
      continue;
    }

    if (!inFence && isMarkdownTableHeaderAt(lines, index)) {
      const table = parseMarkdownTableAt(lines, index);
      if (table) {
        flushMarkdown();
        segments.push({
          kind: 'table',
          headers: table.headers,
          rows: table.rows,
        });
        index = table.nextIndex;
        continue;
      }
    }

    currentMarkdown.push(line);
    index += 1;
  }

  flushMarkdown();
  return segments;
}

function isMarkdownTableHeaderAt(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  if (!header || !separator) {
    return false;
  }
  return isMarkdownTableRow(header) && isMarkdownTableSeparator(separator);
}

function parseMarkdownTableAt(
  lines: string[],
  startIndex: number,
): { headers: string[]; rows: string[][]; nextIndex: number } | null {
  const headers = parseMarkdownTableRow(lines[startIndex] ?? '');
  if (headers.length === 0) {
    return null;
  }

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && isMarkdownTableRow(lines[index] ?? '')) {
    const row = parseMarkdownTableRow(lines[index] ?? '');
    rows.push(headers.map((_, cellIndex) => row[cellIndex] ?? ''));
    index += 1;
  }

  return rows.length > 0
    ? { headers, rows, nextIndex: index }
    : null;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && parseMarkdownTableRow(trimmed).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = withoutLeadingPipe.endsWith('|')
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;
  return withoutTrailingPipe.split('|').map(cell => cell.trim());
}

function formatMarkdownTableAsFeishuMarkdown(segment: Extract<FeishuMarkdownSegment, { kind: 'table' }>): string {
  const [primaryHeader = '项目', ...detailHeaders] = segment.headers;
  return segment.rows.map((row) => {
    const [primaryCell = '', ...detailCells] = row;
    const lines = [`**${primaryHeader}：${primaryCell || '未命名'}**`];
    detailHeaders.forEach((header, index) => {
      lines.push(`- **${header || `列 ${index + 2}`}**：${detailCells[index] ?? ''}`);
    });
    return lines.join('\n');
  }).join('\n\n');
}

function createFeishuNativeTableElement(segment: Extract<FeishuMarkdownSegment, { kind: 'table' }>): FeishuMarkdownCardV2Element {
  const columns = segment.headers.map((header, index) => ({
    name: `col_${index}`,
    display_name: header || `列 ${index + 1}`,
    data_type: 'text' as const,
    width: 'auto' as const,
  }));

  return {
    tag: 'table' as const,
    page_size: Math.max(segment.rows.length, 1),
    row_height: 'low' as const,
    columns,
    rows: segment.rows.map(row =>
      Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? '']))
    ),
  };
}

function segmentToMarkdownTable(segment: Extract<FeishuMarkdownSegment, { kind: 'table' }>): string {
  return [
    `| ${segment.headers.join(' | ')} |`,
    `| ${segment.headers.map(() => '---').join(' | ')} |`,
    ...segment.rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function hasFeishuMarkdownTable(markdown: string): boolean {
  return splitFeishuMarkdownTableSegments(markdown).some(segment => segment.kind === 'table');
}

function isFeishuTableCard(card: FeishuMarkdownCard): boolean {
  return 'schema' in card && card.body.elements.some(element => element.tag === 'table');
}

function isFeishuCardContentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Failed to create card content') || message.includes('200905');
}

function normalizeFeishuMarkdownContent(markdown: string): string {
  let inFence = false;
  return markdown.split('\n').map(line => {
    if (MARKDOWN_FENCE_OPEN_RE.test(line) || MARKDOWN_FENCE_CLOSE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    return line.replace(/^(\s*)#{2,6}\s+(.+?)\s*$/, '$1**$2**');
  }).join('\n');
}

function splitFeishuMarkdownContent(
  content: string,
  maxLength = FEISHU_CARD_MARKDOWN_ELEMENT_MAX_LENGTH,
): string[] {
  if (!content) {
    return [];
  }
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > maxLength) {
    const splitAt = findFeishuSplitPoint(remaining, maxLength);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }
  return chunks;
}

function createFeishuMarkdownPostRows(markdown: string): FeishuPostRow[] {
  if (!markdown) {
    return [[{ tag: 'md', text: '' }]];
  }
  if (!markdown.includes('```')) {
    return splitFeishuPostRowText(markdown).map(text => [{ tag: 'md' as const, text }]);
  }

  const rows: FeishuPostRow[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    const segment = current.join('\n');
    if (segment.trim()) {
      rows.push(...splitFeishuPostRowText(segment).map(text => [{ tag: 'md' as const, text }]));
    }
    current = [];
  };

  for (const rawLine of markdown.split('\n')) {
    const trimmed = rawLine.trim();
    const isFence = inCodeBlock
      ? MARKDOWN_FENCE_CLOSE_RE.test(trimmed)
      : MARKDOWN_FENCE_OPEN_RE.test(trimmed);

    if (isFence) {
      if (!inCodeBlock) {
        flushCurrent();
      }
      current.push(rawLine);
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        flushCurrent();
      }
      continue;
    }

    current.push(rawLine);
  }

  flushCurrent();
  return rows.length > 0 ? rows : [[{ tag: 'md', text: markdown }]];
}

function createFeishuPlainTextPostRows(markdown: string): FeishuRichTextPostRow[] {
  const text = stripFeishuMarkdownForPlainText(markdown);
  if (!text.trim()) {
    return [[{ tag: 'text', text: '' }]];
  }

  const rows = text
    .split('\n')
    .flatMap(line => splitFeishuPostRowText(line).map(chunk => [{ tag: 'text' as const, text: chunk }]));
  return rows.length > 0 ? rows : [[{ tag: 'text', text }]];
}

function splitFeishuPostRowText(text: string, maxLength = FEISHU_POST_ROW_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = findFeishuSplitPoint(remaining, maxLength);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.length > 0 ? chunks : [text.slice(0, maxLength)];
}

function stripFeishuMarkdownForPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

export function resolveAppSecret(
  config: FeishuAppConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.app_secret) {
    return config.app_secret;
  }
  if (config.app_secret_env) {
    return env[config.app_secret_env] || null;
  }
  return null;
}

export function parseFeishuTextContent(content: unknown): string | null {
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

export function decryptFeishuEventPayload(encryptedPayload: string, encryptKey: string): Record<string, unknown> {
  const key = createHash('sha256').update(encryptKey).digest();
  const encrypted = Buffer.from(encryptedPayload, 'base64');
  if (encrypted.length <= 16) {
    throw new Error('飞书加密事件格式无效');
  }
  const iv = encrypted.subarray(0, 16);
  const ciphertext = encrypted.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf-8');
  return JSON.parse(decrypted) as Record<string, unknown>;
}

function extractFeishuGatewayInboundIdentity(
  event: FeishuIncomingMessageEvent | undefined,
  chatId: string,
): FeishuGatewayInboundIdentity {
  const senderId = stringValue(event?.sender?.sender_id?.open_id)
    ?? stringValue(event?.sender?.sender_id?.user_id)
    ?? stringValue(event?.sender?.sender_id?.union_id);
  const chatType = normalizeFeishuChatType(event?.message?.chat_type);
  return {
    chatId,
    chatType,
    ...(senderId ? { senderId } : {}),
    ...(typeof event?.sender?.sender_type === 'string' ? { senderType: event.sender.sender_type } : {}),
    mentionOpenIds: (event?.message?.mentions ?? [])
      .map(mention => stringValue(mention.id?.open_id) ?? stringValue(mention.id?.user_id))
      .filter((value): value is string => Boolean(value)),
  };
}

function normalizeFeishuChatType(value: unknown): FeishuGatewayInboundIdentity['chatType'] {
  if (value === 'group' || value === 'chat') {
    return 'group';
  }
  if (value === 'p2p' || value === 'dm') {
    return 'dm';
  }
  return 'unknown';
}

function isFeishuSetHomeCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/sethome';
}

function writeFeishuHomeChannel(configPath: string, chatId: string): void {
  const rawConfig = existsSync(configPath)
    ? objectValue(load(readFileSync(configPath, 'utf-8')))
    : {};
  const gateway = objectValue(rawConfig.gateway);
  const platforms = objectValue(gateway.platforms);
  const feishu = objectValue(platforms.feishu);
  rawConfig.gateway = {
    ...gateway,
    enabled: gateway.enabled ?? true,
    platforms: {
      ...platforms,
      feishu: {
        ...feishu,
        home_channel: chatId,
      },
    },
  };
  writeFileSync(configPath, dump(rawConfig, { lineWidth: 120 }), 'utf-8');
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

interface FeishuResourceContent {
  fileKey: string;
  fileName?: string;
  resourceType: 'file' | 'image';
}

interface FeishuInboundPostContent {
  text: string;
  resources: FeishuResourceContent[];
}

interface FeishuPermissionResolutionCommand {
  resolution: 'approve' | 'deny';
  permissionRequestId?: string;
}

function parseFeishuPermissionResolutionCommand(text: string): FeishuPermissionResolutionCommand | null {
  const normalized = text.trim();
  if (normalized === '批准本次发布') {
    return { resolution: 'approve' };
  }
  if (normalized === '拒绝本次发布') {
    return { resolution: 'deny' };
  }
  const match = normalized.match(/^\/permission\s+(approve|deny)\s+(permission_request_[A-Za-z0-9_-]+)$/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    resolution: match[1].toLowerCase() as 'approve' | 'deny',
    permissionRequestId: match[2],
  };
}

function parseFeishuPostContent(content: unknown): FeishuInboundPostContent | null {
  if (typeof content !== 'string') {
    return null;
  }
  try {
    const parsed = objectValue(JSON.parse(content));
    const localized = Object.values(parsed)
      .map(objectValue)
      .find(value => Array.isArray(value.content));
    const post = Array.isArray(parsed.content) ? parsed : localized;
    if (!post || !Array.isArray(post.content)) {
      return null;
    }
    const textParts: string[] = [];
    const title = stringValue(post.title);
    if (title) textParts.push(title);
    const resources: FeishuResourceContent[] = [];
    for (const row of post.content) {
      if (!Array.isArray(row)) continue;
      const rowText: string[] = [];
      for (const rawElement of row) {
        const element = objectValue(rawElement);
        const tag = stringValue(element.tag);
        if (tag === 'img') {
          const imageKey = stringValue(element.image_key);
          if (imageKey) resources.push({ fileKey: imageKey, resourceType: 'image' });
          continue;
        }
        if (tag === 'text' || tag === 'a' || tag === 'code_block') {
          const elementText = stringValue(element.text);
          if (elementText) rowText.push(elementText);
          continue;
        }
        if (tag === 'at') {
          const userName = stringValue(element.user_name);
          if (userName) rowText.push(`@${userName}`);
        }
      }
      const joined = rowText.join('').trim();
      if (joined) textParts.push(joined);
    }
    return { text: textParts.join('\n').trim(), resources };
  } catch {
    return null;
  }
}

function parseFeishuResourceContent(content: unknown): FeishuResourceContent | null {
  if (typeof content !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as {
      file_key?: unknown;
      image_key?: unknown;
      file_name?: unknown;
      name?: unknown;
    };
    if (typeof parsed.file_key === 'string' && parsed.file_key.trim()) {
      return {
        fileKey: parsed.file_key.trim(),
        fileName: typeof parsed.file_name === 'string'
          ? parsed.file_name
          : typeof parsed.name === 'string'
            ? parsed.name
            : undefined,
        resourceType: 'file',
      };
    }
    if (typeof parsed.image_key === 'string' && parsed.image_key.trim()) {
      return {
        fileKey: parsed.image_key.trim(),
        fileName: typeof parsed.file_name === 'string'
          ? parsed.file_name
          : typeof parsed.name === 'string'
            ? parsed.name
            : undefined,
        resourceType: 'image',
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function handleFeishuResourceMessage(
  message: NonNullable<FeishuIncomingMessageEvent['message']>,
  input: {
    chatId: string;
    messageId: string;
    messageType: string;
    client: FeishuMessageClient;
    session: FeishuMessageSession;
    pendingResourcesByChatId?: Map<string, string[]>;
    uploadDir?: string;
  },
): Promise<boolean> {
  if (input.messageType !== 'file' && input.messageType !== 'image') {
    return false;
  }

  const resource = parseFeishuResourceContent(message.content);
  if (!resource || !input.client.downloadMessageResource) {
    input.session.appendSystemMessage('⚠️ 收到飞书文件消息，但当前客户端不支持下载消息资源');
    await input.client.sendMarkdownCardToChat(input.chatId, '收到附件消息，但当前 Gateway 无法下载该资源。')
      .catch(() => undefined);
    return true;
  }

  try {
    const downloaded = await downloadAndQueueFeishuResources([resource], input.messageId, input.chatId, input);
    await sendFeishuResourceReceipt(input.chatId, downloaded.map(item => item.fileName), input);
    return true;
  } catch (error) {
    input.session.appendSystemMessage(`⚠️ 飞书文件下载失败: ${(error as Error).message}`);
    await input.client.sendMarkdownCardToChat(input.chatId, `附件接收失败：${(error as Error).message}`)
      .catch(() => undefined);
    return true;
  }
}

async function downloadAndQueueFeishuResources(
  resources: FeishuResourceContent[],
  messageId: string,
  chatId: string,
  deps: Pick<FeishuMessageHandlerDeps, 'client' | 'session' | 'pendingResourcesByChatId' | 'uploadDir'>,
): Promise<DownloadedFeishuResource[]> {
  if (resources.length === 0) return [];
  if (!deps.client.downloadMessageResource) {
    throw new Error('当前客户端不支持下载消息资源');
  }
  const downloadedResources: DownloadedFeishuResource[] = [];
  for (const resource of resources) {
    const downloaded = await deps.client.downloadMessageResource({
      messageId,
      fileKey: resource.fileKey,
      resourceType: resource.resourceType,
      fileName: resource.fileName,
      outputDir: deps.uploadDir
        ? resolve(deps.uploadDir, sanitizePathPart(chatId), sanitizePathPart(messageId))
        : undefined,
    });
    downloadedResources.push(downloaded);
    deps.session.appendSystemMessage(`→ 已接收飞书文件: ${downloaded.fileName}`);
  }
  if (downloadedResources.length > 0) {
    const pendingResources = deps.pendingResourcesByChatId ?? new Map<string, string[]>();
    pendingResources.set(chatId, [
      ...(pendingResources.get(chatId) ?? []),
      ...downloadedResources.map(item => item.path),
    ]);
  }
  return downloadedResources;
}

async function sendFeishuResourceReceipt(
  chatId: string,
  fileNames: string[],
  deps: Pick<FeishuMessageHandlerDeps, 'client' | 'session'>,
): Promise<void> {
  const label = fileNames.length > 0 ? `附件：${fileNames.join('、')}` : '附件';
  await deps.client.sendMarkdownCardToChat(chatId, `已收到${label}。请继续发送处理说明。`)
    .catch(error => deps.session.appendSystemMessage(`⚠️ 飞书附件确认回发失败: ${(error as Error).message}`));
}

function pendingRepositoryPromotions(session: FeishuMessageSession): PlannerTuiPermissionRequest[] {
  return (session.getPlannerTuiPermissionRequests?.() ?? [])
    .filter(request => request.capability === 'repository_promotion')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

const feishuAutoApprovalTasks = new WeakMap<
  FeishuMessageSession,
  Map<string, Promise<void>>
>();

async function completeFeishuTaskWithAutoApproval(
  chatId: string,
  taskId: string,
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  let tasks = feishuAutoApprovalTasks.get(deps.session);
  if (!tasks) {
    tasks = new Map<string, Promise<void>>();
    feishuAutoApprovalTasks.set(deps.session, tasks);
  }
  const existing = tasks.get(taskId);
  if (existing) {
    return await existing;
  }

  const completion = (async () => {
    try {
      const delivery = await waitForFeishuAutoApprovedExecutorResult(deps.session, taskId, chatId, deps);
      await deliverFeishuExecutorResult(chatId, delivery, deps);
    } catch (error) {
      const message = `飞书自动发布失败：${(error as Error).message}`;
      deps.session.appendSystemMessage(`⚠️ ${message}`);
      await deps.client.sendMarkdownCardToChat(chatId, `⚠️ ${message}`);
    }
  })().finally(() => {
    if (tasks?.get(taskId) === completion) {
      tasks.delete(taskId);
    }
  });
  tasks.set(taskId, completion);
  return await completion;
}

async function waitForFeishuAutoApprovedExecutorResult(
  session: FeishuMessageSession,
  taskId: string,
  chatId: string,
  deps: FeishuMessageHandlerDeps,
  timeoutMs = FEISHU_REPLY_WAIT_TIMEOUT_MS,
): Promise<PlannerTuiExecutorResult> {
  if (!session.resolvePlannerTuiPermission
    || !session.getPlannerTuiExecutorResults
    || !session.getPlannerTuiSnapshot) {
    throw new Error('当前 Gateway session 不支持自动发布');
  }
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const request = pendingRepositoryPromotions(session)
      .find(candidate => candidate.taskId === taskId);
    if (request) {
      const resolution = await session.resolvePlannerTuiPermission(request.permissionRequestId, 'approve');
      const ok = resolution.status !== 'conflict';
      recordFeishuAudit(deps, {
        kind: 'permission',
        chatId,
        requestId: request.permissionRequestId,
        method: 'local',
        ok,
        reason: ok ? 'repository_promotion_auto_approved' : resolution.message,
      });
      if (!ok && pendingRepositoryPromotions(session)
        .some(candidate => candidate.permissionRequestId === request.permissionRequestId)) {
        throw new Error(resolution.message);
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
      continue;
    }

    const task = session.getPlannerTuiSnapshot().taskPool.find(candidate => candidate.id === taskId);
    if (task?.status === 'done') {
      const result = session.getPlannerTuiExecutorResults()
        .filter(candidate => candidate.taskId === taskId)
        .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
      if (result) {
        return result;
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }

  throw new Error(`任务 #${taskId} 在 ${timeoutMs}ms 内未完成自动发布`);
}

function formatFeishuPermissionPrompt(request: PlannerTuiPermissionRequest): string {
  const changedPaths = request.changedPaths?.length
    ? request.changedPaths.map(path => `- ${path}`)
    : ['- 暂无可展示的路径'];
  const artifactPreviews = formatFeishuCandidateArtifactPreviews(request.candidateArtifacts ?? []);
  return [
    `⚠️ 发布授权请求：任务 #${request.taskId} 已完成执行，等待一次性发布授权。`,
    `即将把“${request.subtaskTitle}”产生的更改合入当前项目。`,
    '',
    '**结果预览**',
    request.candidateReport?.trim() || 'Executor 未提供结果摘要。',
    '',
    '**待发布文件**',
    ...changedPaths,
    ...artifactPreviews,
    '',
    '批准请只回复：批准本次发布',
    '拒绝请只回复：拒绝本次发布',
  ].join('\n');
}

function formatFeishuCandidateArtifactPreviews(artifactPaths: string[]): string[] {
  const previews: string[] = [];
  for (const artifactPath of artifactPaths.slice(0, 3)) {
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) continue;
    const size = statSync(artifactPath).size;
    if (size > 64 * 1024) {
      previews.push('', `**${basename(artifactPath)} 预览**`, `文件较大（${size} bytes），批准并合并后将发送原文件。`);
      continue;
    }
    const content = readFileSync(artifactPath);
    if (content.includes(0)) {
      previews.push('', `**${basename(artifactPath)} 预览**`, `二进制文件（${size} bytes），批准并合并后将发送原文件。`);
      continue;
    }
    const text = content.toString('utf-8').trim();
    previews.push(
      '',
      `**${basename(artifactPath)} 预览**`,
      text ? `\n\`\`\`\n${text.slice(0, 2_000)}\n\`\`\`` : '（空文件）',
    );
  }
  return previews;
}

async function handleFeishuPermissionResolutionCommand(
  command: FeishuPermissionResolutionCommand,
  chatId: string,
  deps: FeishuMessageHandlerDeps,
): Promise<boolean> {
  const requests = pendingRepositoryPromotions(deps.session);
  const request = command.permissionRequestId
    ? requests.find(candidate => candidate.permissionRequestId === command.permissionRequestId)
    : requests[0];
  if (!request) {
    await deps.client.sendMarkdownCardToChat(chatId, '当前会话没有匹配的待发布授权请求。');
    return true;
  }
  if (!deps.session.resolvePlannerTuiPermission) {
    await deps.client.sendMarkdownCardToChat(chatId, '当前 Gateway 不支持处理发布授权。');
    return true;
  }

  const result = await deps.session.resolvePlannerTuiPermission(request.permissionRequestId, command.resolution);
  if (result.status === 'conflict') {
    await deps.client.sendMarkdownCardToChat(chatId, `发布授权未生效：${result.message}`);
    return true;
  }
  if (command.resolution === 'deny') {
    await deps.client.sendMarkdownCardToChat(chatId, `已拒绝任务 #${request.taskId} 的本次发布。`);
    return true;
  }

  await deps.client.sendMarkdownCardToChat(chatId, `已批准任务 #${request.taskId} 的本次发布，正在完成合并与交付。`);
  try {
    const delivery = await waitForFeishuExecutorResult(deps.session, request.taskId);
    await deliverFeishuExecutorResult(chatId, delivery, deps);
  } catch (error) {
    const message = `发布后的结果交付失败：${(error as Error).message}`;
    deps.session.appendSystemMessage(`⚠️ ${message}`);
    recordFeishuAudit(deps, {
      kind: 'final',
      chatId,
      method: 'notice',
      ok: false,
      error: (error as Error).message,
    });
    await deps.client.sendMarkdownCardToChat(chatId, `⚠️ ${message}`);
  }
  return true;
}

async function handleFeishuRedeliverLatestResult(
  chatId: string,
  deps: FeishuMessageHandlerDeps,
): Promise<boolean> {
  const latest = deps.session.getPlannerTuiExecutorResults?.()
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  if (!latest) {
    await deps.client.sendMarkdownCardToChat(chatId, '当前会话没有可重发的已集成结果。');
    return true;
  }
  await deliverFeishuExecutorResult(chatId, latest, deps);
  return true;
}

async function deliverFeishuExecutorResult(
  chatId: string,
  delivery: PlannerTuiExecutorResult,
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  await sendFeishuFinalReplyChunks(chatId, splitForFeishu([
    `任务 #${delivery.taskId} 已完成合并与交付。`,
    '',
    delivery.report,
  ].join('\n')), deps);
  await sendArtifactPathsToFeishu(chatId, delivery.artifacts, deps);
}

async function waitForFeishuExecutorResult(
  session: FeishuMessageSession,
  taskId: string,
  timeoutMs = FEISHU_REPLY_WAIT_TIMEOUT_MS,
): Promise<PlannerTuiExecutorResult> {
  if (!session.getPlannerTuiExecutorResults) {
    throw new Error('当前 Gateway session 不支持读取已集成结果');
  }
  const findResult = () => session.getPlannerTuiExecutorResults?.()
    .filter(result => result.taskId === taskId)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  const findReapproval = () => pendingRepositoryPromotions(session)
    .find(request => request.taskId === taskId);
  const existing = findResult();
  if (existing) return existing;

  return await new Promise<PlannerTuiExecutorResult>((resolveResult, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const interval = setInterval(() => {
      const result = findResult();
      if (result) finish(result);
      else {
        const reapproval = findReapproval();
        if (reapproval) fail(new Error(
          `项目主分支在首次批准后发生变化；候选结果已同步并保留，请重新回复“批准本次发布”（新请求 ${reapproval.permissionRequestId}）`,
        ));
      }
    }, 250);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      unsubscribe?.();
      reject(new Error(`任务 #${taskId} 在 ${timeoutMs}ms 内未完成发布`));
    }, timeoutMs);
    const finish = (result: PlannerTuiExecutorResult) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      unsubscribe?.();
      resolveResult(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      unsubscribe?.();
      reject(error);
    };
    unsubscribe = session.subscribe?.(() => {
      const result = findResult();
      if (result) finish(result);
      else {
        const reapproval = findReapproval();
        if (reapproval) fail(new Error(
          `项目主分支在首次批准后发生变化；候选结果已同步并保留，请重新回复“批准本次发布”（新请求 ${reapproval.permissionRequestId}）`,
        ));
      }
    });
  });
}

function appendPendingFeishuResourcesToText(
  text: string,
  chatId: string,
  pendingResourcesByChatId?: Map<string, string[]>,
): string {
  const pendingResources = pendingResourcesByChatId?.get(chatId) ?? [];
  if (pendingResources.length === 0) {
    return text;
  }

  return [
    text,
    '',
    '关联飞书上传文件：',
    ...pendingResources.map(resourcePath => `"${resourcePath}"`),
  ].join('\n');
}

function hasReplayablePlannerFailure(outputLines: string[]): boolean {
  return outputLines.some(line => line.includes('规划提案传输状态不确定；请重放同一请求'));
}

export function formatFeishuReply(outputLines: string[]): string {
  const executorFinalResults = extractExecutorFinalResults(outputLines);
  if (executorFinalResults) {
    return executorFinalResults;
  }

  const appendedResultOutput = extractAppendedTaskResultOutput(outputLines);
  if (appendedResultOutput && !containsInternalExecutorContext(appendedResultOutput)) {
    return appendedResultOutput;
  }

  const executorAnswer = extractLatestExecutorAnswer(outputLines);
  if (executorAnswer) {
    return executorAnswer;
  }

  const hasInternalExecutorContext = hasInternalExecutorContextInTaskOutput(outputLines);
  if (hasInternalExecutorContext) {
    return extractLatestTaskSummary(outputLines) ?? '';
  }

  return outputLines
    .map(cleanFeishuReplyLine)
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .trim();
}

function parseExecutorFinalResultBlock(line: string): { taskId: string; body: string | null } | null {
  const match = line.match(/^【Executor: [^｜]+｜最终结果｜#([^ ]+) \/ #[^】]+】(?:\r?\n([\s\S]+))?$/);
  if (!match?.[1]) {
    return null;
  }
  return {
    taskId: match[1],
    body: match[2]?.trim() || null,
  };
}

function extractExecutorFinalResults(outputLines: string[]): string | null {
  let latestUserTurnIndex = -1;
  for (let index = outputLines.length - 1; index >= 0; index -= 1) {
    if (outputLines[index]?.startsWith('> ')) {
      latestUserTurnIndex = index;
      break;
    }
  }
  const scopedLines = outputLines.slice(latestUserTurnIndex + 1);
  const results = scopedLines.flatMap((line) => {
    const body = parseExecutorFinalResultBlock(line)?.body;
    return body ? [body] : [];
  });
  return results.length > 0 ? results.join('\n\n') : null;
}

function extractFeishuReplyTargetTaskId(outputLines: string[]): string | null {
  for (const rawLine of outputLines) {
    const line = rawLine.trim();
    const permissionPrompt = line.match(/^⚠️ 发布授权请求：任务 #(task_[^\s]+) /);
    if (permissionPrompt) {
      return permissionPrompt[1] ?? null;
    }
    const created = line.match(/^任务\s+#(task_[^\s]+)\s+已创建：/)?.[1];
    if (created) {
      return created;
    }

    const referenced = line.match(/^→\s+(?:关联到任务|命中上次任务指针)\s+#(task_[^\s]+)/)?.[1];
    if (referenced) {
      return referenced;
    }

    const queued = line.match(/^→\s+任务\s+#(task_[^\s]+)\s+已进入待执行队列/)?.[1];
    if (queued) {
      return queued;
    }
  }

  return null;
}

function filterFeishuOutputLinesForTask(outputLines: string[], taskId: string): string[] {
  const filtered: string[] = [];
  let currentCompletionTaskId: string | null = null;
  let includeCurrentCompletion = false;
  let inResultBlock = false;
  let requestScopeActive = false;

  for (const rawLine of outputLines) {
    const line = rawLine.trim();
    const permissionPrompt = line.match(/^⚠️ 发布授权请求：任务 #(task_[^\s]+) /);
    if (permissionPrompt) {
      if (permissionPrompt[1] === taskId) filtered.push(rawLine);
      continue;
    }
    const createdMatch = line.match(/^任务\s+#(task_[^\s]+)\s+已创建：/);
    if (createdMatch) {
      if (createdMatch[1] === taskId) {
        requestScopeActive = true;
        filtered.push(rawLine);
      } else {
        requestScopeActive = false;
      }
      continue;
    }

    const referencedMatch = line.match(/^→\s+(?:关联到任务|命中上次任务指针)\s+#(task_[^\s]+)/);
    if (referencedMatch) {
      requestScopeActive = referencedMatch[1] === taskId;
      if (requestScopeActive) {
        filtered.push(rawLine);
      }
      continue;
    }

    const executorFinalResult = parseExecutorFinalResultBlock(line);
    if (executorFinalResult) {
      currentCompletionTaskId = executorFinalResult.taskId;
      includeCurrentCompletion = currentCompletionTaskId === taskId;
      if (includeCurrentCompletion) {
        filtered.push(rawLine);
      }
      continue;
    }

    const taskOutputLine = parseFeishuTaskOutputLine(line);
    if (taskOutputLine) {
      currentCompletionTaskId = taskOutputLine.taskId;
      includeCurrentCompletion = currentCompletionTaskId === taskId;
      if (includeCurrentCompletion) {
        filtered.push(rawLine);
      }
      continue;
    }

    const executingMatch = line.match(/^→\s+正在执行任务\s+#(task_[^\s]+)[.。]{3}$/)
      ?? line.match(/^→\s+Executor:\s+.+?\s+开始执行任务\s+#(task_[^\s]+)$/);
    if (executingMatch) {
      currentCompletionTaskId = executingMatch[1] ?? null;
      includeCurrentCompletion = currentCompletionTaskId === taskId;
      if (includeCurrentCompletion) {
        filtered.push(rawLine);
      }
      continue;
    }

    const routedTaskLine = line.match(/^→\s+任务\s+#(task_[^\s]+)\s+已进入待执行队列$/);
    if (routedTaskLine) {
      if (routedTaskLine[1] === taskId) {
        requestScopeActive = true;
        filtered.push(rawLine);
      }
      continue;
    }

    if (requestScopeActive && (
      normalizeFeishuProgressContextStep(line)
      || /^→\s+派发给\s+[^.。]+[.。]{3}$/.test(line)
      || line.startsWith('→ 路由决策：')
      || line.startsWith('→ 原因：')
      || line.startsWith('→ MetaClaw：')
      || line.startsWith('→ Executor: ')
      || line.startsWith('→ 抢占当前任务')
      || line.startsWith('→ 已自动关联')
      || isTaskBlockedAfterFailureLine(line)
    )) {
      filtered.push(rawLine);
      continue;
    }

    if (line.startsWith('┌─ 任务结果')) {
      inResultBlock = includeCurrentCompletion;
      if (includeCurrentCompletion) {
        filtered.push(rawLine);
      }
      continue;
    }

    if (inResultBlock) {
      filtered.push(rawLine);
      if (line.startsWith('└')) {
        inResultBlock = false;
      }
      continue;
    }

    if (includeCurrentCompletion && (
      /^✓\s+任务完成/.test(line)
      || isExecutorFailureLine(line)
      || line === ''
      || line.startsWith('→ 文件输出目录:')
      || line.startsWith('→ 已省略文件正文输出')
      || /^→\s+已记录\s+\d+\s+个任务产物/.test(line)
      || line.startsWith('- ')
      || line.startsWith('   - ')
      || (!line.startsWith('> ') && !line.startsWith('任务 #') && !line.startsWith('→ 任务 #'))
    )) {
      filtered.push(rawLine);
    }
  }

  return filtered.length > 0 ? filtered : outputLines;
}

export function appendMarkdownPreviewLinks(
  reply: string,
  outputLines: string[],
  preview?: FeishuMessageHandlerDeps['markdownPreview'],
): string {
  if (!reply.trim() || !preview) {
    return reply;
  }

  const links = createMarkdownPreviewLinks(extractMarkdownArtifactPaths(outputLines), {
    baseUrl: preview.baseUrl,
    workspaceRoot: preview.workspaceRoot,
  });
  if (links.length === 0) {
    return reply;
  }

  return [
    reply.trimEnd(),
    '',
    '**Markdown 在线预览**',
    ...links.map(link => `- [${link.title}](${link.url})`),
  ].join('\n');
}

function sanitizeFeishuFinalReply(reply: string, outputLines: string[]): string {
  if (!reply.trim() || !containsInternalExecutorContext(reply) && !containsFeishuInternalReplyNoise(reply)) {
    return reply;
  }

  return extractLatestTaskSummary(outputLines) || reply;
}

function containsFeishuInternalReplyNoise(reply: string): boolean {
  return reply.split(/\r?\n/).some(line =>
    /^\[[a-z0-9_-]+\]\s+/i.test(line.trim())
    || /\[codex-cli\]/i.test(line)
    || /\/bin\/bash\b/.test(line)
    || /succeeded in \d+ms/i.test(line)
    || /\/home\/[^ \t]+/.test(line)
  );
}

export function extractMarkdownArtifactPaths(outputLines: string[]): string[] {
  return extractArtifactPaths(outputLines).filter(path => /\.(md|markdown)$/i.test(path));
}

export function extractArtifactPaths(outputLines: string[]): string[] {
  const paths: string[] = [];
  let collecting = false;

  for (const rawLine of outputLines) {
    const line = rawLine.trim();
    if (/^→\s+已记录\s+\d+\s+个任务产物/.test(line)) {
      collecting = true;
      continue;
    }

    if (!collecting) {
      continue;
    }

    if (!line || line.startsWith('┌') || line.startsWith('→ ') || line.startsWith('✓ ')) {
      collecting = false;
      continue;
    }

    const artifactPath = line.match(/^-\s+(.+)$/)?.[1]?.trim()
      ?? line.match(/^\s*-\s+(.+)$/)?.[1]?.trim();
    if (artifactPath) {
      paths.push(artifactPath);
    }
  }

  return Array.from(new Set(paths));
}

async function sendArtifactFilesToFeishu(
  chatId: string,
  outputLines: string[],
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  const artifactPaths = extractArtifactPaths(outputLines)
    .filter(path => existsSync(path) && statSync(path).isFile());
  await sendArtifactPathsToFeishu(chatId, artifactPaths, deps);
}

async function sendArtifactPathsToFeishu(
  chatId: string,
  paths: string[],
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  const artifactPaths = Array.from(new Set(paths))
    .filter(path => existsSync(path) && statSync(path).isFile());
  if (artifactPaths.length === 0) {
    return;
  }
  if (!deps.client.uploadFile || !deps.client.sendFileToChat) {
    deps.session.appendSystemMessage('⚠️ 飞书任务产物同步跳过: 当前客户端不支持文件上传');
    return;
  }

  await deps.client.sendMarkdownCardToChat(chatId, [
    '**任务产物已同步到飞书**',
    ...artifactPaths.map(path => `- ${basename(path)}`),
  ].join('\n'));
  recordFeishuAudit(deps, {
    kind: 'artifact',
    chatId,
    method: 'notice',
    ok: true,
  });

  for (const artifactPath of artifactPaths) {
    try {
      const fileKey = await deps.client.uploadFile(artifactPath);
      await deps.client.sendFileToChat(chatId, fileKey);
      recordFeishuAudit(deps, {
        kind: 'artifact',
        chatId,
        method: 'file',
        ok: true,
      });
    } catch (error) {
      deps.session.appendSystemMessage(`⚠️ 飞书任务产物同步失败: ${artifactPath}: ${(error as Error).message}`);
      recordFeishuAudit(deps, {
        kind: 'artifact',
        chatId,
        method: 'file',
        ok: false,
        error: (error as Error).message,
      });
      await deps.client.sendMarkdownCardToChat(chatId, `⚠️ 任务产物同步失败：${basename(artifactPath)}`);
    }
  }
}

async function sendFeishuFinalReplyChunks(
  chatId: string,
  chunks: string[],
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  const failedChunks: Array<{ index: number; errors: string[] }> = [];

  for (const [index, chunk] of chunks.entries()) {
    let sent = false;
    const errors: string[] = [];

    try {
      await deps.client.sendMarkdownCardToChat(chatId, chunk);
      sent = true;
      recordFeishuAudit(deps, {
        kind: 'final',
        chatId,
        chunkIndex: index,
        chunkCount: chunks.length,
        method: 'card',
        ok: true,
      });
    } catch (error) {
      errors.push(`消息卡: ${(error as Error).message}`);
      recordFeishuAudit(deps, {
        kind: 'final',
        chatId,
        chunkIndex: index,
        chunkCount: chunks.length,
        method: 'card',
        ok: false,
        error: (error as Error).message,
      });
      deps.session.appendSystemMessage(`⚠️ 飞书 Markdown 消息卡分片 ${index + 1}/${chunks.length} 回发失败，改用富文本: ${(error as Error).message}`);
    }

    if (sent) {
      continue;
    }

    if (deps.client.sendMarkdownPostToChat) {
      try {
        await deps.client.sendMarkdownPostToChat(chatId, chunk);
        sent = true;
        recordFeishuAudit(deps, {
          kind: 'final',
          chatId,
          chunkIndex: index,
          chunkCount: chunks.length,
          method: 'post',
          ok: true,
        });
      } catch (error) {
        errors.push(`富文本: ${(error as Error).message}`);
        recordFeishuAudit(deps, {
          kind: 'final',
          chatId,
          chunkIndex: index,
          chunkCount: chunks.length,
          method: 'post',
          ok: false,
          error: (error as Error).message,
        });
        deps.session.appendSystemMessage(`⚠️ 飞书富文本分片 ${index + 1}/${chunks.length} 回发失败: ${(error as Error).message}`);
      }
    } else {
      errors.push('富文本: 当前客户端不支持富文本发送');
    }

    if (!sent) {
      failedChunks.push({ index, errors });
    }
  }

  if (failedChunks.length > 0) {
    await sendFeishuCompleteReplyFallback(chatId, chunks.join(''), failedChunks, deps);
  }
}

async function sendFeishuCompleteReplyFallback(
  chatId: string,
  fullReply: string,
  failedChunks: Array<{ index: number; errors: string[] }>,
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  const failedLabels = failedChunks.map(chunk => `第 ${chunk.index + 1} 段`).join('、');
  const warning = `⚠️ 飞书部分回复分片未能直接送达（${failedLabels}）。下面将同步完整答案文件，避免内容缺失。`;
  try {
    await deps.client.sendMarkdownCardToChat(chatId, warning);
    recordFeishuAudit(deps, {
      kind: 'fallback',
      chatId,
      method: 'notice',
      ok: true,
    });
  } catch (error) {
    recordFeishuAudit(deps, {
      kind: 'fallback',
      chatId,
      method: 'notice',
      ok: false,
      error: (error as Error).message,
    });
    deps.session.appendSystemMessage(`⚠️ 飞书完整答案兜底提示发送失败: ${(error as Error).message}`);
  }

  if (!deps.client.uploadFile || !deps.client.sendFileToChat) {
    deps.session.appendSystemMessage('⚠️ 飞书完整答案文件兜底失败: 当前客户端不支持文件上传');
    return;
  }

  try {
    const outputDir = resolve(resolveMetaclawDir(), 'feishu-replies');
    mkdirSync(outputDir, { recursive: true });
    const filePath = resolve(outputDir, `metaclaw-reply-${Date.now()}.md`);
    writeFileSync(filePath, fullReply.trimEnd() + '\n', 'utf-8');
    const fileKey = await deps.client.uploadFile(filePath);
    await deps.client.sendFileToChat(chatId, fileKey);
    recordFeishuAudit(deps, {
      kind: 'fallback',
      chatId,
      method: 'file',
      ok: true,
    });
  } catch (error) {
    recordFeishuAudit(deps, {
      kind: 'fallback',
      chatId,
      method: 'file',
      ok: false,
      error: (error as Error).message,
    });
    deps.session.appendSystemMessage(`⚠️ 飞书完整答案文件兜底失败: ${(error as Error).message}`);
  }
}

function recordFeishuAudit(
  deps: FeishuMessageHandlerDeps,
  event: FeishuDeliveryAuditEvent,
): void {
  try {
    deps.audit?.record(event);
  } catch (error) {
    deps.session.appendSystemMessage(`⚠️ 飞书投递审计写入失败: ${(error as Error).message}`);
  }
}

function formatFeishuPendingReply(outputLines: string[]): string {
  const queuedLine = outputLines
    .map(line => line.trim())
    .find(line => /^→\s*任务\s+#task_[^\s]+\s+已进入待执行队列$/.test(line));
  if (!queuedLine) {
    return '';
  }

  const taskId = queuedLine.match(/#task_[^\s]+/)?.[0];
  return taskId
    ? `任务 ${taskId} 已进入待执行队列，等待当前任务完成后会继续执行。`
    : '任务已进入待执行队列，等待当前任务完成后会继续执行。';
}

async function waitForFeishuReplyOutputLines(
  session: FeishuMessageSession,
  before: number,
  submitPromise: Promise<{ exitRequested: boolean }>,
  timeoutMs = FEISHU_REPLY_WAIT_TIMEOUT_MS,
  initialTargetTaskId: string | null = null,
): Promise<string[]> {
  if (!session.subscribe) {
    await submitPromise;
    return session.getSnapshot().output.slice(before);
  }

  let targetTaskId: string | null = initialTargetTaskId;
  let lastLines = session.getSnapshot().output.slice(before);
  let resolved = false;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | null = null;
  let settleTimer: NodeJS.Timeout | null = null;
  let submitSettled = false;

  return await new Promise<string[]>(resolve => {
    const finish = (lines: string[]) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      unsubscribe?.();
      resolve(lines);
    };

    const finishAfterTerminalSettle = () => {
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        if (!submitSettled) {
          return;
        }
        const scopedLines = targetTaskId
          ? filterFeishuOutputLinesForTask(lastLines, targetTaskId)
          : lastLines;
        finish(scopedLines);
      }, FEISHU_REPLY_TERMINAL_SETTLE_MS);
    };

    const inspect = (lines: string[]) => {
      lastLines = lines;
      targetTaskId = targetTaskId ?? extractFeishuReplyTargetTaskId(lines);
      const scopedLines = targetTaskId
        ? filterFeishuOutputLinesForTask(lines, targetTaskId)
        : lines;
      const permissionRequest = pendingRepositoryPromotions(session)
        .find(request => !targetTaskId || request.taskId === targetTaskId);
      if (permissionRequest) {
        finish([...scopedLines, formatFeishuPermissionPrompt(permissionRequest)]);
        return;
      }
      if (isFeishuPendingTerminal(scopedLines)) {
        if (submitSettled) {
          finish(scopedLines);
        }
        return;
      }
      if (isFeishuExecutionTerminal(scopedLines)) {
        finishAfterTerminalSettle();
      }
    };

    unsubscribe = session.subscribe?.(snapshot => {
      inspect(snapshot.output.slice(before));
    });

    void submitPromise
      .then(() => {
        submitSettled = true;
        inspect(session.getSnapshot().output.slice(before));
        if (!resolved && !targetTaskId) {
          finishAfterTerminalSettle();
        }
      })
      .catch(() => {
        submitSettled = true;
        finish(session.getSnapshot().output.slice(before));
      });

    timer = setTimeout(() => {
      const scopedLines = targetTaskId
        ? filterFeishuOutputLinesForTask(lastLines, targetTaskId)
        : lastLines;
      finish(scopedLines);
    }, timeoutMs);
  });
}

function isFeishuExecutionTerminal(outputLines: string[]): boolean {
  return outputLines.some(line => /^✓\s+任务完成/.test(line.trim()))
    || outputLines.some(line => /^✗\s+执行/.test(line.trim()));
}

function isFeishuPendingTerminal(outputLines: string[]): boolean {
  return Boolean(formatFeishuPendingReply(outputLines));
}

function cleanFeishuReplyLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed.startsWith('> ') ||
    trimmed.startsWith('任务 #') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('【') ||
    trimmed.startsWith('→ ') ||
    trimmed.startsWith('✓ ') ||
    trimmed.startsWith('┌') ||
    trimmed.startsWith('└') ||
    trimmed.startsWith('│ 下一步:')
  ) {
    return null;
  }

  const taskOutput = parseFeishuTaskOutputLine(trimmed);
  if (taskOutput) {
    const normalizedTaskOutput = stripExecutorLogPrefix(taskOutput.text);
    if (
      /^\d[\d,]*$/.test(normalizedTaskOutput) ||
      normalizedTaskOutput === 'tokens used' ||
      normalizedTaskOutput.includes('执行器') ||
      normalizedTaskOutput.includes('关联历史') ||
      isInternalExecutorContextLine(normalizedTaskOutput)
    ) {
      return null;
    }
    return normalizedTaskOutput;
  }

  return trimmed;
}

export function formatFeishuProgressReply(outputLines: string[]): string {
  return extractFeishuProgressSummary(outputLines);
}

export function formatFeishuStreamingProgressReplies(
  outputLines: string[],
  sentSteps = new Set<string>(),
): string[] {
  const replies: string[] = [];
  for (const block of extractFeishuGuidanceProgressBlocks(outputLines)) {
    if (sentSteps.has(block)) {
      continue;
    }
    sentSteps.add(block);
    replies.push(block);
  }

  const newSteps: string[] = [];
  for (const rawLine of outputLines) {
    const step = extractFeishuProgressStep(rawLine);
    if (!step || sentSteps.has(step)) {
      continue;
    }
    sentSteps.add(step);
    newSteps.push(step);
  }
  if (newSteps.length > 0) {
    replies.push(['**处理步骤**', ...newSteps].join('\n'));
  }
  return replies;
}

function mergeFeishuProgressOutputs(outputs: string[]): string {
  const guidanceBlocks = outputs.filter(output => !output.startsWith('**处理步骤**'));
  const steps: string[] = [];
  const seen = new Set<string>();

  for (const output of outputs) {
    if (!output.startsWith('**处理步骤**')) {
      continue;
    }
    for (const line of output.split('\n').slice(1)) {
      const step = line.trim();
      if (!step || seen.has(step)) {
        continue;
      }
      seen.add(step);
      steps.push(step);
    }
  }

  return [
    ...guidanceBlocks,
    steps.length > 0 ? ['**处理步骤**', ...steps].join('\n') : null,
  ].filter((line): line is string => Boolean(line)).join('\n\n');
}

function extractFeishuGuidanceProgressBlocks(outputLines: string[]): string[] {
  const blocks: string[] = [];
  let collecting: string[] | null = null;

  for (const rawLine of outputLines) {
    const line = rawLine.trim();
    if (isFeishuProgressBlockStart(line)) {
      collecting = [line];
      continue;
    }
    if (!collecting) {
      continue;
    }
    if (line.startsWith('└')) {
      const block = formatFeishuGuidanceProgressBlock(collecting);
      if (block) {
        blocks.push(block);
      }
      collecting = null;
      continue;
    }
    collecting.push(line);
  }

  return blocks;
}

function extractFeishuGuidanceProgressLines(outputLines: string[]): string[] {
  const lines: string[] = [];
  let collecting = false;

  for (const rawLine of outputLines) {
    const line = rawLine.trim();
    if (isFeishuProgressBlockStart(line)) {
      collecting = true;
      lines.push(rawLine);
      continue;
    }
    if (!collecting) {
      continue;
    }
    lines.push(rawLine);
    if (line.startsWith('└')) {
      collecting = false;
    }
  }

  return lines;
}

function isFeishuProgressBlockStart(line: string): boolean {
  return line.startsWith('┌─ 操作指引')
    || line.startsWith('┌─ 已自动采用记忆')
    || line.startsWith('┌─ 已跳过不确定记忆')
    || line.startsWith('┌─ 任务队列前五');
}

function formatFeishuGuidanceProgressBlock(lines: string[]): string | null {
  const title = lines[0] ?? '';
  if (title.startsWith('┌─ 任务队列前五')) {
    return formatFeishuTaskQueueBlock(lines);
  }

  if (title.startsWith('┌─ 已自动采用记忆')) {
    return formatFeishuMemoryDecisionBlock('记忆召回自动采用', lines);
  }

  if (title.startsWith('┌─ 已跳过不确定记忆')) {
    return formatFeishuMemoryDecisionBlock('记忆召回已跳过', lines);
  }

  const scene = lines.find(line => line.startsWith('│ 场景：'))?.replace(/^│\s*场景：/, '').trim();
  if (scene !== '恢复已挂起任务' && scene !== '解除阻塞后恢复') {
    return null;
  }

  const action = lines.find(line => line.startsWith('│ 推荐动作：'))?.replace(/^│\s*推荐动作：/, '').trim();
  const task = lines.find(line => line.startsWith('│ 目标任务：'))?.replace(/^│\s*目标任务：/, '').trim();
  const reasons = lines
    .filter(line => line.startsWith('│ 原因：') || line.startsWith('│       '))
    .map(line => line.replace(/^│\s*(?:原因：)?\s*/, '').trim())
    .filter(Boolean);

  return [
    `**${scene}**`,
    action ? `→ ${action}` : null,
    task ? `任务：${task}` : null,
    ...reasons.map(reason => `- ${reason}`),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatFeishuTaskQueueBlock(lines: string[]): string | null {
  const trigger = lines.find(line => line.startsWith('│ 触发：'))?.replace(/^│\s*触发：/, '').trim();
  const summary = lines.find(line => line.startsWith('│ 总览：'))?.replace(/^│\s*总览：/, '').trim();
  const entries = lines
    .filter(line => /^│\s*\d+\.\s+/.test(line))
    .map(line => line.replace(/^│\s*/, '').trim());

  return [
    '**任务队列前五**',
    trigger ? `触发：${trigger}` : null,
    summary ? `总览：${summary}` : null,
    ...entries.map(entry => `- ${entry}`),
  ].filter((line): line is string => Boolean(line)).join('\n') || null;
}

function formatFeishuMemoryDecisionBlock(title: string, lines: string[]): string | null {
  const task = lines.find(line => line.startsWith('│ 当前任务：'))?.replace(/^│\s*当前任务：/, '').trim();
  const strategy = lines.find(line => line.startsWith('│ 策略：'))?.replace(/^│\s*策略：/, '').trim();
  const skipped = lines.find(line => line.startsWith('│ 跳过：'))?.replace(/^│\s*跳过：/, '').trim();
  const adoptedItems = lines
    .filter(line => /^│\s*-\s+/.test(line))
    .map(line => line.replace(/^│\s*-\s*/, '').trim());
  const reasons = lines
    .filter(line => line.startsWith('│   reason='))
    .map(line => line.replace(/^│\s*reason=/, '').trim());

  return [
    `**${title}**`,
    task ? `任务：${task}` : null,
    strategy ? `- ${strategy}` : null,
    skipped ? `- 跳过：${skipped}` : null,
    ...adoptedItems.map(item => `- ${item}`),
    ...reasons.map(reason => `  原因：${reason}`),
  ].filter((line): line is string => Boolean(line)).join('\n') || null;
}

function extractFeishuProgressSummary(outputLines: string[]): string {
  const steps: string[] = [];
  const seen = new Set<string>();
  const addStep = (step: string) => {
    if (!seen.has(step)) {
      seen.add(step);
      steps.push(step);
    }
  };

  for (const block of extractFeishuGuidanceProgressBlocks(outputLines)) {
    addStep(block);
  }

  for (const rawLine of outputLines) {
    const step = extractFeishuProgressStep(rawLine);
    if (step) {
      addStep(step);
    }
  }

  return steps.length > 0
    ? ['**处理步骤**', ...steps].join('\n')
    : '';
}

function extractFeishuProgressStep(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }

  const taskCreated = line.match(/^任务\s+(#task_[^\s]+)\s+已创建：(.+)$/);
  if (taskCreated) {
    return `→ 任务 ${taskCreated[1]} 已创建：${taskCreated[2]}`;
  }

  const contextStep = normalizeFeishuProgressContextStep(line);
  if (contextStep) {
    return contextStep;
  }

  if (/^→\s+派发给\s+[^.。]+[.。]{3}$/.test(line)) {
    const parserExecutor = line.match(/^→\s+派发给\s+([^.。]+)[.。]{3}$/)?.[1]?.trim();
    return parserExecutor
      ? `→ 发送给 ${parserExecutor} 进行意图解析与执行准备`
      : '→ 进入意图解析与执行准备阶段';
  }

  if (line.startsWith('→ MetaClaw：') || line.startsWith('→ Executor: ')) {
    return line;
  }

  if (line.startsWith('→ 路由决策：')) {
    return line;
  }

  if (line.startsWith('→ 原因：')) {
    return line;
  }

  if (/^→\s+正在执行任务\s+#task_[^\s]+[.。]{3}$/.test(line)) {
    return line;
  }

  const taskOutputLine = parseFeishuTaskOutputLine(line);
  const executorStarted = taskOutputLine?.text.match(/^已启动\s+(.+?)\s+执行器$/);
  if (executorStarted) {
    if (taskOutputLine?.executorName) {
      return `→ Executor: ${taskOutputLine.executorName} 已启动执行器`;
    }
    return `→ 已启动 ${executorStarted[1]} 执行器`;
  }

  if (/^✓\s+任务完成/.test(line)) {
    return line;
  }

  if (isExecutorFailureLine(line)) {
    return line;
  }

  if (isTaskBlockedAfterFailureLine(line)) {
    return line;
  }

  return null;
}

function isExecutorFailureLine(line: string): boolean {
  return /^✗\s+执行(?:失败|异常|未完成)\s*:/.test(line);
}

function isTaskBlockedAfterFailureLine(line: string): boolean {
  return /^→\s+任务\s+#task_[^\s]+\s+已转为阻塞/.test(line);
}

function normalizeFeishuProgressContextStep(line: string): string | null {
  const normalized = line.replace(/^\[/, '【').replace(/\]$/, '】');
  if (
    normalized === '【提取最近历史记录上下文】'
    || normalized === '【构建执行上下文】'
    || normalized === '【执行上下文准备完成】'
    || normalized === '【MetaClaw｜理解用户请求】'
    || normalized === '【MetaClaw｜召回会话上下文】'
    || normalized === '【MetaClaw｜提取最近历史记录上下文】'
    || normalized === '【MetaClaw｜构建执行上下文】'
    || normalized === '【MetaClaw｜执行上下文准备完成】'
    || /^【Executor:\s*.+｜.+】$/.test(normalized)
  ) {
    return normalized;
  }
  return null;
}

interface FeishuTaskOutputLine {
  taskId: string;
  text: string;
  executorName?: string;
}

function parseFeishuTaskOutputLine(line: string): FeishuTaskOutputLine | null {
  const normalized = line.trim();
  const executorProtocol = normalized.match(/^[+·•]\s+Executor:\s*([^｜|]+?)\s*[｜|]\s*#?(task_[^｜|\s]+)\s*[｜|]\s?(.*)$/);
  if (executorProtocol) {
    return {
      executorName: executorProtocol[1]?.trim(),
      taskId: executorProtocol[2],
      text: executorProtocol[3] ?? '',
    };
  }

  return null;
}

function extractLatestExecutorAnswer(outputLines: string[]): string | null {
  const answerLines: string[] = [];
  let activeTaskId: string | null = null;
  let collecting = false;
  let skippingHistory = false;
  let sawAnswerAfterUsage = false;

  for (const rawLine of outputLines) {
    const trimmed = rawLine.trim();
    const taskLine = parseFeishuTaskOutputLine(trimmed);
    if (!taskLine) {
      if (collecting && (trimmed.startsWith('✓ ') || trimmed.startsWith('┌─ 任务结果'))) {
        break;
      }
      continue;
    }

    const taskId = taskLine.taskId;
    const taskOutput = taskLine.text.trimEnd();
    if (!activeTaskId || isExecutorStartLine(taskOutput)) {
      activeTaskId = taskId;
      answerLines.length = 0;
      collecting = true;
      skippingHistory = false;
      sawAnswerAfterUsage = false;
      if (isExecutorStartLine(taskOutput)) {
        continue;
      }
    }
    if (taskId !== activeTaskId || !collecting) {
      continue;
    }

    if (isHistoryStartLine(taskOutput)) {
      skippingHistory = true;
      continue;
    }
    if (skippingHistory) {
      if (taskOutput.trim() === 'tokens used') {
        skippingHistory = false;
      } else {
        continue;
      }
    }

    const cleaned = cleanExecutorAnswerLine(taskOutput);
    if (cleaned !== null) {
      if (sawAnswerAfterUsage) {
        answerLines.length = 0;
        sawAnswerAfterUsage = false;
      }
      answerLines.push(cleaned);
    } else if (taskOutput.trim() === 'tokens used') {
      sawAnswerAfterUsage = true;
    }
  }

  const answer = trimBlankLines(answerLines).join('\n').trim();
  const taskResultBody = extractLatestTaskResultBody(outputLines);
  const taskSummary = extractLatestTaskSummary(outputLines);
  if (answer && containsInternalExecutorContext(answer)) {
    return taskResultBody || taskSummary;
  }
  if (taskResultBody && (!answer || answer === taskSummary || taskResultBody.includes(answer))) {
    return taskResultBody;
  }
  if (answer && !taskSummary) {
    return answer;
  }
  if (answer && taskSummary && !containsOnlyExecutionHistory(answer, taskSummary)) {
    return answer;
  }
  if (taskSummary) {
    return taskSummary;
  }
  return null;
}

function containsOnlyExecutionHistory(answer: string, taskSummary: string): boolean {
  const normalizedSummary = taskSummary.replace(/^\s*│\s*摘要:\s*/, '').split('\n')[0]?.trim() ?? '';
  if (!normalizedSummary) {
    return false;
  }
  if (answer.includes(normalizedSummary)) {
    return false;
  }
  const summaryPrefix = normalizedSummary.replace(/\.\.\.$/, '').trim();
  return !summaryPrefix || !answer.startsWith(summaryPrefix);
}

function isExecutorStartLine(line: string): boolean {
  return line.includes('已启动') && line.includes('执行器');
}

function isHistoryStartLine(line: string): boolean {
  return line.trim().startsWith('关联历史');
}

function cleanExecutorAnswerLine(line: string): string | null {
  if (!line.trim()) {
    return '';
  }
  const trimmed = line.trim();
  const normalized = stripExecutorLogPrefix(trimmed);

  if (
    /^\d[\d,]*$/.test(normalized) ||
    normalized === 'tokens used' ||
    normalized.includes('关联历史') ||
    isInternalExecutorContextLine(normalized) ||
    /^(thinking|reasoning|analyzing|chain of thought)/i.test(normalized) ||
    normalized === '执行器正在分析问题'
  ) {
    return null;
  }

  return normalized;
}

function containsInternalExecutorContext(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some(line => isInternalExecutorContextLine(line.trim()));
}

function hasInternalExecutorContextInTaskOutput(outputLines: string[]): boolean {
  return outputLines.some((rawLine) => {
    const trimmed = rawLine.trim();
    const taskOutput = parseFeishuTaskOutputLine(trimmed);
    return isInternalExecutorContextLine(taskOutput?.text.trim() ?? trimmed);
  });
}

function isInternalExecutorContextLine(line: string): boolean {
  const normalized = stripExecutorLogPrefix(line);
  if (!normalized) {
    return false;
  }

  return /^相关偏好\s*[:：]/.test(normalized)
    || /^工作目录\s*[:：]/.test(normalized)
    || /^文件输出目标\s*[:：]/.test(normalized)
    || /^任务目录\s*[:：]/.test(normalized)
    || /^会话近期上下文\s*[:：]/.test(normalized)
    || /^关联飞书上传文件\s*[:：]/.test(normalized)
    || /^\[[a-z0-9_-]+\]\s+/i.test(normalized)
    || /^"\/home\/[^"]+"$/.test(normalized)
    || /^'\/home\/[^']+'$/.test(normalized)
    || /^相似历史参考\b/.test(normalized)
    || /Reference Context Pack\b/i.test(normalized)
    || /^Minimal Reference Cards\b/i.test(normalized)
    || /^\[?任务#task_[^\s\]]+\]?/.test(normalized)
    || /^用户(?:意图)?\s*[:：]/.test(normalized)
    || /^助手\s*[:：]/.test(normalized)
    || /^相关性原因\s*[:：]/.test(normalized)
    || /^可复用内容\s*[:：]/.test(normalized)
    || /^边界声明\s*[:：]/.test(normalized)
    || /^输出处理\s*[:：]/.test(normalized)
    || /^已找到原任务本地\s+Markdown\b/.test(normalized)
    || /作为本次任务产物放入目标目录/.test(normalized)
    || /^参考来源\s*[:：]/.test(normalized)
    || /^必须把结果写入本地文件系统/.test(normalized)
    || /^所有本次任务生成的文件/.test(normalized)
    || /^目标目录\s*[:：]/.test(normalized)
    || /^如果目标目录不存在/.test(normalized)
    || /^请按用户意图判断/.test(normalized)
    || /^exec$/i.test(normalized)
    || /^codex$/i.test(normalized)
    || /^\/bin\/bash\b/.test(normalized)
    || /^succeeded in \d+ms:?$/i.test(normalized)
    || /^drwx/.test(normalized)
    || /^-rw/.test(normalized)
    || /^\d+\s+\/home\/[^ \t]+/.test(normalized)
    || /^\/home\/[^ \t]+/.test(normalized)
    || / in \/home\/[^ \t]+$/.test(normalized)
    || /^(ls|cat|cp|mkdir|touch|sed|awk|grep|find)\s+/.test(normalized);
}

function stripExecutorLogPrefix(line: string): string {
  return line.trim().replace(/^\[[^\]]+\]\s*/, '').trim();
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function extractLatestTaskResultBody(outputLines: string[]): string | null {
  let resultIndex = -1;
  for (let index = outputLines.length - 1; index >= 0; index -= 1) {
    if (outputLines[index]?.trim().startsWith('┌─ 任务结果')) {
      resultIndex = index;
      break;
    }
  }
  if (resultIndex === -1) {
    return null;
  }

  const answerLines: string[] = [];
  let activeTaskId: string | null = null;
  let collecting = false;
  let skippingHistory = false;
  let sawUsageMarker = false;
  for (let index = 0; index < resultIndex; index += 1) {
    const trimmed = outputLines[index]?.trim() ?? '';
    const taskLine = parseFeishuTaskOutputLine(trimmed);
    if (!taskLine) {
      if (!trimmed) {
        if (collecting && !skippingHistory && answerLines.length > 0) {
          answerLines.push('');
        }
        continue;
      }
      if (/^✓\s+任务完成/.test(trimmed)) {
        continue;
      }
      if (collecting && !skippingHistory) {
        const cleaned = cleanExecutorAnswerLine(outputLines[index]);
        if (cleaned !== null) {
          if (sawUsageMarker) {
            answerLines.length = 0;
            sawUsageMarker = false;
          }
          answerLines.push(cleaned);
        } else if (trimmed === 'tokens used') {
          sawUsageMarker = true;
        }
      }
      continue;
    }

    const taskId = taskLine.taskId;
    const taskOutput = taskLine.text.trimEnd();
    if (!activeTaskId || isExecutorStartLine(taskOutput)) {
      activeTaskId = taskId;
      answerLines.length = 0;
      collecting = true;
      skippingHistory = false;
      sawUsageMarker = false;
      if (isExecutorStartLine(taskOutput)) {
        continue;
      }
    }
    if (taskId !== activeTaskId || !collecting) {
      continue;
    }

    if (isHistoryStartLine(taskOutput)) {
      skippingHistory = true;
      continue;
    }
    if (skippingHistory) {
      if (taskOutput.trim() === 'tokens used') {
        skippingHistory = false;
        sawUsageMarker = true;
      }
      continue;
    }
    if (taskOutput.trim() === 'tokens used') {
      sawUsageMarker = true;
      continue;
    }
    if (/^\d[\d,]*$/.test(taskOutput.trim())) {
      continue;
    }

    const cleaned = cleanExecutorAnswerLine(taskOutput);
    if (cleaned !== null) {
      if (sawUsageMarker) {
        answerLines.length = 0;
        sawUsageMarker = false;
      }
      answerLines.push(cleaned);
    }
  }

  const body = trimBlankLines(answerLines).join('\n').trim();
  if (!body || containsInternalExecutorContext(body)) {
    return null;
  }
  return body;
}

function extractAppendedTaskResultOutput(outputLines: string[]): string | null {
  let resultBlockEnd = -1;
  let inTaskResultBlock = false;
  for (let index = 0; index < outputLines.length; index += 1) {
    const line = outputLines[index]?.trim() ?? '';
    if (line.startsWith('┌─ 任务结果')) {
      inTaskResultBlock = true;
      continue;
    }
    if (inTaskResultBlock && line.startsWith('└')) {
      resultBlockEnd = index;
      inTaskResultBlock = false;
    }
  }
  if (resultBlockEnd === -1) {
    return null;
  }

  const answerLines: string[] = [];
  for (let index = resultBlockEnd + 1; index < outputLines.length; index += 1) {
    const rawLine = outputLines[index] ?? '';
    const trimmed = rawLine.trim();
    if (!trimmed && answerLines.length === 0) {
      continue;
    }
    if (
      trimmed.startsWith('┌─ 操作指引')
      || trimmed.startsWith('┌─ 任务队列前五')
      || /^→\s+文件输出目录:/.test(trimmed)
      || /^→\s+已省略文件正文输出/.test(trimmed)
      || /^→\s+已记录\s+\d+\s+个任务产物/.test(trimmed)
    ) {
      break;
    }

    const cleaned = cleanFeishuReplyLine(rawLine);
    if (cleaned !== null) {
      answerLines.push(cleaned);
    }
  }

  const answer = trimBlankLines(answerLines).join('\n').trim();
  return answer || null;
}

function extractLatestTaskSummary(outputLines: string[]): string | null {
  let summaryStart = -1;
  for (let index = outputLines.length - 1; index >= 0; index -= 1) {
    if (/^│\s*摘要:\s*/.test(outputLines[index]?.trim() ?? '')) {
      summaryStart = index;
      break;
    }
  }
  if (summaryStart === -1) {
    return null;
  }

  const summaryLines: string[] = [];
  for (let index = summaryStart; index < outputLines.length; index += 1) {
    const trimmed = outputLines[index]?.trim() ?? '';
    if (!trimmed) {
      summaryLines.push('');
      continue;
    }
    if (index > summaryStart && (trimmed.startsWith('│ 下一步:') || trimmed.startsWith('└'))) {
      break;
    }

    if (index === summaryStart) {
      summaryLines.push(trimmed.replace(/^│\s*摘要:\s*/, '').trim());
      continue;
    }

    summaryLines.push(trimmed.replace(/^│\s?/, '').trimEnd());
  }

  const summary = summaryLines.join('\n').trim();
  return summary && summary !== '无' ? summary : null;
}

function splitForFeishu(text: string, maxLength = FEISHU_REPLY_MESSAGE_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = findFeishuSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function findFeishuSplitPoint(text: string, maxLength: number): number {
  const hardLimit = Math.min(maxLength, text.length);
  const minimumUsefulSplit = Math.floor(hardLimit * 0.45);
  const preferredPatterns = [
    /\n\s*\n/g,
    /\n/g,
    /[。！？；;]\s*/g,
    /[，、：:]\s*/g,
    /\s+/g,
  ];

  for (const pattern of preferredPatterns) {
    const splitAt = findLastPatternSplitPoint(text, pattern, hardLimit);
    if (splitAt > minimumUsefulSplit) {
      return splitAt;
    }
  }
  return hardLimit;
}

function findLastPatternSplitPoint(text: string, pattern: RegExp, hardLimit: number): number {
  let splitAt = -1;
  const window = text.slice(0, hardLimit);
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    splitAt = match.index + match[0].length;
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  return splitAt;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf-8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function defaultPostJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return response;
}

async function defaultPostForm(
  url: string,
  form: FormData,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
  });

  return response;
}

async function defaultGetBinary(
  url: string,
  headers: Record<string, string> = {},
): Promise<BinaryResponse> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  return response;
}

async function defaultDeleteJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'DELETE',
    headers,
  });

  return response;
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  return cleaned || 'feishu-upload';
}

function sanitizePathPart(value: string): string {
  return sanitizeFileName(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function extractFilenameFromContentDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }

  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const plain = contentDisposition.match(/filename="?([^";]+)"?/i)?.[1];
  return plain ?? null;
}
