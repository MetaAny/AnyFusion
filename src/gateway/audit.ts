import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { resolveMetaclawDir } from '../utils/paths.js';

export interface GatewayAuditRecord {
  ts?: string;
  platform: 'feishu';
  kind: 'inbound' | 'policy' | 'session' | 'progress' | 'final' | 'artifact' | 'fallback' | 'permission';
  target: string;
  method: 'card' | 'post' | 'file' | 'local' | 'notice' | 'skipped';
  ok: boolean;
  requestId?: string;
  reason?: string;
  chunkIndex?: number;
  chunkCount?: number;
  error?: string;
}

export class GatewayAuditLog {
  constructor(private readonly path = resolve(resolveMetaclawDir(), 'gateway-audit.jsonl')) {}

  record(record: GatewayAuditRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({
      ts: record.ts ?? new Date().toISOString(),
      ...record,
    })}\n`, { encoding: 'utf-8' });
  }
}
