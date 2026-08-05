import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { CommandCompletion } from '../commands/catalog.js';
import type { PlannerProposalPurpose, PlannerProposalResult, PlannerProposalSubmission } from '../planning/planner-proposal.js';
import type {
  PlannerTuiCommandSubmissionResult,
  PlannerTuiExecutorResult,
  PlannerTuiPermissionRequest,
  PlannerTuiPermissionResolutionResult,
  PlannerTuiSnapshot,
  SessionSnapshot,
} from '../session/metaclaw-session.js';
import {
  ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES,
  ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
  isPlannerHostRequest,
  type PlannerHostMessage,
  type PlannerHostRequest,
} from './planner-host-protocol.js';

export interface PlannerTuiBridgeSession {
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
  getPlannerTuiSnapshot(): PlannerTuiSnapshot;
  getPlannerTuiExecutorResults(): PlannerTuiExecutorResult[];
  getPlannerTuiPermissionRequests(): PlannerTuiPermissionRequest[];
  resolvePlannerTuiPermission(permissionRequestId: string, resolution: 'approve' | 'deny'): Promise<PlannerTuiPermissionResolutionResult>;
  completeCommand(text: string, cursor?: number): CommandCompletion;
  submitPlannerTuiCommand(command: string): Promise<PlannerTuiCommandSubmissionResult>;
  submitPlannerProposal(
    submission: PlannerProposalSubmission,
    purpose?: PlannerProposalPurpose,
  ): Promise<PlannerProposalResult>;
}

export interface PlannerTuiBridgeDeps {
  socketPath: string;
  logger?: Pick<Console, 'warn'>;
}

type BridgeMessage = PlannerHostMessage<PlannerTuiSnapshot, PlannerTuiExecutorResult, PlannerTuiPermissionRequest>;
type BoundClient = { sessionId: string; mode: 'interactive' | 'rpc' };
const TRUNCATED_REPORT_SUFFIX = '\n\n> Executor report truncated to fit the 1 MiB Planner Host frame.';

/**
 * Shared local Proposal Host for every AnyFusion-Pi surface.
 *
 * The host is an Application-Shell adapter only. It routes a runtime-bound
 * session/turn to MetaclawSession, which remains the sole validation and Kernel
 * authority. Snapshot and command capabilities are presentation adapters over
 * the same registered session.
 */
