import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import {
  appendMarkdownPreviewLinks,
  createFeishuMarkdownCard,
  createFeishuMarkdownPostContent,
  createFeishuPlainTextPostContent,
  createFeishuBridge,
  decryptFeishuEventPayload,
  FeishuEventBridge,
  createFeishuWebSocketEventHandlers,
  extractArtifactPaths,
  extractMarkdownArtifactPaths,
  FeishuAppClient,
  formatFeishuProgressReply,
  formatFeishuStreamingProgressReplies,
  formatFeishuReply,
  handleFeishuMessageEvent,
  parseFeishuTextContent,
  resolveAppSecret,
} from '../../src/integrations/feishu-app.js';

afterEach(() => {
  vi.useRealTimers();
});

function encryptFeishuTestPayload(payload: Record<string, unknown>, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload), 'utf-8'),
    cipher.final(),
  ]).toString('base64');
}

describe('FeishuAppClient', () => {
  it('fetches tenant access token, sends Markdown cards, and manages reactions', async () => {
    const postJson = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { reaction_id: 'reaction_typing' } }),
        text: async () => 'ok',
      });
    const deleteJson = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0 }),
      text: async () => 'ok',
    });
    const client = new FeishuAppClient({ app_id: 'cli_test', app_secret: 'secret' }, { postJson, deleteJson });

    await client.sendMarkdownCardToChat('oc_chat', '### hello from metaclaw');
    await expect(client.addReactionToMessage('om_message', 'Typing')).resolves.toBe('reaction_typing');
    await client.removeReactionFromMessage('om_message', 'reaction_typing');

    expect(postJson).toHaveBeenNthCalledWith(
      1,
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: 'cli_test', app_secret: 'secret' },
    );
    expect(postJson).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        receive_id: 'oc_chat',
        msg_type: 'interactive',
        content: JSON.stringify(createFeishuMarkdownCard('### hello from metaclaw')),
      },
      { authorization: 'Bearer tenant-token' },
    );
    expect(postJson).toHaveBeenNthCalledWith(
      3,
      'https://open.feishu.cn/open-apis/im/v1/messages/om_message/reactions',
      {
        reaction_type: {
          emoji_type: 'Typing',
        },
      },
      { authorization: 'Bearer tenant-token' },
    );
    expect(deleteJson).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_message/reactions/reaction_typing',
      { authorization: 'Bearer tenant-token' },
    );
  });

  it('downloads user-uploaded Feishu message resources to local files', async () => {
    const outputDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-download-'));
    const postJson = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }),
      text: async () => 'ok',
    });
    const getBinary = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name.toLowerCase() === 'content-disposition'
          ? 'attachment; filename="report.txt"'
          : null,
      },
      arrayBuffer: async () => new TextEncoder().encode('uploaded content').buffer,
      text: async () => 'uploaded content',
    });
    const client = new FeishuAppClient({ app_id: 'cli_test', app_secret: 'secret' }, { postJson, getBinary });

    const downloaded = await client.downloadMessageResource({
      messageId: 'om_message',
      fileKey: 'file_key_uploaded',
      resourceType: 'file',
      outputDir,
    });

    expect(getBinary).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_message/resources/file_key_uploaded?type=file',
      {
        authorization: 'Bearer tenant-token',
        'content-type': 'application/json; charset=utf-8',
      },
    );
    expect(downloaded.fileName).toBe('report.txt');
    expect(existsSync(downloaded.path)).toBe(true);
    expect(readFileSync(downloaded.path, 'utf-8')).toBe('uploaded content');
  });

  it('falls back to a plain text card when Feishu rejects Markdown card content', async () => {
    const postJson = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 200905, msg: 'Failed to create card content' }),
        text: async () => 'bad card',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => 'ok',
      });
    const client = new FeishuAppClient({ app_id: 'cli_test', app_secret: 'secret' }, { postJson });

    await client.sendMarkdownCardToChat('oc_chat', [
      'MetaClaw 桌面端的特殊定位应该是：',
      '',
      '**MetaClaw Desktop Runtime**',
      '',
      '后续建议：优先做后台常驻运行时、任务面板、授权面板。',
    ].join('\n'));

    expect(postJson).toHaveBeenCalledTimes(3);
    const fallbackBody = postJson.mock.calls[2]?.[1] as { content: string };
    const fallbackCard = JSON.parse(fallbackBody.content) as ReturnType<typeof createFeishuMarkdownCard>;
    expect('elements' in fallbackCard ? fallbackCard.elements[0]?.text.tag : null).toBe('plain_text');
    expect(fallbackBody.content).toContain('MetaClaw Desktop Runtime');
    expect(fallbackBody.content).toContain('后续建议');
  });

  it('sends final answers as Feishu post messages instead of interactive cards', async () => {
    const postJson = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => 'ok',
      });
    const client = new FeishuAppClient({ app_id: 'cli_test', app_secret: 'secret' }, { postJson });
    const answer = [
      '可以分成三层来看。',
      '',
      '**第一层：飞书式知识管理**',
      '飞书做的是信息管理。',
      '',
      '**第二层：Ontology / 业务对象建模**',
      'Ontology 系统回答的是业务世界现在是什么状态。',
      '',
      '**第三层：决策与行动**',
      '真正有价值的是知识进入业务决策。',
    ].join('\n');

    await client.sendMarkdownPostToChat('oc_chat', answer);

    expect(postJson).toHaveBeenCalledTimes(2);
    const body = postJson.mock.calls[1]?.[1] as { msg_type: string; content: string };
    expect(body.msg_type).toBe('post');
    expect(body.content).toContain('第一层：飞书式知识管理');
    expect(body.content).toContain('第二层：Ontology / 业务对象建模');
    expect(body.content).toContain('第三层：决策与行动');
    expect(body.content).not.toContain('interactive');
  });
});

