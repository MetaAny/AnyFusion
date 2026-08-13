import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { dirname, extname, join } from 'path';
import type { Config } from '../core/types.js';
import { loadEnvFileIfExists } from './env-file.js';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Config = {
  version: 1,
  executor: {
    command: 'codex',
    timeout: 300,
    max_duration: 3600,
  },
  orchestration: {
    reminder_enabled: true,
    reminder_throttle: 300,
    top_k_preferences: 5,
    blocked_recheck_enabled: true,
    blocked_recheck_interval: 60,
    max_concurrent_attempts: 4,
  },
  ui: {
    language: 'zh-CN',
    dashboard_on_start: true,
  },
  notifications: {
    feishu: {
      enabled: false,
    },
  },
  integrations: {
    markdown_preview: {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    },
  },
  gateway: {
    enabled: false,
    platforms: {
      feishu: {
        enabled: false,
        domain: 'feishu',
        connection_mode: 'websocket',
        app_secret_env: 'FEISHU_APP_SECRET',
        event_port: 8787,
        event_path: '/feishu/events',
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
        },
      },
    },
  },
};

/**
 * 加载配置文件
 */
export function loadConfig(configPath: string): Config {
  loadEnvFileIfExists(join(dirname(configPath), '.env'));
  const resolvedConfigPath = resolveExistingConfigPath(configPath);
  if (!resolvedConfigPath) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(resolvedConfigPath, 'utf-8');
    const userConfig = load(content) as Partial<Config>;
    const defaultFeishuConfig = DEFAULT_CONFIG.notifications?.feishu ?? { enabled: false };
    const defaultMarkdownPreviewConfig = DEFAULT_CONFIG.integrations?.markdown_preview ?? {
      enabled: true,
      host: '127.0.0.1',
      port: 8790,
    };
    const defaultGatewayFeishuConfig = DEFAULT_CONFIG.gateway?.platforms?.feishu ?? {
      enabled: false,
      domain: 'feishu',
      connection_mode: 'websocket',
      app_secret_env: 'FEISHU_APP_SECRET',
      event_port: 8787,
      event_path: '/feishu/events',
    };


    // 深度合并配置
    const mergedConfig: Config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      executor: { ...DEFAULT_CONFIG.executor, ...userConfig.executor },
      orchestration: { ...DEFAULT_CONFIG.orchestration, ...userConfig.orchestration },
      ui: { ...DEFAULT_CONFIG.ui, ...userConfig.ui },
      notifications: {
        ...DEFAULT_CONFIG.notifications,
        ...userConfig.notifications,
        feishu: {
          ...defaultFeishuConfig,
          ...userConfig.notifications?.feishu,
        },
      },
      integrations: {
        ...DEFAULT_CONFIG.integrations,
        ...userConfig.integrations,
        markdown_preview: {
          ...defaultMarkdownPreviewConfig,
          ...userConfig.integrations?.markdown_preview,
        },
      },
      gateway: {
        ...DEFAULT_CONFIG.gateway,
        ...userConfig.gateway,
        enabled: userConfig.gateway?.enabled ?? DEFAULT_CONFIG.gateway?.enabled ?? false,
        platforms: {
          ...DEFAULT_CONFIG.gateway?.platforms,
          ...userConfig.gateway?.platforms,
          feishu: {
            ...defaultGatewayFeishuConfig,
            ...userConfig.gateway?.platforms?.feishu,
            access: {
              ...defaultGatewayFeishuConfig.access,
              ...userConfig.gateway?.platforms?.feishu?.access,
            },
            delivery: {
              ...defaultGatewayFeishuConfig.delivery,
              ...userConfig.gateway?.platforms?.feishu?.delivery,
            },
          },
        },
      },
    };
    return validateConfig(mergedConfig);
  } catch (error) {
    if (error instanceof InvalidConfigError) throw error;
    console.error(`配置文件加载失败: ${resolvedConfigPath}`, error);
    return DEFAULT_CONFIG;
  }
}

class InvalidConfigError extends Error {}

function validateConfig(config: Config): Config {
  if (!Number.isInteger(config.orchestration.max_concurrent_attempts)
    || config.orchestration.max_concurrent_attempts <= 0) {
    throw new InvalidConfigError('max_concurrent_attempts must be a positive integer');
  }
  return config;
}

function resolveExistingConfigPath(configPath: string): string | null {
  if (existsSync(configPath)) {
    return configPath;
  }

  const configDir = dirname(configPath);
  const requestedExt = extname(configPath);
  const fallbackNames = requestedExt === '.yaml'
    ? ['config.yml', 'config.json']
    : ['config.yaml', 'config.yml', 'config.json'];

  for (const fallbackName of fallbackNames) {
    const fallbackPath = join(configDir, fallbackName);
    if (existsSync(fallbackPath)) {
      return fallbackPath;
    }
  }

  return null;
}
