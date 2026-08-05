import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Subtask } from '../core/types.js';
import type { WorkGraphRequiredItem } from '../work-graph/index.js';
import { parseWorkspaceDelta, type WorkspaceDelta } from './workspace-change-tracker.js';

export const COMPLETION_MARKER_V3 = '<!-- metaclaw:completion:v3 -->';
const MAX_REPORT_BYTES = 128 * 1024;

const TextItemSchema = z.object({
  key: z.string(),
  type: z.literal('text'),
  value: z.string(),
}).strict();
const ArtifactItemSchema = z.object({
  key: z.string(),
  type: z.literal('artifact'),
  paths: z.array(z.string()),
}).strict();
const FailureSchema = z.object({
  kind: z.enum(['capability_mismatch', 'task_failed', 'quality_failed']),
  code: z.string().trim().min(1).max(96),
  summary: z.string().trim().min(1).max(320),
}).strict();
const CompletedEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  status: z.literal('completed'),
  subtaskId: z.string(),
  acceptanceEvidence: z.array(z.object({
    key: z.string(),
    evidence: z.array(z.string()),
  }).strict()),
  artifacts: z.array(z.string()),
  handoffs: z.array(z.object({
    toSubtaskId: z.string(),
    items: z.array(z.discriminatedUnion('type', [TextItemSchema, ArtifactItemSchema])),
  }).strict()),
}).strict();
const FailedEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  status: z.literal('failed'),
  subtaskId: z.string(),
  failure: FailureSchema,
}).strict();
const CompletionEnvelopeSchema = z.discriminatedUnion('status', [CompletedEnvelopeSchema, FailedEnvelopeSchema]);
const CompletedReportSchema = z.object({
  evidence: z.array(z.string().trim().min(1).max(1_000)).min(1).max(4),
  noChangeReason: z.string().trim().min(1).max(1_000).nullable(),
}).strict();
const FailedReportSchema = z.object({ failure: FailureSchema }).strict();
const CompletionReportSchema = z.union([CompletedReportSchema, FailedReportSchema]);

export type CompletionEnvelopeV3 = z.infer<typeof CompletionEnvelopeSchema>;
export type CompletedEnvelopeV3 = z.infer<typeof CompletedEnvelopeSchema>;
export type CompletionHandoffV3 = CompletedEnvelopeV3['handoffs'][number];
type CompletionReport = z.infer<typeof CompletionReportSchema>;

export type CompletionContractErrorCode =
  | 'completion_acceptance_mismatch'
  | 'completion_artifact_invalid'
  | 'completion_budget_exceeded'
  | 'completion_handoff_mismatch'
  | 'completion_malformed'
  | 'completion_no_change_reason_mismatch'
  | 'completion_report_workspace_changed'
  | 'completion_subtask_mismatch'
  | 'completion_workspace_delta_uncertain';

export interface CompletionContractViolation {
  code: CompletionContractErrorCode;
  path: string;
  message: string;
}

export type CompletionProtocolResult =
  | {
    ok: true;
    body: string;
    envelope: CompletionEnvelopeV3;
    normalizedArtifacts: string[];
    warnings: string[];
  }
  | {
    ok: false;
    body: string | null;
    envelope: CompletionEnvelopeV3 | null;
    violations: CompletionContractViolation[];
  };

export interface OutgoingHandoffContract {
  toSubtaskId: string;
  requiredItems: WorkGraphRequiredItem[];
}

export interface IncomingHandoffUsage {
  textCharacters: number;
  artifactPaths: number;
}

type ParsedCompletionReportResult =
  | { ok: true; body: string; report: CompletionReport }
  | Extract<CompletionProtocolResult, { ok: false }>;
type CompletionProtocolFailure = Extract<CompletionProtocolResult, { ok: false }>;

