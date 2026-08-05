import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Subtask, Task, WorkspaceContext } from '../core/types.js';
import { PreferenceRepo } from '../storage/preference-repo.js';
import type { PersistedSubtaskHandoff } from '../storage/subtask-handoff-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { ContextRef, WorkGraphRequiredItem } from '../work-graph/index.js';
import { contextRefKey } from '../work-graph/index.js';
import {
  createEvidenceId,
  type ExecutionEvidencePort,
  ScopedExecutionEvidencePort,
  TaskExecutionEvidenceRepo,
} from './execution-evidence-port.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { COMPLETION_MARKER_V3 } from './completion-protocol.js';
import type { ExecutionEvidenceToolBinding } from './execution-evidence-tool-server.js';

export interface SelectedExecutionEvidence {
  ref: ContextRef;
  evidenceId: string;
  title: string;
  content: string;
  truncated: boolean;
}

export interface SubtaskExecutionContext {
  taskBackground: { id: string; title: string; goal: string; instruction: 'background_only' };
  currentSubtask: Pick<Subtask, 'id' | 'title' | 'goal' | 'deliveryKind' | 'acceptance'>;
  incomingHandoffs: PersistedSubtaskHandoff[];
  outgoingHandoffRequirements: Array<{ toSubtaskId: string; requiredItems: WorkGraphRequiredItem[] }>;
  selectedEvidence: SelectedExecutionEvidence[];
  outOfScopeSiblings: Array<{ id: string; title: string }>;
  workspaceContext: WorkspaceContext;
  identity: { executionId: string; taskId: string; subtaskId: string; attemptId: string; workUnitId: string };
  completionContract:
    | { marker: typeof COMPLETION_MARKER_V3; schemaVersion: 3 }
    | {
        marker: '---METACLAW-MERGE-REPAIR---';
        protocol: 'metaclaw:merge-repair:v1';
        allowedPaths: string[];
      };
  recovery?: {
    mode: 'native_session' | 'recovery_packet' | 'fresh';
    sourceAttemptId: string | null;
    packet: Record<string, unknown> | null;
  };
  evidenceTools: {
    availability: 'available' | 'unavailable';
    reason: string;
    port?: ExecutionEvidencePort;
    binding?: ExecutionEvidenceToolBinding;
  };
}

export class SubtaskExecutionContextBuilder {
  private readonly evidenceRepo: TaskExecutionEvidenceRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;
  private readonly preferenceRepo: PreferenceRepo;

  constructor(private readonly db: Database.Database) {
    this.evidenceRepo = new TaskExecutionEvidenceRepo(db);
    this.handoffRepo = new SubtaskHandoffRepo(db);
    this.preferenceRepo = new PreferenceRepo(db);
  }

