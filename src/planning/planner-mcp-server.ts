import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'path';
import { getPlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';
import { truncateText } from '../utils/truncate-text.js';

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 10;
const TASK_STATUSES = ['created', 'ready', 'running', 'parked', 'blocked', 'done', 'archived', 'cancelled'] as const;

export class PlannerDataReader {
  constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
  ) {}

  searchTasks(input: { query?: string; statuses?: string[]; limit?: number }) {
    const limit = boundedLimit(input.limit);
    const statuses = (input.statuses ?? []).filter(status => TASK_STATUSES.includes(status as typeof TASK_STATUSES[number]));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.query?.trim()) {
      clauses.push("LOWER(title || ' ' || COALESCE(goal, '') || ' ' || COALESCE(summary, '')) LIKE ?");
      params.push(`%${input.query.trim().toLowerCase()}%`);
    }
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT id, title, status, summary, priority_json, updated_at
      FROM tasks
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;
    return {
      count: rows.length,
      tasks: rows.map(row => ({
        id: row.id,
        title: truncateText(String(row.title ?? ''), 160),
        status: row.status,
        summary: truncateText(String(row.summary ?? ''), 320),
        priority: sanitizePriority(row.priority_json),
        updatedAt: row.updated_at,
      })),
    };
  }

  getTaskContext(taskId: string) {
    const row = this.db.prepare(`
      SELECT id, title, goal, status, summary, snapshot_json, resources_json,
             artifacts_json, dependencies_json, priority_json,
             last_scheduling_reason, last_interruption_reason, interruption_count,
             created_at, updated_at
      FROM tasks WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return { found: false, taskId };
    const snapshots = safeJson<Array<Record<string, unknown>>>(row.snapshot_json, []);
    const dependencies = safeJson<Array<Record<string, unknown>>>(row.dependencies_json, []);
    const latest = snapshots.at(-1) ?? null;
    return {
      found: true,
      task: {
        id: row.id,
        title: truncateText(String(row.title ?? ''), 200),
        goal: truncateText(String(row.goal ?? ''), 800),
        status: row.status,
        summary: truncateText(String(row.summary ?? ''), 800),
        priority: sanitizePriority(row.priority_json),
        latestSnapshot: latest ? sanitizeSnapshot(latest) : null,
        blockers: dependencies
          .filter(item => item.status === 'waiting')
          .slice(0, MAX_RESULTS)
          .map(item => ({ taskId: item.taskId, description: truncateText(String(item.description ?? ''), 320) })),
        resources: safeJson<unknown[]>(row.resources_json, []).slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)),
        artifacts: safeJson<unknown[]>(row.artifacts_json, []).slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)),
        lastSchedulingReason: truncateText(String(row.last_scheduling_reason ?? ''), 320),
        lastInterruptionReason: truncateText(String(row.last_interruption_reason ?? ''), 320),
        interruptionCount: row.interruption_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  }

  getCurrentSessionContext(limit?: number) {
    const bounded = boundedLimit(limit);
    const interactions = this.db.prepare(`
      SELECT id, task_id, user_input, system_output, executor_used, created_at
      FROM interactions WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(this.sessionId, bounded) as Array<Record<string, unknown>>;
    const decisions = this.db.prepare(`
      SELECT id, task_id, event_json, decision_json, action, reason, created_at
      FROM kernel_decisions WHERE session_id = ? AND event_type = 'plan_proposed'
      ORDER BY created_at DESC LIMIT ?
    `).all(this.sessionId, Math.min(5, bounded)) as Array<Record<string, unknown>>;
    const recentPlanningDecisions = decisions
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .slice(-Math.min(5, bounded));
    return {
      sessionId: this.sessionId,
      interactions: interactions.reverse().map(row => ({
        interactionId: row.id,
        taskId: row.task_id,
        userInput: truncateText(String(row.user_input ?? ''), 500),
        systemOutput: truncateText(String(row.system_output ?? ''), 500),
        executorUsed: row.executor_used,
        createdAt: row.created_at,
      })),
      recentPlanningDecisions: recentPlanningDecisions.map(row => {
        const event = safeJson<Record<string, unknown>>(row.event_json, {});
        const plan = isRecord(event.proposal) ? event.proposal : {};
        const task = isRecord(plan.task) ? plan.task : {};
        const risk = isRecord(plan.risk) ? plan.risk : {};
        return {
          id: row.id,
          taskId: row.task_id,
          requestText: truncateText(String(event.requestText ?? ''), 500),
          action: plan.action,
          control: task.control,
          targetTaskId: task.taskId,
          clarificationQuestion: truncateText(String(plan.clarificationQuestion ?? ''), 500) || null,
          outcome: 'issued',
          kernelAction: row.action,
          riskRequiresConfirmation: risk.requiresConfirmation === true,
          reason: truncateText(String(row.reason ?? ''), 320),
          createdAt: row.created_at,
        };
      }),
    };
  }

  getSessionInteraction(input: { interactionId: string; side: 'user' | 'assistant' }) {
    const row = this.db.prepare(`
      SELECT id, task_id, user_input, system_output, executor_used, created_at
      FROM interactions WHERE id = ? AND session_id = ?
    `).get(input.interactionId, this.sessionId) as Record<string, unknown> | undefined;
    if (!row) return { found: false, interactionId: input.interactionId };
    const content = input.side === 'user' ? row.user_input : row.system_output;
    return {
      found: true,
      interactionId: row.id,
      taskId: row.task_id,
      side: input.side,
      content: truncateText(String(content ?? ''), 4_000),
      truncated: String(content ?? '').length > 4_000,
      executorUsed: row.executor_used,
      createdAt: row.created_at,
    };
  }

  getRuntimeState() {
    const focus = this.db.prepare('SELECT * FROM session_state WHERE id = ?').get('global') as Record<string, unknown> | undefined;
    const taskCounts = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as Array<Record<string, unknown>>;
    const activeTasks = this.db.prepare(`
      SELECT id, title, status, updated_at FROM tasks
      WHERE status IN ('created', 'ready', 'running', 'parked', 'blocked')
      ORDER BY updated_at DESC LIMIT ?
    `).all(MAX_RESULTS) as Array<Record<string, unknown>>;
    return {
      focus: focus ? {
        taskId: focus.last_focused_task_id,
        lastCompletedTaskId: focus.last_completed_task_id,
        updatedAt: focus.updated_at,
      } : null,
      taskCounts: Object.fromEntries(taskCounts.map(row => [String(row.status), Number(row.count)])),
      activeTasks: activeTasks.map(row => ({
        id: row.id,
        title: truncateText(String(row.title ?? ''), 160),
        status: row.status,
        updatedAt: row.updated_at,
      })),
    };
  }

  listExecutorStatus() {
    const rows = this.db.prepare(`
      SELECT a.name, s.class_health, s.recent_attempts_json,
             s.recent_recovery_checks_json, s.updated_at
      FROM agent_classes a
      LEFT JOIN kernel_executor_status s ON s.agent_class_name = a.name
      WHERE a.kind = 'executor'
      ORDER BY a.name ASC
    `).all() as Array<Record<string, unknown>>;
    return {
      count: rows.length,
      executorStatuses: rows.map(row => ({
        agentClassName: String(row.name),
        classHealth: typeof row.class_health === 'string' ? row.class_health : 'unverified',
        recentAttempts: safeJson(row.recent_attempts_json, []).slice(0, 3),
        recentRecoveryChecks: safeJson(row.recent_recovery_checks_json, []).slice(0, 3),
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      })),
    };
  }

  getPlanningContext() {
    const preferences = this.db.prepare(`
      SELECT id, type, scope, subject, content, confirmed_at
      FROM preferences
      WHERE status = 'confirmed' AND scope = 'global'
      ORDER BY COALESCE(confirmed_at, updated_at) DESC
      LIMIT ?
    `).all(MAX_RESULTS) as Array<Record<string, unknown>>;
    const pending = this.db.prepare(`
      SELECT id, task_id, capability, resource_text, operation, reason, created_at
      FROM permission_requests
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return {
      sessionId: this.sessionId,
      confirmedPreferences: preferences.map(row => ({
        id: row.id,
        type: row.type,
        scope: row.scope,
        subject: row.subject,
        content: truncateText(String(row.content ?? ''), 1_000),
        confirmedAt: row.confirmed_at,
      })),
      pendingAuthorizationRequest: pending ? {
        requestId: pending.id,
        taskId: pending.task_id,
        capability: pending.capability,
        resource: pending.resource_text,
        operation: pending.operation,
        reason: truncateText(String(pending.reason ?? ''), 1_000),
        createdAt: pending.created_at,
      } : null,
      routingCatalog: getPlannerExecutorCatalog(),
    };
  }

  getExecutorDiagnostics(input: { agentClassName?: string; limit?: number }) {
    const limit = boundedLimit(input.limit);
    const params: unknown[] = [];
    const classFilter = input.agentClassName?.trim()
      ? 'AND w.agent_class_name = ?'
      : '';
    if (classFilter) params.push(input.agentClassName!.trim());
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT e.work_unit_id, w.agent_class_name, e.task_id, e.subtask_id,
             e.event_type, e.state, e.message, e.created_at
      FROM work_unit_events e
      JOIN work_units w ON w.id = e.work_unit_id
      WHERE e.event_type = 'probe_failed'
      ${classFilter}
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;
    return {
      count: rows.length,
      failures: rows.map(row => ({
        workUnitId: row.work_unit_id,
        agentClassName: row.agent_class_name,
        taskId: row.task_id,
        subtaskId: row.subtask_id,
        eventType: row.event_type,
        state: row.state,
        reason: truncateText(String(row.message ?? ''), 800),
        createdAt: row.created_at,
      })),
    };
  }
}

export function createPlannerMcpServer(reader: PlannerDataReader): McpServer {
  const server = new McpServer({ name: 'metaclaw-planner', version: '1.0.0' });
  server.registerTool('search_tasks', {
    description: 'Search persisted MetaClaw tasks by text and status. All persisted tasks are durable.',
    inputSchema: {
      query: z.string().max(500).optional(),
      statuses: z.array(z.enum(TASK_STATUSES)).max(TASK_STATUSES.length).optional(),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
    },
  }, async input => toolResult(reader.searchTasks(input)));
  server.registerTool('get_task_context', {
    description: 'Read one task status, snapshot, blockers, resources, completed items, pending items, and next step.',
    inputSchema: { taskId: z.string().min(1).max(160) },
  }, async input => toolResult(reader.getTaskContext(input.taskId)));
  server.registerTool('get_current_session_context', {
    description: 'Read bounded durable MetaClaw interaction and planning-decision audit facts for the current trusted session. The persisted AnyFusion-Pi session is the authority for dialogue continuity.',
    inputSchema: { limit: z.number().int().min(1).max(MAX_RESULTS).optional() },
  }, async input => toolResult(reader.getCurrentSessionContext(input.limit)));
  server.registerTool('get_planning_context', {
    description: 'Read current session Planner facts: bounded confirmed preferences, the exact pending authorization request, and canonical routing capabilities and AgentClasses. Call before executable planning, preference-dependent replies, or authorization resolution.',
    inputSchema: {},
  }, async () => toolResult(reader.getPlanningContext()));
  server.registerTool('get_session_interaction', {
    description: 'Read one bounded interaction side by stable ID only when the current user explicitly referenced it.',
    inputSchema: {
      interactionId: z.string().min(1).max(160),
      side: z.enum(['user', 'assistant']),
    },
  }, async input => toolResult(reader.getSessionInteraction(input)));
  server.registerTool('get_runtime_state', {
    description: 'Read current task focus and active task state without changing runtime state.',
    inputSchema: {},
  }, async () => toolResult(reader.getRuntimeState()));
  server.registerTool('list_executor_status', {
    description: 'List bounded Kernel executor class health and three recent safe execution outcomes. Static routing capabilities are already in Planner startup context.',
    inputSchema: {},
  }, async () => toolResult(reader.listExecutorStatus()));
  server.registerTool('get_executor_diagnostics', {
    description: 'Read recent bounded executor probe failures and their persisted safe reasons when the user asks why execution is blocked or an executor is unavailable.',
    inputSchema: {
      agentClassName: z.string().min(1).max(160).optional(),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
    },
  }, async input => toolResult(reader.getExecutorDiagnostics(input)));
  return server;
}

export async function runPlannerMcpServer(): Promise<void> {
  const home = process.env.METACLAW_HOME;
  const sessionId = process.env.METACLAW_PLANNER_SESSION_ID;
  if (!home) throw new Error('METACLAW_HOME is required');
  if (!sessionId) throw new Error('METACLAW_PLANNER_SESSION_ID is required');
  const dbPath = process.env.METACLAW_DB_PATH ?? join(home, 'metaclaw.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const server = createPlannerMcpServer(new PlannerDataReader(db, sessionId));
  await server.connect(new StdioServerTransport());
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function boundedLimit(limit?: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, limit ?? DEFAULT_RESULTS));
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function sanitizeSnapshot(snapshot: Record<string, unknown>) {
  return {
    done: Array.isArray(snapshot.done) ? snapshot.done.slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)) : [],
    pending: Array.isArray(snapshot.pending) ? snapshot.pending.slice(0, MAX_RESULTS).map(value => truncateText(String(value), 240)) : [],
    nextStep: truncateText(String(snapshot.nextStep ?? ''), 500),
    pauseReason: truncateText(String(snapshot.pauseReason ?? ''), 500),
    createdAt: snapshot.createdAt,
  };
}

function sanitizePriority(value: unknown): Record<string, unknown> {
  const parsed = safeJson<unknown>(value, {});
  const priority = isRecord(parsed) ? parsed : {};
  if (typeof priority.semanticPriorityReason !== 'string') return priority;
  return {
    ...priority,
    semanticPriorityReason: truncateText(priority.semanticPriorityReason, 320),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
