import type { Config } from '../core/types.js';
import type { MetaclawSession } from '../session/metaclaw-session.js';
import {
  createFeishuBridge,
  resolveAppSecret,
  type CreateFeishuBridgeOptions,
  type FeishuBridge,
} from '../integrations/feishu-app.js';
import { resolveFeishuGatewayConfig, resolveFeishuGatewayEnv, toFeishuAppConfig } from './feishu-config.js';
import { probeFeishuBot } from './feishu-onboarding.js';
import type { GatewayStatusReporter } from './health.js';

type CreateFeishuBridge = (
  config: Config,
  session: MetaclawSession | undefined,
  options?: CreateFeishuBridgeOptions,
) => FeishuBridge | null;

export interface StartedFeishuRuntimeBridge {
  bridge: FeishuBridge;
  stop(): Promise<void>;
  waitForFailure(): Promise<never>;
}

export async function startFeishuRuntimeBridge(
  config: Config,
  input: MetaclawSession | {
    session?: MetaclawSession;
    resolveSession?: (chatId: string) => Promise<MetaclawSession>;
    statusReporter?: GatewayStatusReporter;
    probeBot?: typeof probeFeishuBot;
  },
  createBridge: CreateFeishuBridge = createFeishuBridge,
): Promise<StartedFeishuRuntimeBridge | null> {
  const runtimeInput = 'appendSystemMessage' in input ? { session: input } : input;
  const credentialEnv = resolveFeishuGatewayEnv();
  const feishuConfig = resolveFeishuGatewayConfig(config, credentialEnv);
  if (!feishuConfig.enabled) return null;
  if (!feishuConfig.appId) throw new Error('飞书 Gateway 已启用，但缺少 app_id');
  const appSecret = resolveAppSecret(toFeishuAppConfig(feishuConfig), credentialEnv);
  if (!appSecret) throw new Error(`飞书 Gateway 已启用，但缺少 ${feishuConfig.appSecretEnv ?? 'FEISHU_APP_SECRET'}`);
  const bot = await (runtimeInput.probeBot ?? probeFeishuBot)({
    appId: feishuConfig.appId,
    appSecret,
    domain: feishuConfig.domain,
  });
  if (!bot?.botOpenId) {
    throw new Error('无法获取飞书机器人身份；请确认凭据和机器人能力已启用');
  }
  const bridge = createBridge(config, runtimeInput.session, {
    resolveSession: runtimeInput.resolveSession,
    botOpenId: bot.botOpenId,
    readyTimeoutMs: 60_000,
    credentialEnv,
    onConnectionState: (state, error) => {
      runtimeInput.statusReporter?.update(state, error?.message);
      if (state === 'reconnecting') console.warn('飞书长连接断开，正在重连');
      if (state === 'connected') console.log('飞书长连接已连接');
      if (state === 'failed') console.error(`飞书长连接失败: ${error?.message ?? 'unknown error'}`);
    },
  });
  if (!bridge) throw new Error('飞书 Gateway 已启用，但桥接器未创建');

  const feishuMode = feishuConfig.connectionMode;
  try {
    await bridge.start();
    console.log(feishuMode === 'webhook'
      ? '飞书 Webhook 桥接已启动，等待飞书回调'
      : '飞书长连接桥接已启动，等待飞书消息');
  } catch (error) {
    runtimeInput.statusReporter?.update('failed', (error as Error).message);
    await bridge.stop().catch(() => undefined);
    throw error;
  }

  return {
    bridge,
    stop: () => bridge!.stop(),
    waitForFailure: () => bridge.waitForFailure(),
  };
}