  build(input: {
    executionId: string;
    task: Task;
    subtask: Subtask;
    allSubtasks: Subtask[];
    attemptId: string;
    workUnitId: string;
    sessionId: string;
    workspaceContext: WorkspaceContext;
    evidenceToolsAvailable: boolean;
    currentSubtaskOverride?: Partial<SubtaskExecutionContext['currentSubtask']>;
    completionContractOverride?: SubtaskExecutionContext['completionContract'];
    recovery?: SubtaskExecutionContext['recovery'];
    evidenceToolBinding?: ExecutionEvidenceToolBinding;
  }): { context: SubtaskExecutionContext; evidenceCapability: ScopedExecutionEvidencePort } {
    this.syncTaskEvidenceCatalog(input.task);
    const incomingHandoffs = this.handoffRepo.listIncoming(input.task.id, input.subtask.id);
    assertIncomingHandoffsComplete(input.subtask, incomingHandoffs);
    const outgoingHandoffRequirements = input.allSubtasks.flatMap(candidate => {
      const dependency = candidate.dependencies.find(item => item.fromSubtaskId === input.subtask.id);
      return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
    });
    const selectedEvidence = this.resolveSelectedEvidence(input);
    const exactEvidenceIds = new Set(selectedEvidence
      .filter(item => item.ref.kind === 'interaction' && item.ref.side === 'assistant')
      .map(item => item.evidenceId));
    const evidenceCapability = new ScopedExecutionEvidencePort(
      this.evidenceRepo,
      new TaskEventRepo(this.db),
      {
        taskId: input.task.id,
        subtaskId: input.subtask.id,
        attemptId: input.attemptId,
        exactEvidenceIds,
      },
    );
    return {
      evidenceCapability,
      context: {
        taskBackground: {
          id: input.task.id,
          title: input.task.title,
          goal: input.task.goal,
          instruction: 'background_only',
        },
        currentSubtask: {
          id: input.subtask.id,
          title: input.subtask.title,
          goal: input.subtask.goal,
          deliveryKind: input.subtask.deliveryKind,
          acceptance: input.subtask.acceptance,
          ...input.currentSubtaskOverride,
        },
        incomingHandoffs,
        outgoingHandoffRequirements,
        selectedEvidence,
        outOfScopeSiblings: input.allSubtasks
          .filter(candidate => candidate.id !== input.subtask.id)
          .map(candidate => ({ id: candidate.id, title: candidate.title })),
        workspaceContext: input.workspaceContext,
        identity: {
          executionId: input.executionId,
          taskId: input.task.id,
          subtaskId: input.subtask.id,
          attemptId: input.attemptId,
          workUnitId: input.workUnitId,
        },
        completionContract: input.completionContractOverride
          ?? { marker: COMPLETION_MARKER_V3, schemaVersion: 3 },
        recovery: input.recovery,
        evidenceTools: input.evidenceToolsAvailable
          ? {
              availability: 'available',
              reason: 'attempt-scoped evidence capability is active',
              port: evidenceCapability,
              binding: input.evidenceToolBinding,
            }
          : { availability: 'unavailable', reason: 'this Executor Adapter does not support the evidence tool protocol' },
      },
    };
  }

  private syncTaskEvidenceCatalog(task: Task): void {
    const interactions = this.db.prepare(`
      SELECT id, user_input, created_at
      FROM interactions
      WHERE task_id = ? AND TRIM(COALESCE(user_input, '')) <> ''
      ORDER BY created_at ASC, id ASC
    `).all(task.id) as Array<{ id: string; user_input: string; created_at: string }>;
    for (const interaction of interactions) {
      this.evidenceRepo.upsert({
        id: createEvidenceId('user_interaction', interaction.id),
        taskId: task.id,
        kind: 'user_input',
        sourceId: interaction.id,
        title: `User interaction ${interaction.id}`,
        content: interaction.user_input,
        createdAt: interaction.created_at,
      });
    }
    for (const locator of task.resources) {
      this.evidenceRepo.upsert({
        id: createEvidenceId('task_resource', locator),
        taskId: task.id,
        kind: 'task_resource',
        sourceId: locator,
        title: locator,
        content: readTaskResource(locator),
      });
    }
    const injected = new Set(task.injectedPreferences);
    for (const preference of this.preferenceRepo.findByStatus('confirmed')) {
      if (!injected.has(preference.content) && !preference.sourceTasks.includes(task.id)) continue;
      this.evidenceRepo.upsert({
        id: createEvidenceId('preference', preference.id),
        taskId: task.id,
        kind: 'preference',
        sourceId: preference.id,
        title: `Confirmed preference ${preference.id}`,
        content: preference.content,
        createdAt: preference.createdAt,
      });
    }
  }

  private resolveSelectedEvidence(input: {
    task: Task;
    subtask: Subtask;
    sessionId: string;
  }): SelectedExecutionEvidence[] {
    const refs = [...input.subtask.contextRefs].sort((left, right) => contextRefKey(left).localeCompare(contextRefKey(right)));
    const perRefBudget = Math.min(4_000, refs.length > 0 ? Math.floor(24_000 / refs.length) : 4_000);
    return refs.map(ref => this.resolveEvidenceRef(ref, input.task, input.sessionId, perRefBudget));
  }

