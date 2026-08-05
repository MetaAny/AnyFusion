import { existsSync, unlinkSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { Config } from '../core/types.js';
import type { TaskEngine } from '../task/task-engine.js';
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { ContextRecaller } from '../memory/context-recaller.js';
import type { NotificationService } from '../notifications/types.js';
import { MetaclawSession, type PlannerHostRegistrar } from '../session/metaclaw-session.js';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import type { GatewayClientMessage, GatewayServerMessage } from './protocol.js';

interface GatewayServerDeps {
  socketPath: string;
  taskEngine: TaskEngine;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  db: Database.Database;
  config: Config;
  contextRecaller: ContextRecaller;
  notifier: NotificationService;
  workspaceRoot: string;
  plannerHost?: PlannerHostRegistrar;
}

export class MetaclawGatewayServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly deps: GatewayServerDeps) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }

    this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
      });
      void this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    if (existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const sessionId = `sess_gateway_${nanoid(10)}`;
    const session = new MetaclawSession({
      taskEngine: this.deps.taskEngine,
      memoryEngine: this.deps.memoryEngine,
      orchestration: this.deps.orchestration,
      db: this.deps.db,
      config: this.deps.config,
      sessionId,
      contextRecaller: this.deps.contextRecaller,
      notifier: this.deps.notifier,
      plannerHost: this.deps.plannerHost,
    });

    let observedOutputLength = 0;
    const send = (message: GatewayServerMessage) => {
      if (!socket.destroyed) {
        socket.write(encodeJsonLine(message));
      }
    };

    const unsubscribe = session.subscribe(snapshot => {
      const newLines = snapshot.output.slice(observedOutputLength);
      observedOutputLength = snapshot.output.length;
      if (newLines.length > 0) {
        send({ type: 'output', lines: newLines });
      }
    });

    socket.on('close', () => {
      unsubscribe();
      session.dispose();
    });
    socket.on('error', () => {
      unsubscribe();
      session.dispose();
    });

    send({ type: 'hello', sessionId });
    session.initialize({ showDashboard: false });
    session.appendSystemMessage(`→ Gateway session ${sessionId} 已连接`);

    const parse = createJsonLineParser<GatewayClientMessage>((message) => {
      if (message.type === 'close') {
        socket.end(encodeJsonLine({ type: 'exit' } satisfies GatewayServerMessage));
        return;
      }
      if (message.type !== 'input') {
        return;
      }
      void session.submit(message.text).then(result => {
        if (result.exitRequested) {
          socket.end(encodeJsonLine({ type: 'exit' } satisfies GatewayServerMessage));
        }
      }).catch(error => {
        send({ type: 'error', message: (error as Error).message });
      });
    });

    socket.on('data', parse);
  }
}