/** Parses, strips and deterministically verifies the exact v3 completion trailer. */
export function validateCompletionProtocol(input: {
  rawResponse: string;
  subtask: Subtask;
  outgoingHandoffs: OutgoingHandoffContract[];
  workspaceRoot: string;
  workspaceDelta: unknown;
  incomingUsageByTarget?: ReadonlyMap<string, IncomingHandoffUsage>;
}): CompletionProtocolResult {
  const parsed = parseCompletion(input.rawResponse);
  if (!parsed.ok) return parsed;

  const violations: CompletionContractViolation[] = [];
  const { body } = parsed;
  if ('failure' in parsed.report) {
    const envelope = materializeCompletionEnvelope(parsed.report, input.subtask, input.outgoingHandoffs, []);
    return { ok: true, body, envelope, normalizedArtifacts: [], warnings: [] };
  }
  const workspaceDelta = parseWorkspaceDelta(input.workspaceDelta);
  if (!workspaceDelta) {
    return {
      ok: false,
      body,
      envelope: null,
      violations: [contractViolation(
        'completion_workspace_delta_uncertain',
        'workspaceDelta',
        'workspace delta is missing or malformed',
      )],
    };
  }
  const normalizedArtifacts = validateWorkspaceDelivery(
    input.subtask,
    parsed.report.noChangeReason,
    workspaceDelta,
    input.workspaceRoot,
    violations,
  );
  const envelope = materializeCompletionEnvelope(
    parsed.report,
    input.subtask,
    input.outgoingHandoffs,
    normalizedArtifacts,
  );
  if (envelope.subtaskId !== input.subtask.id) {
    violations.push(contractViolation('completion_subtask_mismatch', 'subtaskId', `expected ${input.subtask.id}, received ${envelope.subtaskId}`));
  }
  validateAcceptance(input.subtask, envelope, violations);
  validateHandoffs(input.outgoingHandoffs, envelope, violations);
  validateBudgets(envelope, violations, input.incomingUsageByTarget);

  if (violations.length > 0) {
    return { ok: false, body, envelope, violations: violations.sort(compareViolation) };
  }
  return {
    ok: true,
    body,
    envelope,
    normalizedArtifacts,
    warnings: [],
  };
}

function parseCompletion(rawResponse: string): ParsedCompletionReportResult {
  const markerMatches = [...rawResponse.matchAll(new RegExp(COMPLETION_MARKER_V3.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  if (markerMatches.length !== 1) {
    return failure('completion_malformed', 'marker', `expected exactly one final completion marker, received ${markerMatches.length}`);
  }
  const markerIndex = markerMatches[0]!.index!;
  const body = rawResponse.slice(0, markerIndex).trim();
  const rawReport = rawResponse.slice(markerIndex + COMPLETION_MARKER_V3.length).trimStart();
  if (!body) return failure('completion_malformed', 'body', 'completion body must be non-empty');
  if (!rawReport || Buffer.byteLength(rawReport, 'utf8') > MAX_REPORT_BYTES) {
    return failure('completion_budget_exceeded', 'report', 'completion report is empty or exceeds 128 KiB');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawReport);
  } catch (error) {
    return failure('completion_malformed', 'report', `completion report is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = CompletionReportSchema.safeParse(candidate);
  if (!report.success) {
    return {
      ok: false,
      body,
      envelope: null,
      violations: report.error.issues.map(issue => contractViolation(
        'completion_malformed',
        issue.path.join('.') || 'report',
        issue.message,
      )),
    };
  }
  return { ok: true, body, report: report.data };
}

function materializeCompletionEnvelope(
  report: CompletionReport,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): CompletionEnvelopeV3 {
  if ('failure' in report) {
    return {
      schemaVersion: 3,
      status: 'failed',
      subtaskId: subtask.id,
      failure: report.failure,
    };
  }
  const evidence = [...report.evidence];
  return {
    schemaVersion: 3,
    status: 'completed',
    subtaskId: subtask.id,
    acceptanceEvidence: subtask.acceptance.map(item => ({ key: item.key, evidence: [...evidence] })),
    artifacts,
    handoffs: outgoingHandoffs.map(contract => ({
      toSubtaskId: contract.toSubtaskId,
      items: contract.requiredItems.map(item => item.type === 'text'
        ? { key: item.key, type: 'text' as const, value: evidence.join('\n') }
        : { key: item.key, type: 'artifact' as const, paths: [...artifacts] }),
    })),
  };
}

function validateAcceptance(
  subtask: Subtask,
  envelope: CompletedEnvelopeV3,
  violations: CompletionContractViolation[],
): void {
  const expected = new Set(subtask.acceptance.map(item => item.key));
  const actual = new Set<string>();
  for (const [index, item] of envelope.acceptanceEvidence.entries()) {
    if (actual.has(item.key)) violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.key`, `duplicate acceptance key ${item.key}`));
    actual.add(item.key);
    if (item.evidence.length < 1 || item.evidence.length > 4) {
      violations.push(contractViolation('completion_acceptance_mismatch', `acceptanceEvidence.${index}.evidence`, 'acceptance evidence must contain 1 to 4 entries'));
    }
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      if (!evidence.trim() || evidence.length > 1_000) {
        violations.push(contractViolation('completion_budget_exceeded', `acceptanceEvidence.${index}.evidence.${evidenceIndex}`, 'evidence must contain 1 to 1000 characters'));
      }
    }
  }
  if (!sameSet(expected, actual)) {
    violations.push(contractViolation('completion_acceptance_mismatch', 'acceptanceEvidence', `acceptance keys must equal authorized keys: ${[...expected].sort().join(', ')}`));
  }
}

