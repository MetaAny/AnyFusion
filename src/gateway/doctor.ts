import { existsSync } from 'fs';
import { resolve } from 'path';
import type { Config } from '../core/types.js';
import { resolveFeishuGatewayConfig, resolveFeishuGatewayEnv } from './feishu-config.js';

export interface GatewayDoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export function runGatewayDoctor(input: {
  config: Config;
  metaclawDir: string;
  env?: NodeJS.ProcessEnv;
}): GatewayDoctorCheck[] {
  const env = resolveFeishuGatewayEnv(input.env ?? process.env);
  const checks: GatewayDoctorCheck[] = [];
  const feishu = resolveFeishuGatewayConfig(input.config, env);

  checks.push({
    name: 'gateway.feishu.enabled',
    status: feishu.enabled ? 'ok' : 'fail',
    message: feishu.enabled ? 'Feishu Gateway is enabled' : 'Feishu Gateway is disabled',
  });

  checks.push({
    name: 'gateway.feishu.app_id',
    status: feishu.appId ? 'ok' : 'fail',
    message: feishu.appId ? 'Feishu app_id is configured' : 'Missing Feishu app_id',
  });

  checks.push({
    name: 'gateway.feishu.app_secret',
    status: feishu.appSecretEnv && env[feishu.appSecretEnv] ? 'ok' : 'fail',
    message: feishu.appSecretEnv
      ? `Feishu app secret env ${feishu.appSecretEnv} ${env[feishu.appSecretEnv] ? 'is set' : 'is not set'}`
      : 'Missing Feishu app_secret_env',
  });

  checks.push({
    name: 'gateway.feishu.connection_mode',
    status: feishu.connectionMode === 'websocket' ? 'ok' : 'warn',
    message: feishu.connectionMode === 'websocket'
      ? 'WebSocket mode does not require a public callback URL'
      : `Webhook mode listens on ${feishu.eventPort}${feishu.eventPath}; verify public HTTPS reverse proxy separately`,
  });

  if (feishu.connectionMode === 'webhook') {
    checks.push({
      name: 'gateway.feishu.verification_token',
      status: feishu.verificationToken ? 'ok' : 'warn',
      message: feishu.verificationToken ? 'Webhook verification token is configured' : 'Webhook verification token is not configured',
    });
    checks.push({
      name: 'gateway.feishu.encrypt_key',
      status: feishu.encryptKeyEnv && env[feishu.encryptKeyEnv] ? 'ok' : 'warn',
      message: feishu.encryptKeyEnv
        ? `Webhook encrypt key env ${feishu.encryptKeyEnv} ${env[feishu.encryptKeyEnv] ? 'is set' : 'is not set'}`
        : 'Webhook encrypt key env is not configured',
    });
  }

  const homeChannel = input.config.gateway?.platforms?.feishu?.home_channel;
  checks.push({
    name: 'gateway.feishu.home_channel',
    status: homeChannel ? 'ok' : 'warn',
    message: homeChannel ? `Home channel is ${homeChannel}` : 'Home channel is not configured; send /sethome in Feishu',
  });

  checks.push({
    name: 'gateway.feishu.pairings',
    status: existsSync(resolve(input.metaclawDir, 'feishu-pairings.json')) ? 'ok' : 'warn',
    message: existsSync(resolve(input.metaclawDir, 'feishu-pairings.json'))
      ? 'Pairing state file exists'
      : 'Pairing state file does not exist yet',
  });

  checks.push({
    name: 'gateway.audit',
    status: existsSync(resolve(input.metaclawDir, 'gateway-audit.jsonl')) ? 'ok' : 'warn',
    message: existsSync(resolve(input.metaclawDir, 'gateway-audit.jsonl'))
      ? 'Gateway audit log exists'
      : 'Gateway audit log does not exist yet',
  });

  return checks;
}

export function formatGatewayDoctorChecks(checks: GatewayDoctorCheck[]): string {
  return checks.map(check => `${formatStatus(check.status)} ${check.name}: ${check.message}`).join('\n');
}

function formatStatus(status: GatewayDoctorCheck['status']): string {
  if (status === 'ok') {
    return 'OK';
  }
  if (status === 'warn') {
    return 'WARN';
  }
  return 'FAIL';
}
