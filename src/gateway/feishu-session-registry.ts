import { createHash } from 'node:crypto';
import type { MetaclawSession } from '../session/metaclaw-session.js';

export function createFeishuSessionId(chatId: string): string {
  return `sess_feishu_${createHash('sha256').update(chatId).digest('hex').slice(0, 24)}`;
}

export class FeishuSessionRegistry {
  private readonly sessions = new Map<string, MetaclawSession>();
  private blockedRecheckTimer: NodeJS.Timeout | null = null;

  constructor(private readonly createSession: (sessionId: string) => MetaclawSession) {}

  async get(chatId: string): Promise<MetaclawSession> {
    return this.getBySessionId(createFeishuSessionId(chatId));
  }

  async preload(sessionIds: readonly string[]): Promise<void> {
    await Promise.all(sessionIds.map(sessionId => this.getBySessionId(sessionId)));
  }

  private async getBySessionId(sessionId: string): Promise<MetaclawSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session = this.createSession(sessionId);
    session.initialize({ showDashboard: false });
    this.sessions.set(sessionId, session);
    this.ensureBlockedRecheckTimer(session.getBlockedRecheckIntervalMs());
    await session.waitForInitialization();
    return session;
  }

  async stop(): Promise<void> {
    if (this.blockedRecheckTimer) {
      clearInterval(this.blockedRecheckTimer);
      this.blockedRecheckTimer = null;
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(session => session.shutdown()));
  }

  get size(): number {
    return this.sessions.size;
  }

  private ensureBlockedRecheckTimer(intervalMs: number): void {
    if (this.blockedRecheckTimer) return;
    this.blockedRecheckTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        void session.maybeReviewTaskPoolOnTimer().catch(error => {
          session.appendSystemMessage(`错误: ${(error as Error).message}`);
        });
      }
    }, intervalMs);
  }
}
