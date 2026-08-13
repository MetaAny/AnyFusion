import type Database from 'better-sqlite3';

export type KernelEffectStatus = 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed';

export interface KernelEffectRecord {
  id: string;
  decisionId: string;
  taskId: string | null;
  effectType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: KernelEffectStatus;
  deliveryAttempts: number;
  providerReceipt: string | null;
  errorSummary: string | null;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
}

interface EffectRow {
  id: string;
  decision_id: string;
  task_id: string | null;
  effect_type: string;
  idempotency_key: string;
  payload_json: string;
  status: KernelEffectStatus;
  delivery_attempts: number;
  provider_receipt: string | null;
  error_summary: string | null;
  available_at: string;
  created_at: string;
  updated_at: string;
}

export class KernelEffectOutboxRepo {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  enqueue(input: {
    id: string;
    decisionId: string;
    taskId?: string | null;
    effectType: string;
    payload: Record<string, unknown>;
    availableAt: string;
  }): KernelEffectRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO kernel_effect_outbox (
        id, decision_id, task_id, effect_type, idempotency_key, payload_json,
        status, delivery_attempts, provider_receipt, error_summary,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?)
    `).run(
      input.id,
      input.decisionId,
      input.taskId ?? null,
      input.effectType,
      `effect:${input.id}`,
      JSON.stringify(input.payload),
      input.availableAt,
      input.availableAt,
      input.availableAt,
    );
    return this.find(input.id)!;
  }

  async deliver(
    id: string,
    sender: (effect: KernelEffectRecord) => Promise<string | null>,
    now: () => string,
  ): Promise<KernelEffectRecord> {
    const effect = this.find(id);
    if (!effect) throw new Error(`Kernel effect not found: ${id}`);
    if (effect.status === 'sent') return effect;
    if (effect.status === 'sending' || effect.status === 'uncertain') return effect;
    this.db.prepare(`
      UPDATE kernel_effect_outbox
      SET status = 'sending', delivery_attempts = delivery_attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'failed')
    `).run(now(), id);
    const sending = this.find(id)!;
    try {
      const receipt = await sender(sending);
      this.db.prepare(`
        UPDATE kernel_effect_outbox
        SET status = 'sent', provider_receipt = ?, error_summary = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `).run(receipt, now(), id);
    } catch (error) {
      this.db.prepare(`
        UPDATE kernel_effect_outbox
        SET status = 'uncertain', error_summary = ?, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `).run(boundedError(error), now(), id);
    }
    return this.find(id)!;
  }

  reconcileSending(now: string): number {
    return this.db.prepare(`
      UPDATE kernel_effect_outbox
      SET status = 'uncertain', error_summary = 'process exited while effect delivery was in flight', updated_at = ?
      WHERE status = 'sending'
    `).run(now).changes;
  }

  listRecoveryItems(taskId: string): KernelEffectRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_effect_outbox
      WHERE task_id = ? AND status IN ('uncertain', 'failed')
      ORDER BY created_at ASC, id ASC
    `).all(taskId) as EffectRow[]).map(rowToRecord);
  }

  listPending(now: string): KernelEffectRecord[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_effect_outbox
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY available_at ASC, created_at ASC, id ASC
    `).all(now) as EffectRow[]).map(rowToRecord);
  }

  listIncompleteCompletionTaskIds(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT effect.task_id
      FROM kernel_effect_outbox effect
      INNER JOIN tasks task ON task.id = effect.task_id
      WHERE effect.effect_type = 'task_completion_notification'
        AND task.status IN ('ready', 'running', 'blocked')
      ORDER BY effect.task_id ASC
    `).all() as Array<{ task_id: string }>).map(row => row.task_id);
  }

  listCompletionRecoverySessionIds(sessionIdPrefix: string): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT decision.session_id
      FROM kernel_effect_outbox effect
      INNER JOIN tasks task ON task.id = effect.task_id
      INNER JOIN kernel_decisions decision ON decision.id = effect.decision_id
      WHERE effect.effect_type = 'task_completion_notification'
        AND task.status IN ('ready', 'running', 'blocked')
        AND decision.session_id LIKE ?
      ORDER BY decision.session_id ASC
    `).all(`${sessionIdPrefix}%`) as Array<{ session_id: string }>).map(row => row.session_id);
  }

  resolve(id: string, resolution: 'assume_applied' | 'retry', now: string): void {
    const next = resolution === 'assume_applied' ? 'sent' : 'pending';
    this.db.prepare(`
      UPDATE kernel_effect_outbox
      SET status = ?, provider_receipt = CASE WHEN ? = 'sent' THEN 'manual:assume-applied' ELSE provider_receipt END,
          error_summary = NULL, updated_at = ?
      WHERE id = ? AND status IN ('uncertain', 'failed')
    `).run(next, next, now, id);
  }

  find(id: string): KernelEffectRecord | null {
    const row = this.db.prepare('SELECT * FROM kernel_effect_outbox WHERE id = ?').get(id) as EffectRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row: EffectRow): KernelEffectRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    taskId: row.task_id,
    effectType: row.effect_type,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    deliveryAttempts: row.delivery_attempts,
    providerReceipt: row.provider_receipt,
    errorSummary: row.error_summary,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 320);
}