export class PlannerTuiBridge {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private readonly bindings = new Map<Socket, BoundClient>();
  private readonly sessions = new Map<string, PlannerTuiBridgeSession>();
  private readonly subscriberCleanup = new Map<Socket, () => void>();
  private readonly sentExecutorResultIds = new Map<Socket, Set<string>>();
  private readonly sentPermissionRequests = new Map<Socket, Map<string, PlannerTuiPermissionRequest>>();
  private readonly permissionClosureHints = new Map<string, 'resolved'>();
  private readonly submissionQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: PlannerTuiBridgeDeps) {}

  registerSession(sessionId: string, session: PlannerTuiBridgeSession): () => void {
    if (!sessionId.trim()) throw new Error('Planner host sessionId must not be empty');
    if (this.sessions.has(sessionId)) throw new Error(`Planner host session already registered: ${sessionId}`);
    this.sessions.set(sessionId, session);
    return () => {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.deps.socketPath), { recursive: true });
    await this.removeStaleSocket();
    const server = createServer(socket => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.deps.socketPath);
    });
    this.server = server;
    await chmod(this.deps.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.bindings.clear();
    for (const cleanup of this.subscriberCleanup.values()) cleanup();
    this.subscriberCleanup.clear();
    this.sentExecutorResultIds.clear();
    this.sentPermissionRequests.clear();
    this.permissionClosureHints.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
    await this.removeStaleSocket();
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES) {
        this.write(socket, this.errorResponse(null, 'line_too_large', 'JSONL request exceeds 1 MiB'));
        buffer = '';
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', error => this.deps.logger?.warn(`Planner host client error: ${error.message}`));
    socket.on('close', () => this.removeClient(socket));
  }

  private handleLine(socket: Socket, line: string): void {
    let request: PlannerHostRequest;
    try {
      const value: unknown = JSON.parse(line);
      if (!isPlannerHostRequest(value)) {
        throw new Error(`request must use AnyFusionPlannerHostProtocol v${ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION}`);
      }
      request = value;
    } catch (error) {
      this.write(socket, this.errorResponse(null, 'invalid_request', (error as Error).message));
      return;
    }

    if (request.type === 'hello') {
      const session = this.sessions.get(request.sessionId);
      if (!session) {
        this.write(socket, this.errorResponse(request.requestId, 'unknown_session', 'Planner host session is not registered'));
        return;
      }
      this.bindings.set(socket, { sessionId: request.sessionId, mode: request.mode });
      this.write(socket, {
        protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
        type: 'hello',
        requestId: request.requestId,
        accepted: true,
        capabilities: [
          'snapshot_get', 'snapshot_subscribe', 'command_complete', 'command_submit',
          'proposal_submit', 'proposal_idempotency', 'proposal_turn_lock', 'executor_result',
          'permission_request',
          'ping', 'shutdown',
        ],
      });
      return;
    }

    const bound = this.bindings.get(socket);
    if (!bound) {
      this.write(socket, this.errorResponse(request.requestId, 'hello_required', 'Planner host hello is required first'));
      return;
    }
    const session = this.sessions.get(bound.sessionId);
    if (!session) {
      this.write(socket, this.errorResponse(request.requestId, 'unknown_session', 'Planner host session is no longer registered'));
      return;
    }

    switch (request.type) {
      case 'ping':
        this.write(socket, { protocolVersion: 2, type: 'pong', requestId: request.requestId });
        return;
      case 'snapshot_get':
        this.write(socket, this.snapshotMessage(request.requestId, session));
        return;
      case 'snapshot_subscribe':
        this.subscribeSocket(socket, session);
        this.write(socket, { protocolVersion: 2, type: 'subscribed', requestId: request.requestId });
        return;
      case 'command_complete':
        this.write(socket, {
          protocolVersion: 2, type: 'command_completion', requestId: request.requestId,
          completion: session.completeCommand(request.text, request.cursor),
        });
        return;
      case 'command_submit':
        this.enqueue(bound.sessionId, async () => this.submitCommand(socket, session, request));
        return;
      case 'proposal_submit':
        if (request.sessionId !== bound.sessionId) {
          this.write(socket, this.errorResponse(request.requestId, 'session_mismatch', 'proposal sessionId differs from hello binding'));
          return;
        }
        this.enqueue(bound.sessionId, async () => this.submitProposal(socket, session, request, bound.mode));
        return;
      case 'permission_resolve':
        if (bound.mode !== 'interactive') {
          this.write(socket, this.errorResponse(request.requestId, 'interactive_required', 'permission selector is interactive-only'));
          return;
        }
        this.enqueue(bound.sessionId, async () => this.resolvePermission(socket, session, request));
        return;
      case 'shutdown':
        this.write(socket, { protocolVersion: 2, type: 'shutdown', requestId: request.requestId, accepted: true });
        socket.end();
        return;
    }
  }

  private enqueue(sessionId: string, operation: () => Promise<void>): void {
    const previous = this.submissionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation).catch(error => {
      this.deps.logger?.warn(`Planner host submission failed: ${(error as Error).message}`);
    }).finally(() => {
      if (this.submissionQueues.get(sessionId) === next) this.submissionQueues.delete(sessionId);
    });
    this.submissionQueues.set(sessionId, next);
  }

  private async submitCommand(
    socket: Socket,
    session: PlannerTuiBridgeSession,
    request: Extract<PlannerHostRequest, { type: 'command_submit' }>,
  ): Promise<void> {
    try {
      const result = await session.submitPlannerTuiCommand(request.command);
      this.write(socket, {
        protocolVersion: 2, type: 'command_result', requestId: request.requestId, accepted: true,
        exitRequested: result.exitRequested, output: result.output,
      });
    } catch (error) {
      this.write(socket, {
        protocolVersion: 2, type: 'command_result', requestId: request.requestId, accepted: false,
        error: { code: 'command_submission_failed', message: (error as Error).message },
      });
    }
  }

  private async submitProposal(
    socket: Socket,
    session: PlannerTuiBridgeSession,
    request: Extract<PlannerHostRequest, { type: 'proposal_submit' }>,
    runtimeMode: 'interactive' | 'rpc',
  ): Promise<void> {
    let result: PlannerProposalResult;
    try {
      result = await session.submitPlannerProposal({
        sessionId: request.sessionId,
        turnId: request.turnId,
        userInput: request.userInput,
        submissionId: request.submissionId,
        plan: request.plan,
        runtimeMode,
      }, request.purpose);
    } catch (error) {
      result = {
        status: 'transport_uncertain',
        turnId: request.turnId,
        submissionId: request.submissionId,
        retryableByReplay: true,
        message: (error as Error).message,
      };
    }
    this.write(socket, {
      protocolVersion: 2, type: 'proposal_result', requestId: request.requestId, result,
    });
  }

  private async resolvePermission(
    socket: Socket,
    session: PlannerTuiBridgeSession,
    request: Extract<PlannerHostRequest, { type: 'permission_resolve' }>,
  ): Promise<void> {
    this.permissionClosureHints.set(request.permissionRequestId, 'resolved');
    try {
      const result = await session.resolvePlannerTuiPermission(request.permissionRequestId, request.resolution);
      this.write(socket, { protocolVersion: 2, type: 'permission_result', requestId: request.requestId, result });
    } finally {
      this.permissionClosureHints.delete(request.permissionRequestId);
    }
  }

  private subscribeSocket(socket: Socket, session: PlannerTuiBridgeSession): void {
    this.subscriberCleanup.get(socket)?.();
    const publish = () => {
      this.write(socket, this.snapshotMessage(null, session));
      this.writeExecutorResults(socket, session);
      this.writePermissionRequests(socket, session);
    };
    const unsubscribe = session.subscribe(publish);
    this.subscriberCleanup.set(socket, unsubscribe);
    this.sentExecutorResultIds.set(socket, this.sentExecutorResultIds.get(socket) ?? new Set());
    this.sentPermissionRequests.set(socket, this.sentPermissionRequests.get(socket) ?? new Map());
    this.writeExecutorResults(socket, session);
    this.writePermissionRequests(socket, session);
  }

  private snapshotMessage(requestId: string | null, session: PlannerTuiBridgeSession): BridgeMessage {
    return {
      protocolVersion: 2, type: 'snapshot', requestId, snapshot: session.getPlannerTuiSnapshot(),
    };
  }

  private removeClient(socket: Socket): void {
    this.clients.delete(socket);
    this.bindings.delete(socket);
    this.subscriberCleanup.get(socket)?.();
    this.subscriberCleanup.delete(socket);
    this.sentExecutorResultIds.delete(socket);
    this.sentPermissionRequests.delete(socket);
  }

  private writeExecutorResults(socket: Socket, session: PlannerTuiBridgeSession): void {
    const sent = this.sentExecutorResultIds.get(socket) ?? new Set<string>();
    this.sentExecutorResultIds.set(socket, sent);
    for (const result of session.getPlannerTuiExecutorResults()) {
      if (sent.has(result.publicationId)) continue;
      this.write(socket, this.boundedExecutorResultMessage(result));
      sent.add(result.publicationId);
    }
  }

  private writePermissionRequests(socket: Socket, session: PlannerTuiBridgeSession): void {
    if (this.bindings.get(socket)?.mode !== 'interactive') return;
    const sent = this.sentPermissionRequests.get(socket) ?? new Map<string, PlannerTuiPermissionRequest>();
    this.sentPermissionRequests.set(socket, sent);
    const current = session.getPlannerTuiPermissionRequests();
    const openIds = new Set(current.map(request => request.permissionRequestId));
    for (const [permissionRequestId, previous] of sent) {
      if (openIds.has(permissionRequestId)) continue;
      const reason = this.permissionClosureHints.get(permissionRequestId)
        ?? (Date.parse(previous.expiresAt) <= Date.now() ? 'expired' : 'stale');
      this.write(socket, {
        protocolVersion: 2, type: 'permission_request_closed', requestId: null,
        permissionRequestId, reason,
      });
      sent.delete(permissionRequestId);
    }
    for (const permission of current) {
      if (sent.has(permission.permissionRequestId)) continue;
      this.write(socket, { protocolVersion: 2, type: 'permission_request', requestId: null, permission });
      sent.set(permission.permissionRequestId, permission);
    }
  }

  private boundedExecutorResultMessage(result: PlannerTuiExecutorResult): BridgeMessage {
    const build = (report: string, reportTruncated: boolean): BridgeMessage => ({
      protocolVersion: 2,
      type: 'executor_result',
      requestId: null,
      result: { ...result, report, reportTruncated },
    });
    const full = build(result.report, false);
    if (this.messageBytes(full) <= ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES) return full;

    const codePoints = [...result.report];
    let low = 0;
    let high = codePoints.length;
    let bounded = build(TRUNCATED_REPORT_SUFFIX.trimStart(), true);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const prefix = codePoints.slice(0, middle).join('').trimEnd();
      const candidate = build(`${prefix}${TRUNCATED_REPORT_SUFFIX}`, true);
      if (this.messageBytes(candidate) <= ANYFUSION_PLANNER_HOST_MAX_LINE_BYTES) {
        bounded = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return bounded;
  }

  private messageBytes(message: BridgeMessage): number {
    return Buffer.byteLength(`${JSON.stringify(message)}\n`);
  }

  private errorResponse(
    requestId: string | null, code: string, message: string, details?: string[],
  ): BridgeMessage {
    return {
      protocolVersion: 2, type: 'error', requestId,
      error: { code, message, ...(details?.length ? { details } : {}) },
    };
  }

  private write(socket: Socket, message: BridgeMessage): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const stat = await lstat(this.deps.socketPath);
      if (!stat.isSocket()) throw new Error(`refusing to replace non-socket bridge path: ${this.deps.socketPath}`);
      await unlink(this.deps.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