function validateHandoffs(
  contracts: OutgoingHandoffContract[],
  envelope: CompletedEnvelopeV3,
  violations: CompletionContractViolation[],
): void {
  const expectedByTarget = new Map(contracts.map(contract => [contract.toSubtaskId, contract.requiredItems]));
  const seenTargets = new Set<string>();
  for (const [handoffIndex, handoff] of envelope.handoffs.entries()) {
    if (seenTargets.has(handoff.toSubtaskId)) {
      violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.toSubtaskId`, `duplicate handoff target ${handoff.toSubtaskId}`));
    }
    seenTargets.add(handoff.toSubtaskId);
    const required = expectedByTarget.get(handoff.toSubtaskId);
    if (!required) {
      violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}`, `unauthorized handoff target ${handoff.toSubtaskId}`));
      continue;
    }
    const expectedItems = new Map(required.map(item => [item.key, item.type]));
    const actualItems = new Map<string, string>();
    for (const [itemIndex, item] of handoff.items.entries()) {
      if (actualItems.has(item.key)) violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.items.${itemIndex}.key`, `duplicate handoff item ${item.key}`));
      actualItems.set(item.key, item.type);
    }
    if (!sameMap(expectedItems, actualItems)) {
      violations.push(contractViolation('completion_handoff_mismatch', `handoffs.${handoffIndex}.items`, `handoff items must exactly match contract for ${handoff.toSubtaskId}`));
    }
  }
  if (!sameSet(new Set(expectedByTarget.keys()), seenTargets)) {
    violations.push(contractViolation('completion_handoff_mismatch', 'handoffs', 'handoff targets must exactly match authorized outgoing edges'));
  }
}

function validateBudgets(
  envelope: CompletedEnvelopeV3,
  violations: CompletionContractViolation[],
  incomingUsageByTarget: ReadonlyMap<string, IncomingHandoffUsage> | undefined,
): void {
  let totalText = 0;
  let totalHandoffArtifacts = 0;
  for (const [handoffIndex, handoff] of envelope.handoffs.entries()) {
    let edgeText = 0;
    let edgeArtifacts = 0;
    for (const [itemIndex, item] of handoff.items.entries()) {
      if (item.type === 'text') {
        edgeText += item.value.length;
        totalText += item.value.length;
        if (!item.value.trim() || item.value.length > 4_000) {
          violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.items.${itemIndex}.value`, 'text handoff item must contain 1 to 4000 characters'));
        }
      } else {
        edgeArtifacts += item.paths.length;
        totalHandoffArtifacts += item.paths.length;
        if (item.paths.length < 1 || item.paths.length > 20) {
          violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.items.${itemIndex}.paths`, 'artifact handoff item must contain 1 to 20 paths'));
        }
      }
    }
    if (edgeText > 12_000) violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}`, 'edge text exceeds 12000 characters'));
    if (edgeArtifacts > 20) violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}`, 'edge artifact paths exceed 20'));
    const existingIncoming = incomingUsageByTarget?.get(handoff.toSubtaskId);
    if ((existingIncoming?.textCharacters ?? 0) + edgeText > 24_000) {
      violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.toSubtaskId`, `all incoming handoff text for ${handoff.toSubtaskId} exceeds 24000 characters`));
    }
    if ((existingIncoming?.artifactPaths ?? 0) + edgeArtifacts > 40) {
      violations.push(contractViolation('completion_budget_exceeded', `handoffs.${handoffIndex}.toSubtaskId`, `all incoming handoff artifact paths for ${handoff.toSubtaskId} exceed 40`));
    }
  }
  if (totalText > 24_000) violations.push(contractViolation('completion_budget_exceeded', 'handoffs', 'all outgoing handoff text exceeds 24000 characters'));
  if (totalHandoffArtifacts > 40) violations.push(contractViolation('completion_budget_exceeded', 'handoffs', 'all outgoing handoff artifact paths exceed 40'));
  if (envelope.artifacts.length > 40) violations.push(contractViolation('completion_budget_exceeded', 'artifacts', 'node artifacts exceed 40 paths'));
}

