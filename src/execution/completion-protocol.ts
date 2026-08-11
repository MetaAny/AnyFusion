import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Subtask } from '../core/types.js';
import type { WorkGraphRequiredItem } from '../work-graph/index.js';

export const COMPLETION_MARKER_V4 = '<!-- metaclaw:completion:v4 -->';
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_RESULT_DESCRIPTION_CHARS = 4_000;

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
  schemaVersion: z.literal(4),
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
  schemaVersion: z.literal(4),
  status: z.literal('failed'),
  subtaskId: z.string(),
  failure: FailureSchema,
}).strict();
const CompletionEnvelopeSchema = z.discriminatedUnion('status', [CompletedEnvelopeSchema, FailedEnvelopeSchema]);
const CompletedReportSchema = z.object({
  resultFilePaths: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
}).strict();
const FailedReportSchema = z.object({ failure: FailureSchema }).strict();
const CompletionReportSchema = z.union([CompletedReportSchema, FailedReportSchema]);

export type CompletionEnvelopeV4 = z.infer<typeof CompletionEnvelopeSchema>;
export type CompletedEnvelopeV4 = z.infer<typeof CompletedEnvelopeSchema>;
export type CompletionHandoffV4 = CompletedEnvelopeV4['handoffs'][number];
type CompletionReport = z.infer<typeof CompletionReportSchema>;
type CompletedReport = z.infer<typeof CompletedReportSchema>;
type FailedReport = z.infer<typeof FailedReportSchema>;
type FailedEnvelopeV4 = z.infer<typeof FailedEnvelopeSchema>;

export type CompletionContractErrorCode =
  | 'completion_acceptance_mismatch'
  | 'completion_artifact_invalid'
  | 'completion_budget_exceeded'
  | 'completion_handoff_mismatch'
  | 'completion_malformed'
  | 'completion_subtask_mismatch';

export interface CompletionContractViolation {
  code: CompletionContractErrorCode;
  path: string;
  message: string;
}

export type CompletionProtocolResult =
  | {
    ok: true;
    body: string;
    envelope: CompletionEnvelopeV4;
    normalizedArtifacts: string[];
    warnings: string[];
  }
  | {
    ok: false;
    body: string | null;
    envelope: CompletionEnvelopeV4 | null;
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

/** Parses, strips and deterministically verifies the exact v4 completion trailer. */
export function validateCompletionProtocol(input: {
  rawResponse: string;
  subtask: Subtask;
  outgoingHandoffs: OutgoingHandoffContract[];
  workspaceRoot: string;
  incomingUsageByTarget?: ReadonlyMap<string, IncomingHandoffUsage>;
}): CompletionProtocolResult {
  const parsed = parseCompletion(input.rawResponse);
  if (!parsed.ok) return parsed;

  const violations: CompletionContractViolation[] = [];
  const { body } = parsed;
  if ('failure' in parsed.report) {
    const envelope = materializeCompletionEnvelope(parsed.report, body, input.subtask, input.outgoingHandoffs, []);
    return { ok: true, body, envelope, normalizedArtifacts: [], warnings: [] };
  }
  const normalizedArtifacts = validateResultFiles(
    parsed.report.resultFilePaths ?? [],
    input.workspaceRoot,
    violations,
  );
  const envelope = materializeCompletionEnvelope(
    parsed.report,
    body,
    input.subtask,
    input.outgoingHandoffs,
    normalizedArtifacts,
  );
  if (envelope.subtaskId !== input.subtask.id) {
    violations.push(contractViolation('completion_subtask_mismatch', 'subtaskId', `expected ${input.subtask.id}, received ${envelope.subtaskId}`));
  }
  if (envelope.status !== 'completed') {
    return { ok: true, body, envelope, normalizedArtifacts, warnings: [] };
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
  const markerMatches = [...rawResponse.matchAll(new RegExp(COMPLETION_MARKER_V4.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  if (markerMatches.length !== 1) {
    return failure('completion_malformed', 'marker', `expected exactly one final completion marker, received ${markerMatches.length}`);
  }
  const markerIndex = markerMatches[0]!.index!;
  const body = rawResponse.slice(0, markerIndex).trim();
  const rawReport = rawResponse.slice(markerIndex + COMPLETION_MARKER_V4.length).trimStart();
  if (!body) return failure('completion_malformed', 'body', 'completion body must be non-empty');
  if (body.length > MAX_RESULT_DESCRIPTION_CHARS) {
    return failure('completion_budget_exceeded', 'body', 'result description exceeds 4000 characters');
  }
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
  report: CompletedReport,
  resultDescription: string,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): CompletedEnvelopeV4;
function materializeCompletionEnvelope(
  report: FailedReport,
  resultDescription: string,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): FailedEnvelopeV4;
function materializeCompletionEnvelope(
  report: CompletionReport,
  resultDescription: string,
  subtask: Subtask,
  outgoingHandoffs: OutgoingHandoffContract[],
  artifacts: string[],
): CompletionEnvelopeV4 {
  if ('failure' in report) {
    return {
      schemaVersion: 4,
      status: 'failed',
      subtaskId: subtask.id,
      failure: report.failure,
    };
  }
  const evidence = [resultDescription];
  return {
    schemaVersion: 4,
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
  envelope: CompletedEnvelopeV4,
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
      if (!evidence.trim() || evidence.length > MAX_RESULT_DESCRIPTION_CHARS) {
        violations.push(contractViolation('completion_budget_exceeded', `acceptanceEvidence.${index}.evidence.${evidenceIndex}`, 'result description must contain 1 to 4000 characters'));
      }
    }
  }
  if (!sameSet(expected, actual)) {
    violations.push(contractViolation('completion_acceptance_mismatch', 'acceptanceEvidence', `acceptance keys must equal authorized keys: ${[...expected].sort().join(', ')}`));
  }
}

function validateHandoffs(
  contracts: OutgoingHandoffContract[],
  envelope: CompletedEnvelopeV4,
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
  envelope: CompletedEnvelopeV4,
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

function validateResultFiles(
  declaredPaths: string[],
  workspaceRoot: string,
  violations: CompletionContractViolation[],
): string[] {
  if (declaredPaths.length === 0) return [];
  if (!existsSync(workspaceRoot)) {
    violations.push(contractViolation('completion_artifact_invalid', 'workspaceRoot', 'workspace root does not exist'));
    return [];
  }
  const realRoot = realpathSync(workspaceRoot);
  const artifacts: string[] = [];
  const seen = new Set<string>();
  for (const [index, declaredPath] of declaredPaths.entries()) {
    if (isAbsolute(declaredPath)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `resultFilePaths.${index}`,
        `result file path must be workspace-relative: ${declaredPath}`,
      ));
      continue;
    }
    const candidate = resolve(workspaceRoot, declaredPath);
    if (!existsSync(candidate)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `resultFilePaths.${index}`,
        `result file does not exist: ${declaredPath}`,
      ));
      continue;
    }
    const real = realpathSync(candidate);
    if (!isWithin(realRoot, real)) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `resultFilePaths.${index}`,
        `result file escapes the workspace: ${declaredPath}`,
      ));
      continue;
    }
    if (!statSync(real).isFile()) {
      violations.push(contractViolation(
        'completion_artifact_invalid',
        `resultFilePaths.${index}`,
        `result path is not a file: ${declaredPath}`,
      ));
      continue;
    }
    if (!seen.has(real)) {
      artifacts.push(real);
      seen.add(real);
    }
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