describe('Feishu app helpers', () => {
  it('parses text message content payloads', () => {
    expect(parseFeishuTextContent('{"text":"hi metaclaw"}')).toBe('hi metaclaw');
  });

  it('decrypts Feishu encrypted webhook payloads', () => {
    const payload = { event: { message: { message_id: 'om_encrypted' } } };
    const encrypted = encryptFeishuTestPayload(payload, 'encrypt-secret');

    expect(decryptFeishuEventPayload(encrypted, 'encrypt-secret')).toEqual(payload);
  });

  it('builds Feishu post markdown content with isolated fenced code blocks', () => {
    expect(createFeishuMarkdownPostContent([
      '说明',
      '```ts',
      'const ok = true;',
      '```',
      '结论',
    ].join('\n'))).toEqual({
      zh_cn: {
        content: [
          [{ tag: 'md', text: '说明' }],
          [{ tag: 'md', text: '```ts\nconst ok = true;\n```' }],
          [{ tag: 'md', text: '结论' }],
        ],
      },
    });
  });

  it('splits long Feishu post rows so rich text nodes do not get truncated', () => {
    const longLine = [
      '如果把 MetaClaw 做成桌面端，我建议它不要定位成 AI 桌面助手，',
      '而要定位成企业 AI Agent 工作台。'.repeat(80),
    ].join('');
    const markdownPost = createFeishuMarkdownPostContent(longLine);
    const plainTextPost = createFeishuPlainTextPostContent(`**${longLine}**`);

    const markdownRows = markdownPost.zh_cn.content.map(row => row[0]?.text ?? '');
    const plainTextRows = plainTextPost.zh_cn.content.map(row => row[0]?.text ?? '');

    expect(markdownRows.length).toBeGreaterThan(1);
    expect(markdownRows.every(row => row.length <= 900)).toBe(true);
    expect(markdownRows.join('')).toBe(longLine);
    expect(plainTextRows.length).toBeGreaterThan(1);
    expect(plainTextRows.every(row => row.length <= 900)).toBe(true);
    expect(plainTextRows.join('')).toBe(longLine);
  });

  it('sends long final answers as bounded Feishu post rows', async () => {
    const answer = [
      '如果把 MetaClaw 做成桌面端，我建议它不要定位成 AI 桌面助手。',
      '企业本地执行器负责把云端 Agent 的计划变成端侧可执行动作。'.repeat(90),
    ].join('\n');
    const postJson = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }),
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => 'ok',
      });
    const client = new FeishuAppClient({ app_id: 'cli_test', app_secret: 'secret' }, { postJson });

    await client.sendMarkdownPostToChat('oc_chat', answer);

    const body = postJson.mock.calls[1]?.[1] as { content: string };
    const content = JSON.parse(body.content) as ReturnType<typeof createFeishuPlainTextPostContent>;
    const rows = content.zh_cn.content.map(row => row[0]?.text ?? '');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every(row => row.length <= 900)).toBe(true);
    expect(rows.join('\n').replace(/\n/g, '')).toBe(answer.replace(/\n/g, ''));
  });

  it('builds Feishu card markdown with the first h1 promoted to the card header', () => {
    expect(createFeishuMarkdownCard([
      '# 关于启动 OPC 试点的公告',
      '',
      'OPC 不是一个人单打独斗，而是 **一个人对一个业务闭环负责**。',
    ].join('\n'))).toEqual({
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: '关于启动 OPC 试点的公告',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: 'OPC 不是一个人单打独斗，而是 **一个人对一个业务闭环负责**。',
          },
        },
      ],
    });
  });

  it('keeps structured Feishu card markdown in one element to avoid card truncation', () => {
    expect(createFeishuMarkdownCard([
      '元聚变作为平台，不能保证每一个 OPC 必然成功，但要用机制保证 **OPC 不是孤军创业，而是在平台确定性中创业**。',
      '',
      '核心做法是：',
      '',
      '1. **给方向**：平台提供明确业务场景、客户需求、产品边界，不让 OPC 从零盲目找机会。',
      '2. **给资源**：提供品牌、客户、数据、算力、AI 工具、交付体系、财务法务等基础设施。',
      '3. **给机制**：用 30 天验证、90 天收入、180 天规模化节奏推进。',
    ].join('\n')).elements).toEqual([
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '元聚变作为平台，不能保证每一个 OPC 必然成功，但要用机制保证 **OPC 不是孤军创业，而是在平台确定性中创业**。',
            '',
            '核心做法是：',
            '',
            '1. **给方向**：平台提供明确业务场景、客户需求、产品边界，不让 OPC 从零盲目找机会。',
            '2. **给资源**：提供品牌、客户、数据、算力、AI 工具、交付体系、财务法务等基础设施。',
            '3. **给机制**：用 30 天验证、90 天收入、180 天规模化节奏推进。',
          ].join('\n'),
        },
      },
    ]);
  });

  it('normalizes headings in long Markdown outlines without splitting into many card elements', () => {
    const card = createFeishuMarkdownCard([
      '你说得对。如果只是“招募 OPC、提供资源、辅导创业、对接资本”，那和外面的 OPC 孵化平台没有本质区别。',
      '元聚变的方案应该改成：不是做一个 OPC 孵化平台，而是把元聚变自身改造成 AI 时代的 OPC 母体组织。',
      '## 一、定位不同：不是孵化别人，而是重构自己',
      '其他 OPC 平台的逻辑是：',
      '> 我有平台，你来创业，我给你资源。',
      '所以重点不是“孵化”，而是：',
      '- AI 产品经理',
      '- AI 研发助手',
      '### 1. AI 技术底座',
      '由 CTO 牵头，建设统一的 AI 工具链、智能体框架、模型调用、知识库、自动化流程。',
    ].join('\n'));

    expect(card.elements).toHaveLength(1);
    expect(card.elements[0]?.text.content).toBe([
      '你说得对。如果只是“招募 OPC、提供资源、辅导创业、对接资本”，那和外面的 OPC 孵化平台没有本质区别。',
      '元聚变的方案应该改成：不是做一个 OPC 孵化平台，而是把元聚变自身改造成 AI 时代的 OPC 母体组织。',
      '**一、定位不同：不是孵化别人，而是重构自己**',
      '其他 OPC 平台的逻辑是：',
      '> 我有平台，你来创业，我给你资源。',
      '所以重点不是“孵化”，而是：',
      '- AI 产品经理',
      '- AI 研发助手',
      '**1. AI 技术底座**',
      '由 CTO 牵头，建设统一的 AI 工具链、智能体框架、模型调用、知识库、自动化流程。',
    ].join('\n'));
  });

  it('splits long card Markdown into bounded elements so Feishu clients do not truncate the answer', () => {
    const longSections = Array.from({ length: 9 }, (_, index) => [
      `${index + 1}. **检查项 ${index + 1}**：飞书 CLI 只是调用飞书开放平台 API 的本地工具，能访问什么取决于应用权限、OAuth 授权、机器人可见范围和具体 API 能力。`,
      `   这一段用于模拟 Terminal 里完整展示、但飞书客户端容易在单个卡片元素里截断的中文长答案。`,
    ].join('\n')).join('\n\n');
    const card = createFeishuMarkdownCard([
      '飞书 CLI 能读取哪些内容，需要分几层看：',
      '',
      longSections,
      '',
      '**所以结论是：**',
      '文档：可以比较顺畅地做到读取和分析。',
      '聊天信息：也可以，但限制和风险更高。',
      '我建议的安全做法是：按最小权限授权，并把访问范围限定在当前任务需要的资源。',
    ].join('\n'));

    const contents = card.elements.map(element => element.text.content);
    expect(contents.length).toBeGreaterThan(1);
    expect(contents.every(content => content.length <= 900)).toBe(true);
    expect(contents.join('\n')).toContain('所以结论是');
    expect(contents.join('\n')).toContain('我建议的安全做法是');
  });

  it('renders GitHub-style Markdown tables as structured Feishu-safe Markdown blocks', () => {
    const card = createFeishuMarkdownCard([
      '下面是对比：',
      '',
      '| 维度 | Metaclaw，也就是我 | DeepSeek-TUI |',
      '|---|---|---|',
      '| 核心定位 | 多任务调度与上下文治理层 | 终端原生 coding agent |',
      '| 强项 | 管任务、管上下文、管历史、管偏好、管执行边界 | 直接在终端读写文件、跑命令、改代码、用 Git |',
      '| 使用场景 | 长任务、跨会话任务、带状态的复杂协作 | 本地开发、代码修改、终端交互 |',
      '',
      '结论：两者定位不同。',
    ].join('\n'));

    expect(card).toEqual({
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '下面是对比：',
          },
          {
            tag: 'table',
            page_size: 3,
            row_height: 'low',
            columns: [
              {
                name: 'col_0',
                display_name: '维度',
                data_type: 'text',
                width: 'auto',
              },
              {
                name: 'col_1',
                display_name: 'Metaclaw，也就是我',
                data_type: 'text',
                width: 'auto',
              },
              {
                name: 'col_2',
                display_name: 'DeepSeek-TUI',
                data_type: 'text',
                width: 'auto',
              },
            ],
            rows: [
              {
                col_0: '核心定位',
                col_1: '多任务调度与上下文治理层',
                col_2: '终端原生 coding agent',
              },
              {
                col_0: '强项',
                col_1: '管任务、管上下文、管历史、管偏好、管执行边界',
                col_2: '直接在终端读写文件、跑命令、改代码、用 Git',
              },
              {
                col_0: '使用场景',
                col_1: '长任务、跨会话任务、带状态的复杂协作',
                col_2: '本地开发、代码修改、终端交互',
              },
            ],
          },
          {
            tag: 'markdown',
            content: '结论：两者定位不同。',
          },
        ],
      },
    });
  });

  it('can render Markdown tables as Feishu-safe Markdown fallback blocks', () => {
    const card = createFeishuMarkdownCard([
      '下面是对比：',
      '',
      '| 维度 | Metaclaw，也就是我 | DeepSeek-TUI |',
      '|---|---|---|',
      '| 核心定位 | 多任务调度与上下文治理层 | 终端原生 coding agent |',
      '| 强项 | 管任务、管上下文、管历史、管偏好、管执行边界 | 直接在终端读写文件、跑命令、改代码、用 Git |',
      '',
      '结论：两者定位不同。',
    ].join('\n'), { tableMode: 'markdown' });

    expect(card).toEqual({
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '下面是对比：',
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: [
              '**维度：核心定位**',
              '- **Metaclaw，也就是我**：多任务调度与上下文治理层',
              '- **DeepSeek-TUI**：终端原生 coding agent',
              '',
              '**维度：强项**',
              '- **Metaclaw，也就是我**：管任务、管上下文、管历史、管偏好、管执行边界',
              '- **DeepSeek-TUI**：直接在终端读写文件、跑命令、改代码、用 Git',
            ].join('\n'),
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '结论：两者定位不同。',
          },
        },
      ],
    });
  });

  it('resolves app secret from env when configured', () => {
    process.env.TEST_FEISHU_SECRET = 'from-env';
    expect(resolveAppSecret({
      enabled: true,
      app_id: 'cli_test',
      app_secret_env: 'TEST_FEISHU_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    })).toBe('from-env');
  });

  it('reports the missing app secret env var name when Feishu bridge is enabled', () => {
    const previousSecret = process.env.TEST_FEISHU_MISSING_SECRET;
    delete process.env.TEST_FEISHU_MISSING_SECRET;

    expect(() => createFeishuBridge({
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
            app_id: 'cli_test',
            app_secret_env: 'TEST_FEISHU_MISSING_SECRET',
          },
        },
      },
    }, {} as never)).toThrow('环境变量 TEST_FEISHU_MISSING_SECRET 未设置');

    if (previousSecret === undefined) {
      delete process.env.TEST_FEISHU_MISSING_SECRET;
    } else {
      process.env.TEST_FEISHU_MISSING_SECRET = previousSecret;
    }
  });

  it('creates Feishu bridge from canonical Gateway config after migration', () => {
    const previousSecret = process.env.GATEWAY_FEISHU_SECRET;
    process.env.GATEWAY_FEISHU_SECRET = 'secret';

    try {
      const bridge = createFeishuBridge({
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
              app_id: 'cli_gateway',
              app_secret_env: 'GATEWAY_FEISHU_SECRET',
              event_port: 8787,
              event_path: '/feishu/events',
            },
          },
        },
      }, {} as never);

      expect(bridge).not.toBeNull();
      expect(bridge?.constructor.name).toBe('FeishuWebSocketBridge');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.GATEWAY_FEISHU_SECRET;
      } else {
        process.env.GATEWAY_FEISHU_SECRET = previousSecret;
      }
    }
  });

  it('registers no-op event handlers to avoid SDK missing-handler warnings', async () => {
    const session = {
      getSnapshot: vi.fn().mockReturnValue({ output: [] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const handlers = createFeishuWebSocketEventHandlers({
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(handlers['im.message.message_read_v1']).toBeTypeOf('function');
    expect(handlers['im.message.reaction.created_v1']).toBeTypeOf('function');
    expect(handlers['im.message.reaction.deleted_v1']).toBeTypeOf('function');
    expect(handlers['im.message.message_read_v1']?.({})).toBeUndefined();
    expect(handlers['im.message.reaction.created_v1']?.({})).toBeUndefined();
    expect(handlers['im.message.reaction.deleted_v1']?.({})).toBeUndefined();
    expect(session.submit).not.toHaveBeenCalled();
  });

  it('handles Feishu webhook events through the HTTP bridge', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'webhook reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new FeishuEventBridge({
      client,
      session: session as never,
      config: {
        enabled: true,
        mode: 'webhook',
        app_id: 'cli_test',
        app_secret: 'secret',
        event_port: 0,
        event_path: '/feishu/events',
        verification_token: 'token',
      },
    });

    await bridge.start();
    const address = (bridge as any).server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/feishu/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          header: {
            event_type: 'im.message.receive_v1',
            token: 'token',
          },
          event: {
            message: {
              message_id: 'om_webhook',
              chat_id: 'oc_chat',
              chat_type: 'p2p',
              message_type: 'text',
              content: '{"text":"from webhook"}',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 0 });
      expect(session.submit).toHaveBeenCalledWith('from webhook', { awaitAsyncWork: true });
      expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'webhook reply');
    } finally {
      await bridge.stop();
    }
  });

  it('handles encrypted Feishu webhook events through the HTTP bridge', async () => {
    const previousEncryptKey = process.env.TEST_FEISHU_ENCRYPT_KEY;
    process.env.TEST_FEISHU_ENCRYPT_KEY = 'encrypt-secret';
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'encrypted reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new FeishuEventBridge({
      client,
      session: session as never,
      config: {
        enabled: true,
        mode: 'webhook',
        app_id: 'cli_test',
        app_secret: 'secret',
        event_port: 0,
        event_path: '/feishu/events',
        verification_token: 'token',
        encrypt_key_env: 'TEST_FEISHU_ENCRYPT_KEY',
      },
    });

    await bridge.start();
    const address = (bridge as any).server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/feishu/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          encrypt: encryptFeishuTestPayload({
            header: {
              event_type: 'im.message.receive_v1',
              token: 'token',
            },
            event: {
              message: {
                message_id: 'om_encrypted_webhook',
                chat_id: 'oc_chat',
                chat_type: 'p2p',
                message_type: 'text',
                content: '{"text":"encrypted webhook"}',
              },
            },
          }, 'encrypt-secret'),
        }),
      });

      expect(response.status).toBe(200);
      expect(session.submit).toHaveBeenCalledWith('encrypted webhook', { awaitAsyncWork: true });
      expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'encrypted reply');
    } finally {
      await bridge.stop();
      if (previousEncryptKey === undefined) {
        delete process.env.TEST_FEISHU_ENCRYPT_KEY;
      } else {
        process.env.TEST_FEISHU_ENCRYPT_KEY = previousEncryptKey;
      }
    }
  });

  it('updates Gateway Feishu home channel through webhook /sethome command', async () => {
    const metaclawDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-home-'));
    const configPath = resolve(metaclawDir, 'config.yaml');
    writeFileSync(configPath, [
      'gateway:',
      '  enabled: true',
      '  platforms:',
      '    feishu:',
      '      enabled: true',
      '      app_id: cli_home',
      '',
    ].join('\n'));
    const session = {
      getSnapshot: vi.fn().mockReturnValue({ output: [] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new FeishuEventBridge({
      client,
      session: session as never,
      config: {
        enabled: true,
        mode: 'webhook',
        app_id: 'cli_test',
        app_secret: 'secret',
        event_port: 0,
        event_path: '/feishu/events',
        verification_token: 'token',
      },
      gatewayConfig: {
        configPath,
        accessPolicy: {
          dmPolicy: 'allow_all',
          allowedUsers: [],
          groupPolicy: 'open',
          requireMention: true,
        },
      },
    });

    await bridge.start();
    const address = (bridge as any).server.address();
    try {
      await fetch(`http://127.0.0.1:${address.port}/feishu/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          header: {
            event_type: 'im.message.receive_v1',
            token: 'token',
          },
          event: {
            sender: {
              sender_id: { open_id: 'ou_user' },
            },
            message: {
              message_id: 'om_sethome_webhook',
              chat_id: 'oc_home',
              chat_type: 'p2p',
              message_type: 'text',
              content: '{"text":"/sethome"}',
            },
          },
        }),
      });

      expect(readFileSync(configPath, 'utf-8')).toContain('home_channel: oc_home');
      expect(session.submit).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
    }
  });

  it('submits websocket message events to Metaclaw and replies to the source chat', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'metaclaw reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"hello metaclaw"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.addReactionToMessage).toHaveBeenCalledWith('om_message', 'Typing');
    expect(session.submit).toHaveBeenCalledWith('hello metaclaw', { awaitAsyncWork: true });
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'metaclaw reply');
    expect(client.removeReactionFromMessage).toHaveBeenCalledWith('om_message', 'reaction_typing');
    expect(client.addReactionToMessage.mock.invocationCallOrder[0]).toBeLessThan(
      session.submit.mock.invocationCallOrder[0],
    );
    expect(client.removeReactionFromMessage.mock.invocationCallOrder[0]).toBeGreaterThan(
      client.sendMarkdownCardToChat.mock.invocationCallOrder[0],
    );
  });

  it('keeps Executor final-result blocks when scoping a reply to the created task', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 创建报告',
            '任务 #task_final_result 已创建：创建报告',
            '【Executor: codex-cli｜最终结果｜#task_final_result / #subtask_report】\n完整报告正文',
            '✓ 任务完成 (1.2s)',
            '┌─ 任务结果 ─────────────────────────┐',
            '摘要：任务已完成，详见上方 Executor 最终结果',
            '└────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_final_result',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"创建报告"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', '完整报告正文');
  });

  it('handles /sethome without submitting a task', async () => {
    const session = {
      getSnapshot: vi.fn().mockReturnValue({ output: [] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const setHomeChannel = vi.fn();

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_sethome',
        chat_id: 'oc_home',
        message_type: 'text',
        content: '{"text":"/sethome"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      setHomeChannel,
    });

    expect(setHomeChannel).toHaveBeenCalledWith('oc_home');
    expect(session.submit).not.toHaveBeenCalled();
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_home',
      '已将当前飞书会话设置为 MetaClaw home channel：oc_home',
    );
  });

  it('blocks denied DM users before task submission', async () => {
    const session = {
      getSnapshot: vi.fn().mockReturnValue({ output: [] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      sender: {
        sender_id: { open_id: 'ou_denied' },
      },
      message: {
        message_id: 'om_denied',
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hello"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      accessPolicy: {
        dmPolicy: 'allowlist',
        allowedUsers: ['ou_allowed'],
        groupPolicy: 'open',
        requireMention: true,
      },
    });

    expect(session.submit).not.toHaveBeenCalled();
    expect(client.addReactionToMessage).not.toHaveBeenCalled();
    expect(session.appendSystemMessage).toHaveBeenCalledWith('→ 飞书消息已被 Gateway 策略拦截: dm_allowlist_denied');
  });

  it('records delivery audit events for final reply chunks', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'audited reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };
    const audit = { record: vi.fn() };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_audit',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"audit"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      accessPolicy: {
        dmPolicy: 'allow_all',
        allowedUsers: [],
        groupPolicy: 'open',
        requireMention: true,
      },
      audit,
    });

    expect(audit.record).toHaveBeenCalledWith({
      kind: 'inbound',
      chatId: 'oc_chat',
      requestId: 'om_audit',
      method: 'skipped',
      ok: true,
    });
    expect(audit.record).toHaveBeenCalledWith({
      kind: 'policy',
      chatId: 'oc_chat',
      requestId: 'om_audit',
      method: 'skipped',
      ok: true,
      reason: 'dm_allow_all',
    });
    expect(audit.record).toHaveBeenCalledWith({
      kind: 'final',
      chatId: 'oc_chat',
      chunkIndex: 0,
      chunkCount: 1,
      method: 'card',
      ok: true,
    });
  });

  it('downloads a Feishu file message and attaches it to the next text instruction', async () => {
    const pendingResourcesByChatId = new Map<string, string[]>();
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'analysis reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      downloadMessageResource: vi.fn().mockResolvedValue({
        path: '/tmp/metaclaw-feishu/report.txt',
        fileName: 'report.txt',
      }),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_file',
        chat_id: 'oc_chat',
        message_type: 'file',
        content: '{"file_key":"file_key_uploaded","file_name":"report.txt"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      pendingResourcesByChatId,
      uploadDir: '/tmp/metaclaw-feishu-test',
    });
    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_text',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"分析一下这个文件里的内容"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(['om_file']),
      pendingResourcesByChatId,
    });

    expect(client.downloadMessageResource).toHaveBeenCalledWith({
      messageId: 'om_file',
      fileKey: 'file_key_uploaded',
      resourceType: 'file',
      fileName: 'report.txt',
      outputDir: '/tmp/metaclaw-feishu-test/oc_chat/om_file',
    });
    expect(session.appendSystemMessage).toHaveBeenCalledWith('→ 已接收飞书文件: report.txt');
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      '已收到附件：report.txt。请继续发送处理说明。',
    );
    expect(session.submit).toHaveBeenCalledWith([
      '分析一下这个文件里的内容',
      '',
      '关联飞书上传文件：',
      '"/tmp/metaclaw-feishu/report.txt"',
    ].join('\n'), { awaitAsyncWork: true });
    expect(pendingResourcesByChatId.has('oc_chat')).toBe(false);
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'analysis reply');
  });

  it('acknowledges a standalone image without invoking the Planner', async () => {
    const pendingResourcesByChatId = new Map<string, string[]>();
    const session = {
      getSnapshot: vi.fn(() => ({ output: [] })),
      submit: vi.fn(),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn(),
      removeReactionFromMessage: vi.fn(),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      downloadMessageResource: vi.fn().mockResolvedValue({
        path: '/tmp/metaclaw-feishu/photo.jpg',
        fileName: 'photo.jpg',
      }),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_standalone_image',
        chat_id: 'oc_chat',
        message_type: 'image',
        content: '{"image_key":"img_uploaded"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      pendingResourcesByChatId,
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      '已收到附件：photo.jpg。请继续发送处理说明。',
    );
    expect(session.submit).not.toHaveBeenCalled();
    expect(pendingResourcesByChatId.get('oc_chat')).toEqual(['/tmp/metaclaw-feishu/photo.jpg']);
  });

  it('keeps both text and images from a Feishu rich-text post', async () => {
    const pendingResourcesByChatId = new Map<string, string[]>();
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', '图文处理完成'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      downloadMessageResource: vi.fn()
        .mockResolvedValueOnce({ path: '/tmp/metaclaw-feishu/one.jpg', fileName: 'one.jpg' })
        .mockResolvedValueOnce({ path: '/tmp/metaclaw-feishu/two.jpg', fileName: 'two.jpg' }),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_post',
        chat_id: 'oc_chat',
        message_type: 'post',
        content: JSON.stringify({
          title: '图文任务',
          content: [[
            { tag: 'text', text: '保留这段说明：' },
            { tag: 'img', image_key: 'img_one' },
            { tag: 'text', text: '并处理两张图' },
            { tag: 'img', image_key: 'img_two' },
          ]],
        }),
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      pendingResourcesByChatId,
    });

    expect(client.downloadMessageResource).toHaveBeenCalledTimes(2);
    expect(session.submit).toHaveBeenCalledWith([
      '图文任务',
      '保留这段说明：并处理两张图',
      '',
      '关联飞书上传文件：',
      '"/tmp/metaclaw-feishu/one.jpg"',
      '"/tmp/metaclaw-feishu/two.jpg"',
    ].join('\n'), { awaitAsyncWork: true });
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', '图文处理完成');
  });

  it('retains a downloaded resource when Planner asks the user to replay the request', async () => {
    const pendingResourcesByChatId = new Map<string, string[]>();
    const warning = 'Warning: 规划提案传输状态不确定；请重放同一请求。 Planner unavailable: Connection error.';
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', warning] })
        .mockReturnValueOnce({ output: ['before', warning] })
        .mockReturnValueOnce({ output: ['before', warning, 'analysis reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      downloadMessageResource: vi.fn().mockResolvedValue({
        path: '/tmp/metaclaw-feishu/image.jpg',
        fileName: 'image.jpg',
      }),
    };
    const deps = {
      session,
      client,
      seenMessageIds: new Set<string>(),
      pendingResourcesByChatId,
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_image',
        chat_id: 'oc_chat',
        message_type: 'image',
        content: '{"image_key":"image_key_uploaded"}',
      },
    }, deps);
    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_text_failed',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"把图片原样发回"}',
      },
    }, deps);

    expect(pendingResourcesByChatId.get('oc_chat')).toEqual(['/tmp/metaclaw-feishu/image.jpg']);

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_text_retry',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"把图片原样发回"}',
      },
    }, deps);

    expect(session.submit).toHaveBeenNthCalledWith(2, [
      '把图片原样发回',
      '',
      '关联飞书上传文件：',
      '"/tmp/metaclaw-feishu/image.jpg"',
    ].join('\n'), { awaitAsyncWork: true });
    expect(pendingResourcesByChatId.has('oc_chat')).toBe(false);
  });

  it('replies with the final task answer instead of Metaclaw execution logs', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 能收到消息吗?',
            '任务 #task_test 已创建：能收到消息吗?',
            '[提取最近历史记录上下文]',
            '→ 派发给 codex-cli...',
            '[构建执行上下文]',
            '[执行上下文准备完成]',
            '→ 正在执行任务 #task_test...',
            '+ Executor: codex-cli｜#task_test｜已启动 codex-cli 执行器',
            '+ Executor: codex-cli｜#task_test｜关联历史：',
            '+ Executor: codex-cli｜#task_test｜[普通对话] 用户: 听到了吗?',
            '+ Executor: codex-cli｜#task_test｜[助手: 听到了。有什么要我处理?',
            '+ Executor: codex-cli｜#task_test｜codex',
            '+ Executor: codex-cli｜#task_test｜能收到。',
            '+ Executor: codex-cli｜#task_test｜tokens used',
            '+ Executor: codex-cli｜#task_test｜670',
            '+ Executor: codex-cli｜#task_test｜能收到。',
            '✓ 任务完成 (12.4s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 能收到。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"能收到消息吗?"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '→ 任务 #task_test 已创建：能收到消息吗?',
      '【提取最近历史记录上下文】',
      '→ 发送给 codex-cli 进行意图解析与执行准备',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 正在执行任务 #task_test...',
      '→ Executor: codex-cli 已启动执行器',
      '✓ 任务完成 (12.4s)',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', '能收到。');
  });

  it('streams core progress cards before the final Feishu answer when session subscription is available', async () => {
    let output = ['before'];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    const append = (...lines: string[]) => {
      output = [...output, ...lines];
      listener?.({ output: [...output] });
    };
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listener = next;
        next({ output: [...output] });
        return () => {
          listener = null;
        };
      }),
      submit: vi.fn().mockImplementation(async () => {
        append('任务 #task_stream 已创建：流式展示步骤');
        append('【提取最近历史记录上下文】');
        append('→ 派发给 codex-cli...');
        append('【构建执行上下文】');
        append('【执行上下文准备完成】');
        append('→ 正在执行任务 #task_stream...');
        append('+ Executor: codex-cli｜#task_stream｜已启动 codex-cli 执行器');
        append('+ Executor: codex-cli｜#task_stream｜最终答案');
        append('+ Executor: codex-cli｜#task_stream｜tokens used');
        append('+ Executor: codex-cli｜#task_stream｜123');
        append('+ Executor: codex-cli｜#task_stream｜最终答案');
        append('✓ 任务完成 (3.2s)');
        return { exitRequested: false };
      }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_stream',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"流式展示步骤"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '→ 任务 #task_stream 已创建：流式展示步骤',
      '【提取最近历史记录上下文】',
      '→ 发送给 codex-cli 进行意图解析与执行准备',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 正在执行任务 #task_stream...',
      '→ Executor: codex-cli 已启动执行器',
      '✓ 任务完成 (3.2s)',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', '最终答案');
  });

  it('returns a visible approval prompt when repository publication is awaiting authorization', async () => {
    const previewRoot = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-preview-'));
    const previewArtifact = resolve(previewRoot, 'acceptance.txt');
    writeFileSync(previewArtifact, 'AnyFusion 飞书资源发送验收通过', 'utf-8');
    let output = ['before'];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    let permissionRequests: any[] = [];
    const permissionRequest = {
      schemaVersion: 1 as const,
      permissionRequestId: 'permission_request_publish_test',
      reviewId: 'decision_publish_test',
      taskId: 'task_publish_test',
      taskTitle: '创建验收文件',
      generationId: 'generation_publish_test',
      subtaskId: 'subtask_publish_test',
      subtaskTitle: '创建 acceptance.txt',
      attemptId: 'attempt_publish_test',
      executorName: 'codex',
      permissionProfileId: 'default',
      capability: 'repository_promotion',
      resource: '/workspace/default',
      operation: 'promote_commit:abc123',
      reason: 'Changed paths (1): acceptance.txt.',
      suggestedScope: 'once' as const,
      escalationReason: 'capability requires exact user authorization',
      candidateReport: '已创建 acceptance.txt，并验证内容完全一致。',
      candidateArtifacts: [previewArtifact],
      changedPaths: ['acceptance.txt'],
      createdAt: '2026-08-13T02:26:41.000Z',
      expiresAt: '2026-08-13T04:26:41.000Z',
    };
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listener = next;
        next({ output: [...output] });
        return () => {
          listener = null;
        };
      }),
      submit: vi.fn().mockImplementation(() => {
        output = [...output,
          '任务 #task_publish_test 已创建：创建验收文件',
          '→ 正在执行任务 #task_publish_test...',
        ];
        permissionRequests = [permissionRequest];
        listener?.({ output: [...output] });
        return new Promise<{ exitRequested: boolean }>(() => undefined);
      }),
      appendSystemMessage: vi.fn(),
      getPlannerTuiPermissionRequests: vi.fn(() => permissionRequests),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_permission_prompt',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"创建验收文件"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', [
      '⚠️ 发布授权请求：任务 #task_publish_test 已完成执行，等待一次性发布授权。',
      '即将把“创建 acceptance.txt”产生的更改合入当前项目。',
      '',
      '**结果预览**',
      '已创建 acceptance.txt，并验证内容完全一致。',
      '',
      '**待发布文件**',
      '- acceptance.txt',
      '',
      '**acceptance.txt 预览**',
      '',
      '```',
      'AnyFusion 飞书资源发送验收通过',
      '```',
      '',
      '批准请只回复：批准本次发布',
      '拒绝请只回复：拒绝本次发布',
    ].join('\n'));
  });

  it('auto-approves every Feishu publication for the active task without showing approval prompts', async () => {
    const deliveryRoot = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-auto-publish-'));
    const deliveryArtifact = resolve(deliveryRoot, 'report.pdf');
    writeFileSync(deliveryArtifact, 'pdf-result', 'utf-8');
    let output = ['before'];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    const baseRequest = {
      schemaVersion: 1 as const,
      taskId: 'task_auto_publish',
      taskTitle: '生成报告',
      generationId: 'generation_auto_publish',
      executorName: 'codex',
      permissionProfileId: 'default',
      capability: 'repository_promotion',
      resource: '/workspace/default',
      suggestedScope: 'once' as const,
      escalationReason: 'capability requires exact user authorization',
      createdAt: '2026-08-13T02:26:41.000Z',
      expiresAt: '2026-08-13T04:26:41.000Z',
    };
    const firstRequest = {
      ...baseRequest,
      permissionRequestId: 'permission_request_auto_first',
      reviewId: 'decision_auto_first',
      subtaskId: 'subtask_auto_first',
      subtaskTitle: '调研资料',
      attemptId: 'attempt_auto_first',
      operation: 'promote_commit:first',
      reason: 'Changed paths (1): research.md.',
    };
    const secondRequest = {
      ...baseRequest,
      permissionRequestId: 'permission_request_auto_second',
      reviewId: 'decision_auto_second',
      subtaskId: 'subtask_auto_second',
      subtaskTitle: '生成 PDF',
      attemptId: 'attempt_auto_second',
      operation: 'promote_commit:second',
      reason: 'Changed paths (1): report.pdf.',
      createdAt: '2026-08-13T02:27:41.000Z',
    };
    let permissionRequests: any[] = [];
    let taskStatus = 'running';
    const intermediateArtifact = resolve(deliveryRoot, 'research.md');
    writeFileSync(intermediateArtifact, 'research-result', 'utf-8');
    let integratedResults: any[] = [];
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listener = next;
        next({ output: [...output] });
        return () => {
          listener = null;
        };
      }),
      submit: vi.fn().mockImplementation(() => {
        output = [...output,
          '任务 #task_auto_publish 已创建：生成报告',
          '→ 正在执行任务 #task_auto_publish...',
        ];
        permissionRequests = [firstRequest];
        listener?.({ output: [...output] });
        return new Promise<{ exitRequested: boolean }>(() => undefined);
      }),
      appendSystemMessage: vi.fn(),
      getPlannerTuiPermissionRequests: vi.fn(() => permissionRequests),
      getPlannerTuiExecutorResults: vi.fn(() => integratedResults),
      getPlannerTuiSnapshot: vi.fn(() => ({
        taskPool: [{ id: 'task_auto_publish', status: taskStatus }],
      })),
      resolvePlannerTuiPermission: vi.fn().mockImplementation(async (requestId: string) => {
        if (requestId === firstRequest.permissionRequestId) {
          permissionRequests = [];
          integratedResults = [{
            schemaVersion: 1,
            publicationId: 'publication_auto_first',
            taskId: 'task_auto_publish',
            taskTitle: '生成报告',
            subtaskId: 'subtask_auto_first',
            subtaskTitle: '调研资料',
            attemptId: 'attempt_auto_first',
            executorName: 'pi',
            report: '调研资料已发布。',
            artifacts: [intermediateArtifact],
            warnings: [],
            integrationCommit: 'first',
            completedAt: '2026-08-13T02:27:41.000Z',
            reportTruncated: false,
          }];
          setTimeout(() => {
            permissionRequests = [secondRequest];
            listener?.({ output: [...output] });
          }, 50);
        } else {
          permissionRequests = [];
          integratedResults = [...integratedResults, {
            schemaVersion: 1,
            publicationId: 'publication_auto_second',
            taskId: 'task_auto_publish',
            taskTitle: '生成报告',
            subtaskId: 'subtask_auto_second',
            subtaskTitle: '生成 PDF',
            attemptId: 'attempt_auto_second',
            executorName: 'codex',
            report: '报告已生成并发布。',
            artifacts: [deliveryArtifact],
            warnings: [],
            integrationCommit: 'second',
            completedAt: '2026-08-13T02:28:41.000Z',
            reportTruncated: false,
          }];
          taskStatus = 'done';
        }
        listener?.({ output: [...output] });
        return { status: 'resolved' as const, resolution: 'approve' as const, message: 'recorded' };
      }),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue('file_key_report'),
      sendFileToChat: vi.fn().mockResolvedValue(undefined),
    };
    const audit = { record: vi.fn() };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_auto_publish',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"生成报告"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      audit,
      autoApproveRepositoryPromotion: true,
    });

    expect(session.resolvePlannerTuiPermission).toHaveBeenNthCalledWith(
      1,
      firstRequest.permissionRequestId,
      'approve',
    );
    expect(session.resolvePlannerTuiPermission).toHaveBeenNthCalledWith(
      2,
      secondRequest.permissionRequestId,
      'approve',
    );
    expect(client.sendMarkdownCardToChat.mock.calls.flat().join('\n')).not.toContain('发布授权请求');
    expect(client.sendMarkdownCardToChat.mock.calls.flat().join('\n')).not.toContain('批准本次发布');
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      ['任务 #task_auto_publish 已完成合并与交付。', '', '报告已生成并发布。'].join('\n'),
    );
    expect(client.uploadFile).toHaveBeenCalledWith(deliveryArtifact);
    expect(client.uploadFile).not.toHaveBeenCalledWith(intermediateArtifact);
    expect(client.sendFileToChat).toHaveBeenCalledWith('oc_chat', 'file_key_report');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'permission',
      requestId: firstRequest.permissionRequestId,
      reason: 'repository_promotion_auto_approved',
    }));
  });

  it('resolves an explicit Feishu publication approval and delivers the continued task result', async () => {
    const deliveryRoot = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-delivery-'));
    const deliveryArtifact = resolve(deliveryRoot, 'acceptance.txt');
    writeFileSync(deliveryArtifact, 'AnyFusion 飞书资源发送验收通过', 'utf-8');
    let output = ['before'];
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const permissionRequest = {
      schemaVersion: 1 as const,
      permissionRequestId: 'permission_request_publish_approve',
      reviewId: 'decision_publish_approve',
      taskId: 'task_publish_approve',
      taskTitle: '创建验收文件',
      generationId: 'generation_publish_approve',
      subtaskId: 'subtask_publish_approve',
      subtaskTitle: '创建 acceptance.txt',
      attemptId: 'attempt_publish_approve',
      executorName: 'codex',
      permissionProfileId: 'default',
      capability: 'repository_promotion',
      resource: '/workspace/default',
      operation: 'promote_commit:def456',
      reason: 'Changed paths (1): acceptance.txt.',
      suggestedScope: 'once' as const,
      escalationReason: 'capability requires exact user authorization',
      createdAt: '2026-08-13T02:26:41.000Z',
      expiresAt: '2026-08-13T04:26:41.000Z',
    };
    let pending = true;
    let integratedResult: any = null;
    const notify = () => {
      for (const listener of listeners) listener({ output: [...output] });
    };
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listeners.add(next);
        next({ output: [...output] });
        return () => listeners.delete(next);
      }),
      submit: vi.fn(),
      appendSystemMessage: vi.fn(),
      getPlannerTuiPermissionRequests: vi.fn(() => pending ? [permissionRequest] : []),
      getPlannerTuiExecutorResults: vi.fn(() => integratedResult ? [integratedResult] : []),
      resolvePlannerTuiPermission: vi.fn().mockImplementation(async () => {
        pending = false;
        integratedResult = {
          schemaVersion: 1,
          publicationId: 'publication_publish_approve',
          taskId: 'task_publish_approve',
          taskTitle: '创建验收文件',
          subtaskId: 'subtask_publish_approve',
          subtaskTitle: '创建 acceptance.txt',
          attemptId: 'attempt_publish_approve',
          executorName: 'codex',
          report: '已创建并发布 acceptance.txt。',
          artifacts: [deliveryArtifact],
          warnings: [],
          integrationCommit: 'def456',
          completedAt: '2026-08-13T02:53:02.796Z',
          reportTruncated: false,
        };
        notify();
        return { status: 'resolved' as const, resolution: 'approve' as const, message: 'recorded' };
      }),
    };
    const client = {
      addReactionToMessage: vi.fn(),
      removeReactionFromMessage: vi.fn(),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue('file_key_acceptance'),
      sendFileToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_permission_approve',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"批准本次发布"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(session.resolvePlannerTuiPermission).toHaveBeenCalledWith(
      'permission_request_publish_approve',
      'approve',
    );
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      '已批准任务 #task_publish_approve 的本次发布，正在完成合并与交付。',
    );
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      [
        '任务 #task_publish_approve 已完成合并与交付。',
        '',
        '已创建并发布 acceptance.txt。',
      ].join('\n'),
    );
    expect(client.uploadFile).toHaveBeenCalledWith(deliveryArtifact);
    expect(client.sendFileToChat).toHaveBeenCalledWith('oc_chat', 'file_key_acceptance');
  });

  it('redelivers the latest integrated result and its final artifact without invoking Planner', async () => {
    const deliveryRoot = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-redelivery-'));
    const deliveryArtifact = resolve(deliveryRoot, 'acceptance.txt');
    writeFileSync(deliveryArtifact, 'AnyFusion 飞书资源发送验收通过', 'utf-8');
    const session = {
      getSnapshot: vi.fn(() => ({ output: [] })),
      submit: vi.fn(),
      appendSystemMessage: vi.fn(),
      getPlannerTuiPermissionRequests: vi.fn(() => []),
      getPlannerTuiExecutorResults: vi.fn(() => [{
        schemaVersion: 1 as const,
        publicationId: 'publication_latest',
        taskId: 'task_latest',
        taskTitle: '创建验收文件',
        subtaskId: 'subtask_latest',
        subtaskTitle: '创建 acceptance.txt',
        attemptId: 'attempt_latest',
        executorName: 'codex',
        report: '已创建并发布 acceptance.txt。',
        artifacts: [deliveryArtifact],
        warnings: [],
        integrationCommit: 'abc123',
        completedAt: '2026-08-13T02:53:02.796Z',
        reportTruncated: false,
      }]),
    };
    const client = {
      addReactionToMessage: vi.fn(),
      removeReactionFromMessage: vi.fn(),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue('file_key_redelivery'),
      sendFileToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_redeliver_latest',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"重发上次结果"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(session.submit).not.toHaveBeenCalled();
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      expect.stringContaining('任务 #task_latest 已完成合并与交付。'),
    );
    expect(client.uploadFile).toHaveBeenCalledWith(deliveryArtifact);
    expect(client.sendFileToChat).toHaveBeenCalledWith('oc_chat', 'file_key_redelivery');
  });

  it('waits for direct-reply output to settle before sending the final Feishu answer', async () => {
    vi.useFakeTimers();
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const output = ['before'];
    const notify = () => {
      for (const listener of listeners) {
        listener({ output: [...output] });
      }
    };
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listeners.add(callback);
        callback({ output: [...output] });
        return () => {
          listeners.delete(callback);
        };
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_direct_settle',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"这个问题你怎么回答了一半？继续完成。"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await Promise.resolve();
    output.push(
      '> 这个问题你怎么回答了一半？继续完成。',
      '【MetaClaw｜理解用户请求】',
      '→ MetaClaw：已识别普通对话',
      '→ MetaClaw：执行策略：直接回答，不创建任务',
      '→ MetaClaw：由 PlanningAgent 直接作答',
    );
    notify();
    resolveSubmit();
    await Promise.resolve();
    output.push('这是补全后的最终答案，飞书必须展示这一段。');
    notify();

    await vi.advanceTimersByTimeAsync(301);
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('**处理步骤**');
    expect(sentTexts.at(-1)).toBe('这是补全后的最终答案，飞书必须展示这一段。');
  });

  it('keeps direct-reply final answers that start with Markdown links to local docs', async () => {
    vi.useFakeTimers();
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const output = ['before'];
    const notify = () => {
      for (const listener of listeners) {
        listener({ output: [...output] });
      }
    };
    const append = (...lines: string[]) => {
      output.push(...lines);
      notify();
    };
    const finalAnswer = [
      '- [README.zh-CN.md](/home/ylfego/Program/metaclaw/README.zh-CN.md)：当前对外能力与使用方式',
      '- [ROUTING.md](/home/ylfego/Program/metaclaw/ROUTING.md)：智能路由层设计',
      '',
      '**MetaClaw 一句话定位**',
      'MetaClaw 是一个本地优先的 AI Task OS。',
      '',
      '**核心能力展示**',
      '用户自然语言 → 语义入口判断 → ExecutionPolicy 路由 → Executor 执行 → 交付。',
    ].join('\n');
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listeners.add(callback);
        callback({ output: [...output] });
        return () => {
          listeners.delete(callback);
        };
      }),
      submit: vi.fn().mockImplementation(async () => {
        append(
          '> 怎么还没有给我结果呀',
          '【MetaClaw｜理解用户请求】',
          '→ MetaClaw：已识别普通对话',
          '→ MetaClaw：执行策略：直接回答，不创建任务',
          '【Executor: codex-cli｜回答】',
          '→ Executor: codex-cli 处理本次回答',
          '【MetaClaw｜召回会话上下文】',
          '→ MetaClaw：正在召回与本次问答相关的最近对话',
          '→ MetaClaw：已召回 1 条相关会话上下文',
          '→ MetaClaw：会把召回上下文注入给 Executor，保持连续问答衔接',
          '【Executor: codex-cli｜回答生成】',
          '→ Executor: codex-cli 正在基于当前问题和会话上下文生成回答',
          finalAnswer,
        );
        return { exitRequested: false };
      }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const handled = handleFeishuMessageEvent({
        message: {
          message_id: 'om_message_direct_markdown_links',
          chat_id: 'oc_chat',
          message_type: 'text',
          content: '{"text":"怎么还没有给我结果呀"}',
        },
      }, {
        session,
        client,
        seenMessageIds: new Set<string>(),
      });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(301);
      await handled;

      const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
      expect(sentTexts.join('\n')).toContain('**处理步骤**');
      expect(sentTexts.at(-1)).toBe(finalAnswer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('streams task failure to Feishu when session subscription is available', async () => {
    let output = ['before'];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    const append = (...lines: string[]) => {
      output = [...output, ...lines];
      listener?.({ output: [...output] });
    };
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listener = next;
        next({ output: [...output] });
        return () => {
          listener = null;
        };
      }),
      submit: vi.fn().mockImplementation(async () => {
        append('任务 #task_fail 已创建：失败展示');
        append('→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)');
        append('→ 原因：research_workflow / research + reporting');
        append('→ 正在执行任务 #task_fail...');
        append('+ Executor: pi-agent｜#task_fail｜已启动 pi-agent 执行器');
        append('✗ 执行失败: executor idle timeout');
        append('→ 任务 #task_fail 已转为阻塞；执行器长时间没有输出或状态变化，可能卡住。');
        return { exitRequested: false };
      }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_stream_fail',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"失败展示"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('✗ 执行失败: executor idle timeout');
    expect(sentTexts.join('\n')).toContain('执行器长时间没有输出或状态变化');
  });

  it('replies with a multiline task summary and strips execution history logs', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '【提取最近历史记录上下文】',
            '【构建执行上下文】',
            '【执行上下文准备完成】',
            '· Executor: codex-cli｜#task_VgmCT6a9Ti｜已启动 codex-cli 执行器',
            '· Executor: codex-cli｜#task_VgmCT6a9Ti｜关联历史：',
            '· Executor: codex-cli｜#task_VgmCT6a9Ti｜[任务#task_qiG5ghS6LV] 用户: zarazhang这个博主帮我调研下',
            '· Executor: codex-cli｜#task_VgmCT6a9Ti｜助手: 以下是基于公开资料的调研结论。',
            '· Executor: codex-cli｜#task_VgmCT6a9Ti｜tokens used',
            '· Executor: codex-cli｜#task_VgmCT6a9Ti｜1,195',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 我刚才根据注入的历史上下文，回答了你“之前都做过什么任务”的问题，概括了几件事：',
            '',
            '1. 调研 Zara Zhang / 张咋啦。',
            '2. 把长篇调研结果保存为本地 Markdown 文件。',
            '3. 说明保存路径和文件内容限制。',
            '4. 总结这些都是基于当前上下文能看到的历史，不额外访问本地文件。',
            '│ 下一步: 如需延续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"你之前都做过什么任务啊？"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '【提取最近历史记录上下文】',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ Executor: codex-cli 已启动执行器',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', [
      '我刚才根据注入的历史上下文，回答了你“之前都做过什么任务”的问题，概括了几件事：',
      '',
      '1. 调研 Zara Zhang / 张咋啦。',
      '2. 把长篇调研结果保存为本地 Markdown 文件。',
      '3. 说明保存路径和文件内容限制。',
      '4. 总结这些都是基于当前上下文能看到的历史，不额外访问本地文件。',
    ].join('\n'));
  });

  it('replies with the full executor answer instead of the task summary for Feishu only', async () => {
    const fullAnswer = [
      '第一段：这是执行器生成的完整回答开头。',
      '',
      '第二段：这里包含超过任务摘要的正文内容，飞书应该收到这些内容。',
      '第三段：这行也必须保留，证明没有只取 200 字摘要。',
    ].join('\n');
    const truncatedSummary = `${fullAnswer.slice(0, 30)}...被摘要截断`;
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 请详细解释一下这个问题',
            '任务 #task_full 已创建：请详细解释一下这个问题',
            '→ 正在执行任务 #task_full...',
            '+ Executor: codex-cli｜#task_full｜已启动 codex-cli 执行器',
            ...fullAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_full｜${line}`),
            '+ Executor: codex-cli｜#task_full｜tokens used',
            '+ Executor: codex-cli｜#task_full｜1,234',
            '✓ 任务完成 (12.4s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            `│ 摘要: ${truncatedSummary}`,
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_full',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"请详细解释一下这个问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(1, 'oc_chat', [
      '**处理步骤**',
      '→ 任务 #task_full 已创建：请详细解释一下这个问题',
      '→ 正在执行任务 #task_full...',
      '→ Executor: codex-cli 已启动执行器',
      '✓ 任务完成 (12.4s)',
    ].join('\n'));
    expect(client.sendMarkdownCardToChat).toHaveBeenNthCalledWith(2, 'oc_chat', fullAnswer);
  });

  it('does not expose raw executor context or workspace paths in Feishu replies', async () => {
    const reply = formatFeishuReply([
      '任务 #task_private 已创建：做一份调研报告',
      '→ 执行准备：先由 codex-cli 解析意图与构建上下文，随后按路由派发到具体 Executor',
      '→ 路由决策：调研竞速 (auto_dispatch, confidence=1.00)',
      '→ 执行器：pi-agent + hermes-agent',
      '→ 正在执行任务 #task_private...',
      '+ Executor: codex-cli｜#task_private｜已启动 codex-cli 执行器',
      '+ Executor: codex-cli｜#task_private｜工作目录：/home/ylfego/Program/metaclaw',
      '+ Executor: codex-cli｜#task_private｜文件输出目标：/home/ylfego/Program/metaclaw/metaclaw-tasks/task_private',
      '+ Executor: codex-cli｜#task_private｜会话近期上下文：',
      '+ Executor: codex-cli｜#task_private｜[任务#task_old] 用户：之前的任务内容',
      '+ Executor: codex-cli｜#task_private｜相似历史参考（Reference Context Pack / Minimal Reference Cards，仅供参考）',
      '+ Executor: codex-cli｜#task_private｜用户意图：插入一个紧急任务，看看 openhumans 这个项目',
      '+ Executor: codex-cli｜#task_private｜相关性原因：历史用户意图提到类似任务',
      '+ Executor: codex-cli｜#task_private｜可复用内容：参考当时的处理步骤',
      '+ Executor: codex-cli｜#task_private｜边界声明：当前任务目标优先',
      '+ Executor: codex-cli｜#task_private｜输出处理：历史输出约 152 字',
      '✓ 任务完成 (18.4s)',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: 调研报告已生成，核心结论是该市场仍处于早期，需要重点验证用户付费意愿。',
      '│ 下一步: 如需延续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(reply).toBe('调研报告已生成，核心结论是该市场仍处于早期，需要重点验证用户付费意愿。');
    expect(reply).not.toContain('/home/ylfego');
    expect(reply).not.toContain('文件输出目标');
    expect(reply).not.toContain('会话近期上下文');
    expect(reply).not.toContain('Reference Context Pack');
    expect(reply).not.toContain('任务#task_old');
  });

  it('uses the full appended executor output instead of truncated summary when earlier task logs contain internal context', () => {
    const fullAnswer = [
      '如果把 MetaClaw 做成桌面端，我建议它不要定位成“AI 桌面助手”，更不要定位成“个人知识管理”，而应定位成：',
      '',
      '**企业 AI Agent 工作台：运行在员工本地桌面的任务连续性、上下文接入与多执行器调度中枢。**',
      '',
      '**MetaClaw Desktop = 企业员工电脑上的 AI 工作调度台。它负责把本地文件、浏览器、IM、企业系统、执行器 CLI 和长期任务状态连接起来，让 AI 能跨中断、跨工具、跨天持续推进工作。**',
      '',
      '它的核心不是“聊天”，而是三件事：',
      '',
      '1. **把桌面变成企业工作的感知入口**',
      '2. **把 AI 执行变成可管理的任务流**',
      '3. **把多个 Agent / CLI / 企业系统统一调度**',
    ].join('\n');
    const truncatedSummary = fullAnswer.slice(0, 200);

    const reply = formatFeishuReply([
      '任务 #task_desktop 已创建：MetaClaw 桌面端定位',
      '→ 正在执行任务 #task_desktop...',
      '+ Executor: codex-cli｜#task_desktop｜已启动 codex-cli 执行器',
      '+ Executor: codex-cli｜#task_desktop｜工作目录：/home/ylfego/Program/metaclaw',
      '+ Executor: codex-cli｜#task_desktop｜文件输出目标：/home/ylfego/Program/metaclaw/metaclaw-tasks/task_desktop',
      '+ Executor: codex-cli｜#task_desktop｜会话近期上下文：',
      '+ Executor: codex-cli｜#task_desktop｜[任务#task_old] 用户：之前的问题',
      '✓ 任务完成 (81.8s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      `│ 摘要: ${truncatedSummary}`,
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      fullAnswer,
    ]);

    expect(reply).toBe(fullAnswer);
    expect(reply).toContain('3. **把多个 Agent / CLI / 企业系统统一调度**');
    expect(reply).not.toBe(truncatedSummary);
    expect(reply).not.toContain('工作目录');
    expect(reply).not.toContain('/home/ylfego');
  });

  it('cleans full prefixed executor output for Feishu instead of falling back to the truncated task result summary', () => {
    const fullAnswer = [
      '我换一种方式讲：**你们的知识管理产品不要把自己定义成“文档管理/知识库”，而要定义成“企业业务决策系统的知识底座”。**',
      '',
      '飞书强的是“把企业已有信息收进来、整理好、让人和 Agent 能查”。但这仍然偏向**信息管理**。',
      '',
      '你们如果要有不可替代性，应该往更深一层走：不是帮企业“存知识”，而是帮企业把业务世界建模出来，让知识能直接参与判断、推演和行动。',
      '',
      '**不要做“知识的仓库”，要做“业务对象 + 关系 + 决策 + 行动”的系统。**',
      '',
      '因为这需要深度理解行业业务对象、业务规则、业务流程和决策逻辑，不只是文档能力。',
    ].join('\n');
    const truncatedSummary = fullAnswer.slice(0, 200);

    const reply = formatFeishuReply([
      '任务 #task_knowledge 已创建：详细解释知识管理定位',
      '→ 正在执行任务 #task_knowledge...',
      '+ Executor: codex-cli｜#task_knowledge｜已启动 codex-cli 执行器',
      '+ Executor: codex-cli｜#task_knowledge｜[codex-cli] 工作目录：/home/ylfego/Program/metaclaw',
      '+ Executor: codex-cli｜#task_knowledge｜[codex-cli] 会话近期上下文：',
      '+ Executor: codex-cli｜#task_knowledge｜[codex-cli] [任务#task_old] 用户：之前的问题',
      ...fullAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_knowledge｜[codex-cli] ${line}`),
      '+ Executor: codex-cli｜#task_knowledge｜[codex-cli] tokens used',
      '+ Executor: codex-cli｜#task_knowledge｜[codex-cli] 1,548',
      '✓ 任务完成 (28.0s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      `│ 摘要: ${truncatedSummary}`,
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(reply).toBe(fullAnswer);
    expect(reply).toContain('业务对象 + 关系 + 决策 + 行动');
    expect(reply).not.toBe(truncatedSummary);
    expect(reply).not.toContain('#task_knowledge');
    expect(reply).not.toContain('[codex-cli]');
    expect(reply).not.toContain('工作目录');
    expect(reply).not.toContain('会话近期上下文');
  });

  it('extracts the urgent task final answer before auto-resumed task progress in Feishu replies', () => {
    const urgentAnswer = [
      '紧急任务最终结果正文',
      '',
      '这里是紧急任务的完整结论，飞书最终回复必须展示这一段。',
    ].join('\n');
    const reply = formatFeishuReply([
      '→ 高优任务到达，抢占当前任务 #task_old',
      '→ 原因：用户插入紧急任务',
      '→ 任务 #task_old 已挂起，开始执行 #task_urgent',
      '→ 派发给 codex-cli...',
      '→ 正在执行任务 #task_urgent...',
      '+ Executor: codex-cli｜#task_urgent｜已启动 codex-cli 执行器',
      ...urgentAnswer.split('\n'),
      '+ Executor: codex-cli｜#task_urgent｜tokens used',
      '+ Executor: codex-cli｜#task_urgent｜1,234',
      '✓ 任务完成 (17.2s)',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: 紧急任务最终结果正文',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '→ 正在执行任务 #task_old...',
      '+ Executor: codex-cli｜#task_old｜已启动 codex-cli 执行器',
    ]);

    expect(reply).toBe(urgentAnswer);
    expect(reply).not.toContain('→ 正在执行任务 #task_old...');
  });

  it('extracts a resumed task final answer once and preserves the full markdown body', () => {
    const resumedAnswer = [
      '恢复后的调研结论如下：AI agent 的未来不是“一个万能助手”，而是“可治理、可编排、可审计、可交易的数字劳动力网络”。',
      '# AI Agent 未来发展趋势深度调研',
      '一、总判断',
      'AI agent 正在从三个阶段演进：',
      '1. 聊天助手阶段',
      '代表：ChatGPT、Claude、Copilot。',
      '特点是回答、总结、写作、辅助决策。',
      '2. **工具执行阶段**',
      '代表：Manus、Devin、Claude Code、Codex。',
      '特点是可调用工具、读写文件、执行复杂任务。',
    ].join('\n');
    const reply = formatFeishuReply([
      '→ 正在执行任务 #task_old...',
      '+ Executor: codex-cli｜#task_old｜已启动 codex-cli 执行器',
      ...resumedAnswer.split('\n'),
      'tokens used',
      '2,468',
      ...resumedAnswer.split('\n'),
      '✓ 任务完成 (18.4s)',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: 恢复后的调研结论如下：AI agent 的未来不是“一个万能助手”，而是“可治理、可编排、可审计、可交易的数字劳动力网络”。',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(reply).toBe(resumedAnswer);
    expect(reply?.match(/恢复后的调研结论如下/g)).toHaveLength(1);
    expect(reply).toContain('2. **工具执行阶段**');
    expect(reply).toContain('特点是可调用工具、读写文件、执行复杂任务。');
  });

  it('appends Markdown preview links for generated task artifacts', () => {
    const outputLines = [
      '✓ 任务完成 (3.1s)',
      '→ 已记录 2 个任务产物',
      '   - /repo/metaclaw-tasks/task_doc/report.md',
      '   - /repo/metaclaw-tasks/task_doc/data.json',
    ];

    expect(extractMarkdownArtifactPaths(outputLines)).toEqual([
      '/repo/metaclaw-tasks/task_doc/report.md',
    ]);
    expect(extractArtifactPaths(outputLines)).toEqual([
      '/repo/metaclaw-tasks/task_doc/report.md',
      '/repo/metaclaw-tasks/task_doc/data.json',
    ]);
    expect(appendMarkdownPreviewLinks('文档已生成。', outputLines, {
      baseUrl: 'https://preview.example.com',
      workspaceRoot: '/repo',
    })).toBe([
      '文档已生成。',
      '',
      '**Markdown 在线预览**',
      '- [report.md](https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Freport.md)',
    ].join('\n'));
  });

  it('includes Markdown preview links in the final Feishu answer when task artifacts are Markdown files', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 生成一份 Markdown 文档',
            '任务 #task_doc 已创建：生成一份 Markdown 文档',
            '→ 正在执行任务 #task_doc...',
            '+ Executor: codex-cli｜#task_doc｜已启动 codex-cli 执行器',
            '+ Executor: codex-cli｜#task_doc｜文档已生成。',
            '+ Executor: codex-cli｜#task_doc｜tokens used',
            '+ Executor: codex-cli｜#task_doc｜123',
            '✓ 任务完成 (3.1s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 文档已生成。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '→ 文件输出目录: /repo/metaclaw-tasks/task_doc',
            '→ 已省略文件正文输出，请直接查看生成文件',
            '→ 已记录 1 个任务产物',
            '   - /repo/metaclaw-tasks/task_doc/report.md',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_doc',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"生成一份 Markdown 文档"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      markdownPreview: {
        baseUrl: 'https://preview.example.com',
        workspaceRoot: '/repo',
      },
    });

    const finalReplies = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    const finalReply = finalReplies.find(text =>
      typeof text === 'string' && text.includes('**Markdown 在线预览**')
    );
    expect(finalReply).toContain('文档已生成。');
    expect(finalReply).toContain('**Markdown 在线预览**');
    expect(finalReply).toContain('[report.md](https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Freport.md)');
  });

  it('hides verbose Codex command logs from Feishu and keeps only the answer plus preview link', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 优化刚才上传的文档并生成飞书文档',
            '任务 #task_doc 已创建：优化刚才上传的文档并生成飞书文档',
            '【提取最近历史记录上下文】',
            '【构建执行上下文】',
            '【执行上下文准备完成】',
            '→ 正在执行任务 #task_doc...',
            '+ Executor: codex-cli｜#task_doc｜已启动 codex-cli 执行器',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] 相关偏好：',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] [global] 凡是让你生成相关报告的详细内容展示的，都要同步生成飞书云文档，并生成在线预览。',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] 工作目录：/home/ylfego/Program/metaclaw',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] 文件输出目标：/home/ylfego/Program/metaclaw/metaclaw-tasks/task_doc',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] 关联飞书上传文件：',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] "/home/ylfego/.metaclaw/feishu-uploads/oc_chat/om_file/input.docx"',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] exec',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] /bin/bash -lc mkdir -p /home/ylfego/Program/metaclaw/metaclaw-tasks/task_doc && cp /tmp/source.md /home/ylfego/Program/metaclaw/metaclaw-tasks/task_doc/report.md in /home/ylfego/Program/metaclaw',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] succeeded in 0ms:',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] exec',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] /bin/bash -lc ls -lh /home/ylfego/Program/metaclaw/metaclaw-tasks/task_doc/report.md in /home/ylfego/Program/metaclaw',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] -rw-r--r-- 1 ylfe go 595 May 30 09:40 /home/ylfego/Program/metaclaw/metaclaw-tasks/task_doc/report.md',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] 已经生成 Markdown 文档并完成校验。',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] tokens used',
            '+ Executor: codex-cli｜#task_doc｜[codex-cli] 595',
            '✓ 任务完成 (3.1s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 已生成优化后的 Markdown 文档。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '→ 文件输出目录: /repo/metaclaw-tasks/task_doc',
            '→ 已省略文件正文输出，请直接查看生成文件',
            '→ 已记录 1 个任务产物',
            '   - /repo/metaclaw-tasks/task_doc/report.md',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_verbose_doc',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"优化刚才上传的文档并生成飞书文档"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      markdownPreview: {
        baseUrl: 'https://preview.example.com',
        workspaceRoot: '/repo',
      },
    });

    const finalReplies = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    const finalReply = finalReplies.find(text =>
      typeof text === 'string' && text.includes('**Markdown 在线预览**')
    );
    expect(finalReply).toContain('已生成优化后的 Markdown 文档。');
    expect(finalReply).toContain('**Markdown 在线预览**');
    expect(finalReply).toContain('[report.md](https://preview.example.com/preview/metaclaw-tasks%2Ftask_doc%2Freport.md)');
    expect(finalReply).not.toContain('[codex-cli]');
    expect(finalReply).not.toContain('/bin/bash');
    expect(finalReply).not.toContain('工作目录');
    expect(finalReply).not.toContain('关联飞书上传文件');
    expect(finalReply).not.toContain('succeeded in 0ms');
  });

  it('hides related-task filesystem scans from Feishu replies', () => {
    const reply = formatFeishuReply([
      '任务 #task_related 已创建：找一下之前那份自学习报告',
      '→ 正在执行任务 #task_related...',
      '+ Executor: codex-cli｜#task_related｜已启动 codex-cli 执行器',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] /home/ylfego/Program/metaclaw/metaclaw-tasks/task_vswMcy2tHw/feishu-document.md',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] /home/ylfego/Program/metaclaw/metaclaw-tasks/task_wcFQ0b3DGm/artifact-note.md',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] /home/ylfego/Program/metaclaw/metaclaw-tasks/task_wltujOLX_H/artifact-note.md',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] exec',
      `+ Executor: codex-cli｜#task_related｜[codex-cli] /bin/bash -lc "find /home/ylfego/Program/metaclaw -path 'task_VezBimwFQ' -maxdepth 5 -type f -o -path 'task_VezBimwFQ' -maxdepth 5 -type d" in /home/ylfego/Program/metaclaw`,
      '+ Executor: codex-cli｜#task_related｜[codex-cli] succeeded in 0ms:',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] /home/ylfego/Program/metaclaw/metaclaw-tasks/task_VezBimwFQ',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] /home/ylfego/Program/metaclaw/metaclaw-tasks/task_VezBimwFQ/metaclaw_self_learning_executor_research.md',
      '+ Executor: codex-cli｜#task_related｜[codex-cli] 已找到原任务本地 Markdown，接下来会作为本次任务产物放入目标目录。',
      '✓ 任务完成 (4.2s)',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: 已找到相关任务并定位到原始 Markdown 文档。',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(reply).toBe('已找到相关任务并定位到原始 Markdown 文档。');
    expect(reply).not.toContain('[codex-cli]');
    expect(reply).not.toContain('/home/ylfego/Program/metaclaw/metaclaw-tasks');
    expect(reply).not.toContain('/bin/bash');
    expect(reply).not.toContain('find /home/ylfego');
    expect(reply).not.toContain('succeeded in 0ms');
  });

  it('uploads every generated artifact file back to Feishu as browsable file messages', async () => {
    const repoDir = mkdtempSync(resolve(tmpdir(), 'metaclaw-feishu-artifacts-'));
    const taskDir = resolve(repoDir, 'metaclaw-tasks', 'task_doc');
    mkdirSync(taskDir, { recursive: true });
    const reportPath = resolve(taskDir, 'report.md');
    const sheetPath = resolve(taskDir, 'data.csv');
    writeFileSync(reportPath, '# Report\n正文', 'utf-8');
    writeFileSync(sheetPath, 'a,b\n1,2\n', 'utf-8');

    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 生成文件',
            '任务 #task_doc 已创建：生成文件',
            '+ Executor: codex-cli｜#task_doc｜已启动 codex-cli 执行器',
            '+ Executor: codex-cli｜#task_doc｜文件已生成。',
            '+ Executor: codex-cli｜#task_doc｜tokens used',
            '+ Executor: codex-cli｜#task_doc｜123',
            '✓ 任务完成 (3.1s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 文件已生成。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            `→ 文件输出目录: ${taskDir}`,
            '→ 已省略文件正文输出，请直接查看生成文件',
            '→ 已记录 2 个任务产物',
            `   - ${reportPath}`,
            `   - ${sheetPath}`,
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn()
        .mockResolvedValueOnce('file_key_report')
        .mockResolvedValueOnce('file_key_sheet'),
      sendFileToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_files',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"生成文件"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
      markdownPreview: {
        baseUrl: 'https://preview.example.com',
        workspaceRoot: repoDir,
      },
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', [
      '**任务产物已同步到飞书**',
      '- report.md',
      '- data.csv',
    ].join('\n'));
    expect(client.uploadFile).toHaveBeenNthCalledWith(1, reportPath);
    expect(client.uploadFile).toHaveBeenNthCalledWith(2, sheetPath);
    expect(client.sendFileToChat).toHaveBeenNthCalledWith(1, 'oc_chat', 'file_key_report');
    expect(client.sendFileToChat).toHaveBeenNthCalledWith(2, 'oc_chat', 'file_key_sheet');
  });

  it('sends long Feishu replies in multiple ordered messages without dropping content', async () => {
    const longAnswer = [
      `${'甲'.repeat(1800)}`,
      `${'乙'.repeat(1800)}`,
      `${'丙'.repeat(900)}`,
    ].join('\n');
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 请完整输出长内容',
            '任务 #task_long 已创建：请完整输出长内容',
            '+ Executor: codex-cli｜#task_long｜已启动 codex-cli 执行器',
            ...longAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_long｜${line}`),
            '+ Executor: codex-cli｜#task_long｜tokens used',
            '+ Executor: codex-cli｜#task_long｜1,234',
            '✓ 任务完成 (12.4s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            `│ 摘要: ${longAnswer.slice(0, 30)}...`,
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_long',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"请完整输出长内容"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts[0]).toBe([
      '**处理步骤**',
      '→ 任务 #task_long 已创建：请完整输出长内容',
      '→ Executor: codex-cli 已启动执行器',
      '✓ 任务完成 (12.4s)',
    ].join('\n'));
    expect(sentTexts.slice(1).join('')).toBe(longAnswer);
    expect(sentTexts.every(text => text.length <= 1200)).toBe(true);
    expect(sentTexts.join('')).not.toContain('[已截断]');
  });

  it('splits final Feishu replies at safe boundaries instead of cutting Markdown phrases', async () => {
    const lead = [
      'MetaClaw 桌面端的特殊定位应该是：',
      '',
      '企业级本地执行器，不是桌面聊天机器人。',
      '',
      '它的核心价值不是让用户在桌面上和 AI 聊天，而是让 MetaClaw 能进入真实工作现场：员工电脑、本地文件、浏览器、Office、飞书、企业内网系统、VPN、截图、剪贴板、表格、邮件、审批页面等，把云端 Agent 的计划变成端侧可执行动作。',
      '',
      '一句话定位可以是：',
      '',
    ].join('\n');
    const padding = '这段补充说明用于把分片边界推到关键 Markdown 短语附近，确保飞书不会把粗体英文定位切成半截。'.repeat(8);
    const fullAnswer = [
      lead,
      padding,
      '',
      '**MetaClaw Desktop Runtime / 企业 Agent 执行节点。**',
      '',
      '1. **端侧 Executor**',
      '桌面端负责执行本地动作：打开文件、读写表格、操作浏览器、调用本地 CLI、访问内网系统。',
      '',
      '2. **企业工作现场接管器**',
      '很多企业系统没有 API，或者 API 权限难批。桌面端可以通过 UI 自动化完成最后一公里执行。',
      '',
      '3. **安全边界代理**',
      '敏感数据不一定全部上传云端，桌面端可以做本地解析、本地脱敏和本地权限判断。',
    ].join('\n');
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> MetaClaw 桌面端定位',
            '任务 #task_desktop 已创建：MetaClaw 桌面端定位',
            '+ Executor: codex-cli｜#task_desktop｜已启动 codex-cli 执行器',
            ...fullAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_desktop｜${line}`),
            '+ Executor: codex-cli｜#task_desktop｜tokens used',
            '+ Executor: codex-cli｜#task_desktop｜1,234',
            '✓ 任务完成 (68.0s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: MetaClaw 桌面端的特殊定位应该是企业级本地执行器。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_desktop',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"MetaClaw 桌面端定位"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const finalTexts = client.sendMarkdownCardToChat.mock.calls
      .map(([, text]) => text)
      .filter(text => typeof text === 'string' && !text.startsWith('**处理步骤**'));
    expect(finalTexts.join('')).toBe(fullAnswer);
    expect(finalTexts.some(text => text.endsWith('**MetaClaw Des'))).toBe(false);
    expect(finalTexts.join('\n')).toContain('3. **安全边界代理**');
  });

  it('delivers complete Markdown final answers through Feishu cards in the handler path', async () => {
    const fullAnswer = [
      '我换一种方式讲：**你们的知识管理产品不要把自己定义成“文档管理/知识库”，而要定义成“企业业务决策系统的知识底座”。**',
      '',
      '可以分成三层来看。',
      '',
      '**第一层：飞书式知识管理**',
      '飞书做的是信息管理。',
      '',
      '**第二层：Ontology / 业务对象建模**',
      'Ontology 系统回答的是业务世界现在是什么状态，接下来会发生什么，我该做什么。',
      '',
      '**第三层：决策与行动**',
      '真正有价值的不是知识本身，而是知识进入业务决策。',
      '',
      '一句话总结差异：飞书帮助企业把信息组织起来；你们应该帮助企业把业务世界建模出来，并驱动决策和执行。',
    ].join('\n');
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 详细解释知识管理定位',
            '任务 #task_knowledge 已创建：详细解释知识管理定位',
            '+ Executor: codex-cli｜#task_knowledge｜已启动 codex-cli 执行器',
            ...fullAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_knowledge｜${line}`),
            '+ Executor: codex-cli｜#task_knowledge｜tokens used',
            '+ Executor: codex-cli｜#task_knowledge｜1,548',
            '✓ 任务完成 (68.0s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 你们的知识管理产品应该定义成企业业务决策系统的知识底座。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
      sendMarkdownPostToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_knowledge',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"详细解释知识管理定位"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const cardTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(cardTexts.join('\n')).toContain('**处理步骤**');
    expect(cardTexts).toContain(fullAnswer);
    expect(cardTexts.join('\n')).toContain('**第二层：Ontology / 业务对象建模**');
    expect(cardTexts.join('\n')).toContain('**第三层：决策与行动**');
    expect(client.sendMarkdownPostToChat).not.toHaveBeenCalled();
  });

  it('falls back to Feishu rich text when one Markdown card chunk fails and still sends later chunks', async () => {
    const fullAnswer = [
      '第一段必须送达。'.repeat(120),
      '第二段也必须送达，不能因为前一段富文本失败而丢失。'.repeat(80),
    ].join('\n\n');
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 完整输出长答案',
            '任务 #task_chunks 已创建：完整输出长答案',
            '+ Executor: codex-cli｜#task_chunks｜已启动 codex-cli 执行器',
            ...fullAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_chunks｜${line}`),
            '+ Executor: codex-cli｜#task_chunks｜tokens used',
            '+ Executor: codex-cli｜#task_chunks｜1,548',
            '✓ 任务完成 (68.0s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 第一段必须送达。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('card chunk rejected'))
        .mockResolvedValue(undefined),
      sendMarkdownPostToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_chunk_fallback',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"完整输出长答案"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const cardChunks = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    const postChunks = client.sendMarkdownPostToChat.mock.calls.map(([, text]) => text);
    expect(postChunks.join('\n')).toContain('第一段必须送达');
    expect(cardChunks.join('\n')).toContain('第二段也必须送达');
    expect(session.appendSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('回发失败，改用富文本'),
    );
  });

  it('sends the complete final answer as a file when any reply chunk cannot be delivered', async () => {
    const fullAnswer = [
      '第一段必须送达。'.repeat(120),
      '第二段也必须送达，不能因为前一段失败而丢失。'.repeat(80),
    ].join('\n\n');
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 完整输出长答案',
            '任务 #task_file_fallback 已创建：完整输出长答案',
            '+ Executor: codex-cli｜#task_file_fallback｜已启动 codex-cli 执行器',
            ...fullAnswer.split('\n').map(line => `+ Executor: codex-cli｜#task_file_fallback｜${line}`),
            '+ Executor: codex-cli｜#task_file_fallback｜tokens used',
            '+ Executor: codex-cli｜#task_file_fallback｜1,548',
            '✓ 任务完成 (68.0s)',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: 第一段必须送达。',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('card chunk rejected'))
        .mockResolvedValue(undefined),
      sendMarkdownPostToChat: vi.fn()
        .mockRejectedValueOnce(new Error('post chunk rejected'))
        .mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue('file_key_full_reply'),
      sendFileToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_file_fallback',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"完整输出长答案"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text).join('\n'))
      .toContain('下面将同步完整答案文件');
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    const uploadedPath = client.uploadFile.mock.calls[0]?.[0] as string;
    expect(readFileSync(uploadedPath, 'utf-8')).toBe(`${fullAnswer}\n`);
    expect(client.sendFileToChat).toHaveBeenCalledWith('oc_chat', 'file_key_full_reply');
  });

  it('keeps Feishu replies scoped to the submitted task across urgent preemption and resume', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 紧急优先处理客户问题',
            '任务 #task_urgent 已创建：紧急优先处理客户问题',
            '→ 抢占当前任务 #task_main',
            '→ 正在执行任务 #task_urgent...',
            '+ Executor: codex-cli｜#task_urgent｜已启动 codex-cli 执行器',
            '+ Executor: codex-cli｜#task_urgent｜urgent raw should be ignored because appended result is complete',
            '✓ 任务完成 (0.4s)',
            '',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: urgent summary only',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '',
            'urgent full line 1',
            'urgent full line 2',
            '→ 正在执行任务 #task_main...',
            '+ Executor: codex-cli｜#task_main｜已启动 codex-cli 执行器',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_urgent',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"紧急优先处理客户问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('urgent full line 1\nurgent full line 2');
    expect(sentTexts.join('\n')).not.toContain('urgent summary only');
    expect(sentTexts.join('\n')).not.toContain('task_main');
  });

  it('replies as soon as the urgent Feishu task completes without waiting for resumed original output', async () => {
    let listener: ((snapshot: { output: string[] }) => void) | undefined;
    const output = ['before'];
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listener = callback;
        callback({ output: [...output] });
        return vi.fn();
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_urgent_async',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"紧急优先处理客户问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await Promise.resolve();
    output.push(
      '> 紧急优先处理客户问题',
      '任务 #task_urgent 已创建：紧急优先处理客户问题',
      '→ 抢占当前任务 #task_main',
      '→ 正在执行任务 #task_urgent...',
      '✓ 任务完成 (0.4s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: urgent summary only',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      'urgent full line 1',
      'urgent full line 2',
      '→ 正在执行任务 #task_main...',
    );
    listener?.({ output: [...output] });
    resolveSubmit();
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('urgent full line 1\nurgent full line 2');
    expect(sentTexts.join('\n')).not.toContain('urgent summary only');
    expect(sentTexts.join('\n')).not.toContain('task_main');

    output.push('main result should arrive too late for urgent reply');
    listener?.({ output: [...output] });
    expect(client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text).join('\n'))
      .not.toContain('main result should arrive too late');
  });

  it('waits longer than ten minutes for long research tasks before sending the final Feishu reply', async () => {
    vi.useFakeTimers();
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const output = ['before'];
    const notify = () => {
      for (const listener of listeners) {
        listener({ output: [...output] });
      }
    };
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listeners.add(callback);
        callback({ output: [...output] });
        return () => {
          listeners.delete(callback);
        };
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_long_research',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"帮我做一个长调研"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(client.removeReactionFromMessage).not.toHaveBeenCalled();

    output.push(
      '> 帮我做一个长调研',
      '任务 #task_long 已创建：帮我做一个长调研',
      '→ 路由决策：调研竞速 (auto_dispatch, confidence=0.97)',
      '→ 正在执行任务 #task_long...',
      '✓ 任务完成 (650.0s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: long research final summary',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      'long research full answer',
    );
    notify();
    resolveSubmit();
    await vi.advanceTimersByTimeAsync(301);
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('long research full answer');
    expect(client.removeReactionFromMessage).toHaveBeenCalledWith('om_message_long_research', 'reaction_typing');
  });

  it('waits for terminal output to settle before sending the final Feishu answer', async () => {
    vi.useFakeTimers();
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const output = ['before'];
    const notify = () => {
      for (const listener of listeners) {
        listener({ output: [...output] });
      }
    };
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listeners.add(callback);
        callback({ output: [...output] });
        return () => {
          listeners.delete(callback);
        };
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_settle',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"MetaClaw 是否应该做桌面版"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await Promise.resolve();
    output.push(
      '> MetaClaw 是否应该做桌面版',
      '任务 #task_settle 已创建：MetaClaw 是否应该做桌面版',
      '→ 正在执行任务 #task_settle...',
      '+ Executor: codex-cli｜#task_settle｜已启动 codex-cli 执行器',
      '+ Executor: codex-cli｜#task_settle｜我判断：MetaClaw 应该做桌面版，但不能做成“又一个聊天客户端”。',
      '✓ 任务完成 (68.0s)',
    );
    notify();
    await vi.advanceTimersByTimeAsync(250);
    expect(client.sendMarkdownCardToChat).not.toHaveBeenCalledWith(
      'oc_chat',
      expect.stringContaining('我判断：MetaClaw 应该做桌面版'),
    );

    output.push(
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: MetaClaw 应该做桌面版，但定位应是企业级 Desktop Agent Runtime。',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      '我判断：MetaClaw 应该做桌面版，但不能做成“又一个聊天客户端”，而应该做成企业级 Desktop Agent Runtime / 桌面执行器。',
      '',
      '完整结论：桌面版要解决本地文件读写、长任务、权限治理、Executor 管理和企业协作。',
      '',
      '后续建议：优先做后台常驻运行时、任务面板、授权面板和飞书/Terminal 双通道一致展示。',
    );
    notify();
    resolveSubmit();
    await vi.advanceTimersByTimeAsync(301);
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('完整结论：桌面版要解决本地文件读写');
    expect(sentTexts.join('\n')).toContain('后续建议：优先做后台常驻运行时');
  });

  it('streams resumed task guidance to Feishu after an urgent task completes', async () => {
    const listeners = new Set<(snapshot: { output: string[] }) => void>();
    const output = ['before'];
    const notify = () => {
      for (const listener of listeners) {
        listener({ output: [...output] });
      }
    };
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<{ exitRequested: false }>(resolve => {
      resolveSubmit = () => resolve({ exitRequested: false });
    });
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((callback: (snapshot: { output: string[] }) => void) => {
        listeners.add(callback);
        callback({ output: [...output] });
        return () => {
          listeners.delete(callback);
        };
      }),
      submit: vi.fn().mockImplementation(() => submitPromise),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    const handled = handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_urgent_resume_guidance',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"紧急优先处理客户问题"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    await Promise.resolve();
    output.push(
      '> 紧急优先处理客户问题',
      '任务 #task_urgent 已创建：紧急优先处理客户问题',
      '→ 抢占当前任务 #task_main',
      '→ 正在执行任务 #task_urgent...',
      '✓ 任务完成 (0.4s)',
      '',
      '┌─ 任务结果 ───────────────────────────────────────┐',
      '│ 摘要: urgent summary only',
      '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
      '└──────────────────────────────────────────────────┘',
      '',
      'urgent full line 1',
      'urgent full line 2',
      '┌─ 操作指引 ───────────────────────────────────────┐',
      '│ 场景：恢复已挂起任务',
      '│ 推荐动作：继续处理任务 #task_main: 之前的长任务',
      '│ 目标任务：#task_main 之前的长任务',
      '│ 原因：刚被高优任务打断，恢复连续性收益最高',
      '│       下一步已明确：恢复后继续当前未完成步骤',
      '└──────────────────────────────────────────────────┘',
      '→ 正在执行任务 #task_main...',
      '+ Executor: codex-cli｜#task_main｜old task output must not leak into urgent reply',
    );
    notify();
    resolveSubmit();
    await handled;

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    const allSent = sentTexts.join('\n');
    expect(allSent).toContain('urgent full line 1\nurgent full line 2');
    expect(allSent).toContain([
      '**恢复已挂起任务**',
      '→ 继续处理任务 #task_main: 之前的长任务',
      '任务：#task_main 之前的长任务',
      '- 刚被高优任务打断，恢复连续性收益最高',
      '- 下一步已明确：恢复后继续当前未完成步骤',
    ].join('\n'));
    expect(allSent).not.toContain('urgent summary only');
    expect(allSent).not.toContain('old task output must not leak');
  });

  it('keeps resumed Feishu replies scoped to the resumed task instead of the later latest task', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 继续刚才主线任务',
            '→ 命中上次任务指针 #task_main',
            '→ 正在执行任务 #task_main...',
            '+ Executor: codex-cli｜#task_main｜已启动 codex-cli 执行器',
            '✓ 任务完成 (0.8s)',
            '',
            '┌─ 任务结果 ───────────────────────────────────────┐',
            '│ 摘要: main summary only',
            '│ 下一步: 如需继续，可基于当前结果继续创建 follow-up 任务',
            '└──────────────────────────────────────────────────┘',
            '',
            'main full line 1',
            'main full line 2',
            '任务 #task_later 已创建：后续排队任务',
            '→ 正在执行任务 #task_later...',
            '+ Executor: codex-cli｜#task_later｜已启动 codex-cli 执行器',
            '+ Executor: codex-cli｜#task_later｜later output must not leak',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_resume',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"继续刚才主线任务"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts.join('\n')).toContain('main full line 1\nmain full line 2');
    expect(sentTexts.join('\n')).not.toContain('main summary only');
    expect(sentTexts.join('\n')).not.toContain('later output must not leak');
  });

  it('continues processing when the typing reaction cannot be added', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({ output: ['before', 'metaclaw reply'] }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockRejectedValue(new Error('missing reaction permission')),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"hello metaclaw"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(session.appendSystemMessage).toHaveBeenCalledWith('⚠️ 飞书 Typing 表情添加失败: missing reaction permission');
    expect(session.submit).toHaveBeenCalledWith('hello metaclaw', { awaitAsyncWork: true });
    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith('oc_chat', 'metaclaw reply');
    expect(client.removeReactionFromMessage).not.toHaveBeenCalled();
  });

  it('does not send a fallback reply when Metaclaw has no user-facing output yet', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 帮我分析 OPC 方案',
            '任务 #task_empty 已创建：帮我分析 OPC 方案',
            '→ 派发给 codex-cli...',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_empty',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"帮我分析 OPC 方案"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).not.toHaveBeenCalled();
    expect(client.removeReactionFromMessage).toHaveBeenCalledWith('om_message_empty', 'reaction_typing');
  });

  it('replies with an explicit pending message when the task is queued', async () => {
    const session = {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ output: ['before'] })
        .mockReturnValueOnce({
          output: [
            'before',
            '> 帮我分析 OPC 方案',
            '任务 #task_queued 已创建：帮我分析 OPC 方案',
            '→ 任务 #task_queued 已进入待执行队列',
          ],
        }),
      submit: vi.fn().mockResolvedValue({ exitRequested: false }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_queued',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"帮我分析 OPC 方案"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    expect(client.sendMarkdownCardToChat).toHaveBeenCalledWith(
      'oc_chat',
      '任务 #task_queued 已进入待执行队列，等待当前任务完成后会继续执行。',
    );
    expect(client.sendMarkdownCardToChat).not.toHaveBeenCalledWith('oc_chat', '已处理。');
  });

  it('waits for the final answer after a queued task later completes', async () => {
    let output = ['before'];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    const append = (...lines: string[]) => {
      output = [...output, ...lines];
      listener?.({ output: [...output] });
    };
    const session = {
      getSnapshot: vi.fn(() => ({ output: [...output] })),
      subscribe: vi.fn((next: (snapshot: { output: string[] }) => void) => {
        listener = next;
        next({ output: [...output] });
        return () => {
          listener = null;
        };
      }),
      submit: vi.fn().mockImplementation(async () => {
        append(
          '> 云文档的预览版也生成一下。',
          '任务 #task_queued_done 已创建：云文档的预览版也生成一下。',
          '→ 任务 #task_queued_done 已进入待执行队列',
        );
        await new Promise(resolve => setTimeout(resolve, 5));
        append(
          '→ 正在执行任务 #task_queued_done...',
          '✓ 任务完成 (1.0s)',
          '',
          '┌─ 任务结果 ───────────────────────────────────────┐',
          '│ 摘要: 已生成云文档预览版 Markdown 文件。',
          '│ 下一步: 可同步飞书并追加在线预览链接',
          '└──────────────────────────────────────────────────┘',
          '',
          '已生成云文档预览版 Markdown 文件，后端可据此同步飞书并追加在线预览链接。',
        );
        return { exitRequested: false };
      }),
      appendSystemMessage: vi.fn(),
    };
    const client = {
      addReactionToMessage: vi.fn().mockResolvedValue('reaction_typing'),
      removeReactionFromMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownCardToChat: vi.fn().mockResolvedValue(undefined),
    };

    await handleFeishuMessageEvent({
      message: {
        message_id: 'om_message_queued_done',
        chat_id: 'oc_chat',
        message_type: 'text',
        content: '{"text":"云文档的预览版也生成一下。"}',
      },
    }, {
      session,
      client,
      seenMessageIds: new Set<string>(),
    });

    const sentTexts = client.sendMarkdownCardToChat.mock.calls.map(([, text]) => text);
    expect(sentTexts).toContain('已生成云文档预览版 Markdown 文件，后端可据此同步飞书并追加在线预览链接。');
    expect(sentTexts).not.toContain('任务 #task_queued_done 已进入待执行队列，等待当前任务完成后会继续执行。');
  });

  it('can format plain conversation output without task result framing', () => {
    expect(formatFeishuReply(['> 你好', '你好，我在。'])).toBe('你好，我在。');
  });

  it('formats core progress steps separately from the final Feishu answer', () => {
    expect(formatFeishuProgressReply([
      '> 今天早上都执行了什么任务',
      '任务 #task_OO0EG38SJo 已创建：今天早上都执行了什么任务',
      '【提取最近历史记录上下文】',
      '→ 派发给 codex-cli...',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)',
      '→ 原因：research_workflow / research',
      '+ Executor: pi-agent｜#task_OO0EG38SJo｜已启动 pi-agent 执行器',
      '→ 正在执行任务 #task_OO0EG38SJo...',
      '✓ 任务完成 (8.1s)',
      '最终答案',
    ])).toBe([
      '**处理步骤**',
      '→ 任务 #task_OO0EG38SJo 已创建：今天早上都执行了什么任务',
      '【提取最近历史记录上下文】',
      '→ 发送给 codex-cli 进行意图解析与执行准备',
      '【构建执行上下文】',
      '【执行上下文准备完成】',
      '→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)',
      '→ 原因：research_workflow / research',
      '→ Executor: pi-agent 已启动执行器',
      '→ 正在执行任务 #task_OO0EG38SJo...',
      '✓ 任务完成 (8.1s)',
    ].join('\n'));
  });

  it('formats new MetaClaw and Executor progress protocol without losing the final answer', () => {
    const outputLines = [
      '> 汇总一下当前进展',
      '任务 #task_protocol 已创建：汇总一下当前进展',
      '【MetaClaw｜理解用户请求】',
      '→ MetaClaw：已识别可执行任务',
      '→ MetaClaw：执行策略：创建可追踪任务并派发给 codex-cli',
      '【Executor: codex-cli｜派发准备】',
      '→ Executor: codex-cli 将处理该任务',
      '【MetaClaw｜提取最近历史记录上下文】',
      '→ MetaClaw：正在回忆任务 #task_protocol 的上下文...',
      '【MetaClaw｜构建执行上下文】',
      '→ MetaClaw：执行上下文已准备完成',
      '【MetaClaw｜执行上下文准备完成】',
      '→ MetaClaw：路由决策：codex-cli (auto_dispatch, confidence=0.91)',
      '→ MetaClaw：原因：implementation / code',
      '【Executor: codex-cli｜执行】',
      '→ Executor: codex-cli 开始执行任务 #task_protocol',
      '· Executor: codex-cli｜#task_protocol｜已启动 codex-cli 执行器',
      '· Executor: codex-cli｜#task_protocol｜最终答案第一行',
      '· Executor: codex-cli｜#task_protocol｜',
      '· Executor: codex-cli｜#task_protocol｜最终答案第二行',
      '· Executor: codex-cli｜#task_protocol｜tokens used',
      '· Executor: codex-cli｜#task_protocol｜88',
      '✓ 任务完成 (2.4s)',
    ];

    expect(formatFeishuProgressReply(outputLines)).toBe([
      '**处理步骤**',
      '→ 任务 #task_protocol 已创建：汇总一下当前进展',
      '【MetaClaw｜理解用户请求】',
      '→ MetaClaw：已识别可执行任务',
      '→ MetaClaw：执行策略：创建可追踪任务并派发给 codex-cli',
      '【Executor: codex-cli｜派发准备】',
      '→ Executor: codex-cli 将处理该任务',
      '【MetaClaw｜提取最近历史记录上下文】',
      '→ MetaClaw：正在回忆任务 #task_protocol 的上下文...',
      '【MetaClaw｜构建执行上下文】',
      '→ MetaClaw：执行上下文已准备完成',
      '【MetaClaw｜执行上下文准备完成】',
      '→ MetaClaw：路由决策：codex-cli (auto_dispatch, confidence=0.91)',
      '→ MetaClaw：原因：implementation / code',
      '【Executor: codex-cli｜执行】',
      '→ Executor: codex-cli 开始执行任务 #task_protocol',
      '→ Executor: codex-cli 已启动执行器',
      '✓ 任务完成 (2.4s)',
    ].join('\n'));
    expect(formatFeishuReply(outputLines)).toBe('最终答案第一行\n\n最终答案第二行');
  });

  it('prefers all new Executor final-result blocks and ignores internal process output', () => {
    expect(formatFeishuReply([
      '> 处理两个部分',
      '内部工具调用',
      '【Executor: codex-cli｜最终结果｜#task_protocol / #subtask_a】\n第一部分\n完整结果',
      'tokens used 88',
      '【Executor: codex-cli｜最终结果｜#task_protocol / #subtask_b】\n第二部分',
      '✓ 任务完成 (2.4s)',
    ])).toBe('第一部分\n完整结果\n\n第二部分');
  });

  it('renders the simplified shared session projection without internal planning diagnostics', () => {
    const outputLines = [
      '> 汇总一下当前进展',
      '【MetaClaw｜理解用户请求】',
      '【MetaClaw｜提取最近历史记录上下文】',
      '【MetaClaw｜构建执行上下文】',
      '【MetaClaw｜执行上下文准备完成】',
      '【Executor: codex-cli｜派发准备】',
      '→ Executor: codex-cli 将处理该任务',
      '【Executor: codex-cli｜最终结果｜#task_protocol / #subtask_a】\n最终答案',
      '✓ 任务完成 (2.4s)',
    ];

    const progress = formatFeishuProgressReply(outputLines);
    expect(progress).toContain('【MetaClaw｜理解用户请求】');
    expect(progress).toContain('【Executor: codex-cli｜派发准备】');
    expect(progress).toContain('→ Executor: codex-cli 将处理该任务');
    expect(progress).not.toContain('PlanningAgent:');
    expect(progress).not.toContain('ControlKernel:');
    expect(progress).not.toContain('Runtime:');
    expect(formatFeishuReply(outputLines)).toBe('最终答案');
  });

  it('formats direct-reply conversation progress for Feishu', () => {
    expect(formatFeishuProgressReply([
      '> 这跟刚才那个结论有什么关系？',
      '【MetaClaw｜理解用户请求】',
      '→ MetaClaw：已识别普通对话',
      '→ MetaClaw：执行策略：直接回答，不创建任务',
      '→ MetaClaw：由 PlanningAgent 直接作答',
      '最终回答',
    ])).toBe([
      '**处理步骤**',
      '【MetaClaw｜理解用户请求】',
      '→ MetaClaw：已识别普通对话',
      '→ MetaClaw：执行策略：直接回答，不创建任务',
      '→ MetaClaw：由 PlanningAgent 直接作答',
    ].join('\n'));
  });

  it('formats streaming progress replies as one card per newly observed step', () => {
    const sent = new Set<string>();
    expect(formatFeishuStreamingProgressReplies([
      '任务 #task_stream 已创建：测试',
      '任务 #task_stream 已创建：测试',
      '【提取最近历史记录上下文】',
    ], sent)).toEqual([
      [
        '**处理步骤**',
        '→ 任务 #task_stream 已创建：测试',
        '【提取最近历史记录上下文】',
      ].join('\n'),
    ]);
    expect(formatFeishuStreamingProgressReplies([
      '【提取最近历史记录上下文】',
      '→ 派发给 codex-cli...',
    ], sent)).toEqual([
      '**处理步骤**\n→ 发送给 codex-cli 进行意图解析与执行准备',
    ]);
  });

  it('streams executor routing details to Feishu so users see the real executor', () => {
    const sent = new Set<string>();
    expect(formatFeishuStreamingProgressReplies([
      '→ 派发给 codex-cli...',
      '→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)',
      '→ 原因：research_workflow / research',
      '+ Executor: pi-agent｜#task_research｜已启动 pi-agent 执行器',
    ], sent)).toEqual([
      [
        '**处理步骤**',
        '→ 发送给 codex-cli 进行意图解析与执行准备',
        '→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)',
        '→ 原因：research_workflow / research',
        '→ Executor: pi-agent 已启动执行器',
      ].join('\n'),
    ]);
  });

  it('streams executor failure terminal state to Feishu progress cards', () => {
    const sent = new Set<string>();
    expect(formatFeishuStreamingProgressReplies([
      '任务 #task_fail 已创建：调研失败展示',
      '→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)',
      '→ 原因：research_workflow / research + reporting',
      '→ 正在执行任务 #task_fail...',
      '+ Executor: pi-agent｜#task_fail｜已启动 pi-agent 执行器',
      '✗ 执行失败: executor idle timeout',
      '→ 任务 #task_fail 已转为阻塞；执行器长时间没有输出或状态变化，可能卡住。',
    ], sent)).toEqual([
      [
        '**处理步骤**',
        '→ 任务 #task_fail 已创建：调研失败展示',
        '→ 路由决策：pi-agent (auto_dispatch, confidence=0.97)',
        '→ 原因：research_workflow / research + reporting',
        '→ 正在执行任务 #task_fail...',
        '→ Executor: pi-agent 已启动执行器',
        '✗ 执行失败: executor idle timeout',
        '→ 任务 #task_fail 已转为阻塞；执行器长时间没有输出或状态变化，可能卡住。',
      ].join('\n'),
    ]);
  });

  it('streams resumed task guidance blocks to Feishu before the final result', () => {
    const sent = new Set<string>();
    const replies = formatFeishuStreamingProgressReplies([
      '┌─ 操作指引 ───────────────────────────────────────┐',
      '│ 场景：恢复已挂起任务',
      '│ 推荐动作：继续处理任务 #task_main: DeepSeek 最近更新汇总',
      '│ 目标任务：#task_main DeepSeek 最近更新汇总',
      '│ 原因：刚被高优任务打断，恢复连续性收益最高',
      '│       下一步已明确：恢复后继续当前未完成步骤',
      '└──────────────────────────────────────────────────┘',
      '【提取最近历史记录上下文】',
    ], sent);

    expect(replies[0]).toBe([
      '**恢复已挂起任务**',
      '→ 继续处理任务 #task_main: DeepSeek 最近更新汇总',
      '任务：#task_main DeepSeek 最近更新汇总',
      '- 刚被高优任务打断，恢复连续性收益最高',
      '- 下一步已明确：恢复后继续当前未完成步骤',
    ].join('\n'));
    expect(replies[1]).toBe('**处理步骤**\n【提取最近历史记录上下文】');
  });

  it('streams memory recall decisions to Feishu as progress blocks', () => {
    const replies = formatFeishuStreamingProgressReplies([
      '┌─ 已自动采用记忆 ─────────────────────────────────┐',
      '│ 当前任务：#task_geo GEO 调研报告',
      '│ - pref_geo: 默认联网搜索并生成飞书云文档 score=1.00',
      '│   reason=命中主体：GEO',
      '└──────────────────────────────────────────────────┘',
      '┌─ 已跳过不确定记忆 ───────────────────────────────┐',
      '│ 当前任务：#task_geo GEO 调研报告',
      '│ 策略：无需用户确认；无法确定适用的召回默认不注入执行上下文',
      '│ 跳过：1 条偏好，0 条任务记忆',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(replies).toEqual([
      [
        '**记忆召回自动采用**',
        '任务：#task_geo GEO 调研报告',
        '- pref_geo: 默认联网搜索并生成飞书云文档 score=1.00',
        '  原因：命中主体：GEO',
      ].join('\n'),
      [
        '**记忆召回已跳过**',
        '任务：#task_geo GEO 调研报告',
        '- 无需用户确认；无法确定适用的召回默认不注入执行上下文',
        '- 跳过：1 条偏好，0 条任务记忆',
      ].join('\n'),
    ]);
  });

  it('streams task queue snapshots to Feishu as progress blocks', () => {
    const replies = formatFeishuStreamingProgressReplies([
      '┌─ 任务队列前五 ───────────────────────────────────┐',
      '│ 触发：高优任务抢占，队列已重排',
      '│ 总览：执行中 1 / 待执行 2 / 挂起 1 / 阻塞 0',
      '│ 1. [执行中] #task_urgent 插入紧急任务 | 优先级 44.0 | 正在执行 | 进度 10% | 语义优先级：用户要求优先处理',
      '│ 2. [挂起] #task_main 原始调研任务 | 优先级 32.0 | 第 1 顺位 | 进度 70% | 挂起任务已满足执行条件，恢复连续性收益最高',
      '└──────────────────────────────────────────────────┘',
    ]);

    expect(replies).toEqual([
      [
        '**任务队列前五**',
        '触发：高优任务抢占，队列已重排',
        '总览：执行中 1 / 待执行 2 / 挂起 1 / 阻塞 0',
        '- 1. [执行中] #task_urgent 插入紧急任务 | 优先级 44.0 | 正在执行 | 进度 10% | 语义优先级：用户要求优先处理',
        '- 2. [挂起] #task_main 原始调研任务 | 优先级 32.0 | 第 1 顺位 | 进度 70% | 挂起任务已满足执行条件，恢复连续性收益最高',
      ].join('\n'),
    ]);
  });

});
