import type Database from 'better-sqlite3';
import type { ExecutorVerification } from '../executor/executor-registry-types.js';

interface ExecutorVerificationRow {
  executor_id: string;
  config_digest: string;
  binary_path: string;
  binary_path_digest: string;
  version: string;
  driver: ExecutorVerification['driver'];
  verified_at: string;
  success: number;
  result_json: string;
}

export class ExecutorVerificationRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(verification: ExecutorVerification): void {
    this.db.prepare(`
      INSERT INTO executor_verifications (
        executor_id, config_digest, binary_path, binary_path_digest, version,
        driver, verified_at, success, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(executor_id, config_digest) DO UPDATE SET
        binary_path = excluded.binary_path,
        binary_path_digest = excluded.binary_path_digest,
        version = excluded.version,
        driver = excluded.driver,
        verified_at = excluded.verified_at,
        success = excluded.success,
        result_json = excluded.result_json
    `).run(
      verification.executorId,
      verification.configDigest,
      verification.binaryPath,
      verification.binaryPathDigest,
      verification.version,
      verification.driver,
      verification.verifiedAt,
      verification.success ? 1 : 0,
      JSON.stringify(verification.result),
    );
  }

  find(executorId: string, configDigest: string): ExecutorVerification | null {
    const row = this.db.prepare(`
      SELECT * FROM executor_verifications
      WHERE executor_id = ? AND config_digest = ?
    `).get(executorId, configDigest) as ExecutorVerificationRow | undefined;
    return row ? rowToVerification(row) : null;
  }

  list(): ExecutorVerification[] {
    return (this.db.prepare(`
      SELECT * FROM executor_verifications
      ORDER BY verified_at DESC, executor_id ASC
    `).all() as ExecutorVerificationRow[]).map(rowToVerification);
  }
}

function rowToVerification(row: ExecutorVerificationRow): ExecutorVerification {
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(row.result_json) as Record<string, unknown>;
  } catch {
    result = { error: 'invalid verification result JSON' };
  }
  return {
    executorId: row.executor_id,
    configDigest: row.config_digest,
    binaryPath: row.binary_path,
    binaryPathDigest: row.binary_path_digest,
    version: row.version,
    driver: row.driver,
    verifiedAt: row.verified_at,
    success: row.success === 1,
    result,
  };
}