function validateWorkspaceDelivery(
  subtask: Subtask,
  noChangeReason: string | null,
  delta: WorkspaceDelta,
  workspaceRoot: string,
  violations: CompletionContractViolation[],
): string[] {
  if (delta.baselineTruncated || delta.finalTruncated) {
    violations.push(contractViolation(
      'completion_workspace_delta_uncertain',
      'workspaceDelta',
      'workspace delta is truncated and cannot authorize completion',
    ));
    return [];
  }
  if (subtask.deliveryKind === 'report') {
    if (delta.changed.length > 0) {
      violations.push(contractViolation(
        'completion_report_workspace_changed',
        'workspaceDelta.changed',
        'report delivery must not change the workspace',
      ));
    }
    if (noChangeReason !== null) {
      violations.push(contractViolation(
        'completion_no_change_reason_mismatch',
        'noChangeReason',
        'report delivery requires noChangeReason to be null',
      ));
    }
    return [];
  }
  if (delta.changed.length === 0 && noChangeReason === null) {
    violations.push(contractViolation(
      'completion_no_change_reason_mismatch',
      'noChangeReason',
      'edit delivery without workspace changes requires a no-change reason',
    ));
  }
  if (delta.changed.length > 0 && noChangeReason !== null) {
    violations.push(contractViolation(
      'completion_no_change_reason_mismatch',
      'noChangeReason',
      'edit delivery with workspace changes requires noChangeReason to be null',
    ));
  }

  if (!existsSync(workspaceRoot)) {
    violations.push(contractViolation('completion_artifact_invalid', 'workspaceRoot', 'workspace root does not exist'));
    return [];
  }
  const realRoot = realpathSync(workspaceRoot);
  const artifacts: string[] = [];
  for (const [index, change] of delta.changed.entries()) {
    if (change.afterHash === null) continue;
    const candidate = resolve(workspaceRoot, change.path);
    if (!existsSync(candidate)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `workspaceDelta.changed.${index}.path`,
        `changed output does not exist: ${change.path}`,
      ));
      continue;
    }
    const real = realpathSync(candidate);
    if (!isWithin(realRoot, real)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `workspaceDelta.changed.${index}.path`,
        `changed output escapes the workspace: ${change.path}`,
      ));
      continue;
    }
    artifacts.push(real);
  }
  return artifacts;
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(normalizedParent);
}

function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function sameMap(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function failure(code: CompletionContractErrorCode, path: string, message: string): CompletionProtocolFailure {
  return { ok: false, body: null, envelope: null, violations: [contractViolation(code, path, message)] };
}

function contractViolation(code: CompletionContractErrorCode, path: string, message: string): CompletionContractViolation {
  return { code, path, message };
}

function compareViolation(left: CompletionContractViolation, right: CompletionContractViolation): number {
  return left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}
