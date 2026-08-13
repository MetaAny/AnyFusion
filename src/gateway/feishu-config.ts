import type { Config } from '../core/types.js';
import type { FeishuAppConfig } from '../integrations/feishu-app.js';
import { readEnvFileIfExists } from '../utils/env-file.js';

export interface ResolvedFeishuGatewayConfig {
  enabled: boolean;
  domain: 'feishu' | 'lark';
  connectionMode: 'websocket' | 'webhook';
  appId?: string;
  appSecretEnv?: string;
  eventPort: number;
  eventPath: string;
  verificationToken?: string;
  encryptKeyEnv?: string;
  source: 'gateway' | 'default';
}

export function resolveFeishuGatewayConfig(
  config: Config,
  env: NodeJS.ProcessEnv = resolveFeishuGatewayEnv(),
): ResolvedFeishuGatewayConfig {
  const gatewayFeishu = config.gateway?.platforms?.feishu;
  const envDomain = env.FEISHU_DOMAIN?.trim();
  const domain = envDomain === 'lark' || envDomain === 'feishu'
    ? envDomain
    : gatewayFeishu?.domain ?? 'feishu';
  const appId = env.FEISHU_APP_ID?.trim() || gatewayFeishu?.app_id;

  return {
    enabled: gatewayFeishu?.enabled ?? false,
    domain,
    connectionMode: gatewayFeishu?.connection_mode ?? 'websocket',
    appId,
    appSecretEnv: gatewayFeishu?.app_secret_env ?? 'FEISHU_APP_SECRET',
    eventPort: gatewayFeishu?.event_port ?? 8787,
    eventPath: gatewayFeishu?.event_path ?? '/feishu/events',
    verificationToken: gatewayFeishu?.verification_token,
    encryptKeyEnv: gatewayFeishu?.encrypt_key_env,
    source: gatewayFeishu?.enabled ? 'gateway' : 'default',
  };
}

export function resolveFeishuGatewayEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const envPath = baseEnv.METACLAW_FEISHU_ENV_FILE?.trim();
  return {
    ...baseEnv,
    ...(envPath ? readEnvFileIfExists(envPath) : {}),
  };
}

export function toFeishuAppConfig(config: ResolvedFeishuGatewayConfig): FeishuAppConfig {
  return {
    enabled: config.enabled,
    mode: config.connectionMode,
    app_id: config.appId,
    app_secret_env: config.appSecretEnv,
    event_port: config.eventPort,
    event_path: config.eventPath,
    verification_token: config.verificationToken,
    ...(config.encryptKeyEnv ? { encrypt_key_env: config.encryptKeyEnv } : {}),
  };
}