  private resolveEvidenceRef(
    ref: ContextRef,
    task: Task,
    sessionId: string,
    budget: number,
  ): SelectedExecutionEvidence {
    let evidenceId: string;
    let title: string;
    let content: string;
    let exactOnly = false;
    if (ref.kind === 'current_user_input') {
      evidenceId = createEvidenceId('current_user_input', task.id);
      const row = this.evidenceRepo.findForTask(task.id, evidenceId);
      if (!row) throw new Error('current_user_input evidence was not materialized with the work graph');
      title = 'Current user input';
      content = row.content;
    } else if (ref.kind === 'task_resource') {
      if (!task.resources.includes(ref.locator)) throw new Error(`task_resource_not_authorized: ${ref.locator}`);
      evidenceId = createEvidenceId('task_resource', ref.locator);
      title = ref.locator;
      content = readTaskResource(ref.locator);
      this.evidenceRepo.upsert({ id: evidenceId, taskId: task.id, kind: 'task_resource', sourceId: ref.locator, title, content });
    } else if (ref.kind === 'preference') {
      const preference = this.preferenceRepo.findById(ref.preferenceId);
      if (!preference || preference.status !== 'confirmed') throw new Error(`preference_not_authorized: ${ref.preferenceId}`);
      evidenceId = createEvidenceId('preference', preference.id);
      title = `Confirmed preference ${preference.id}`;
      content = preference.content;
      this.evidenceRepo.upsert({ id: evidenceId, taskId: task.id, kind: 'preference', sourceId: preference.id, title, content });
    } else if (ref.kind === 'task_evidence') {
      const row = this.evidenceRepo.findForTask(task.id, ref.evidenceId);
      if (!row || row.kind !== 'task_evidence') throw new Error(`task_evidence_not_authorized: ${ref.evidenceId}`);
      evidenceId = row.id;
      title = row.title;
      content = row.content;
    } else {
      evidenceId = createEvidenceId(`${ref.side}_interaction`, ref.interactionId);
      const materialized = this.evidenceRepo.findForTask(task.id, evidenceId);
      if (materialized) {
        title = materialized.title;
        content = materialized.content;
        exactOnly = ref.side === 'assistant';
      } else {
      const row = this.db.prepare(`
        SELECT id, task_id, session_id, user_input, system_output, created_at
        FROM interactions WHERE id = ?
      `).get(ref.interactionId) as {
        id: string;
        task_id: string | null;
        session_id: string | null;
        user_input: string;
        system_output: string;
        created_at: string;
      } | undefined;
      if (!row || row.task_id !== task.id || row.session_id !== sessionId) {
        throw new Error(`interaction_not_authorized: ${ref.interactionId}`);
      }
      evidenceId = createEvidenceId(`${ref.side}_interaction`, row.id);
      title = `${ref.side} interaction ${row.id}`;
      content = ref.side === 'user' ? row.user_input : row.system_output;
      exactOnly = ref.side === 'assistant';
      this.evidenceRepo.upsert({
        id: evidenceId,
        taskId: task.id,
        kind: ref.side === 'assistant' ? 'assistant_ref' : 'user_input',
        sourceId: row.id,
        title,
        content,
        exactOnly,
        createdAt: row.created_at,
      });
      }
    }
    const truncated = content.length > budget;
    const preview = truncated
      ? `${content.slice(0, Math.max(0, budget - 48))}\n[TRUNCATED: use evidence get for remaining content]`
      : content;
    return { ref, evidenceId, title, content: preview, truncated };
  }
}

function readTaskResource(locator: string): string {
  if (!existsSync(locator)) return locator;
  try {
    return readFileSync(locator, 'utf8');
  } catch {
    return `[Resource is not readable as UTF-8 text: ${locator}]`;
  }
}

function assertIncomingHandoffsComplete(subtask: Subtask, handoffs: PersistedSubtaskHandoff[]): void {
  const actual = new Set(handoffs.map(handoff => handoff.fromSubtaskId));
  const missing = subtask.dependencies
    .map(dependency => dependency.fromSubtaskId)
    .filter(dependencyId => !actual.has(dependencyId));
  if (missing.length > 0) throw new Error(`incoming_handoff_missing: ${missing.join(', ')}`);
}
