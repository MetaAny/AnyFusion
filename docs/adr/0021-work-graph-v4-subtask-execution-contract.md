# ADR-0021: Work Graph v4 And Subtask Execution Contract

- Status: Accepted
- Date: 2026-07-17
- Scope: Work Graph contract, Subtask execution context, dependency handoff, completion protocol, execution evidence, and minimal attempt audit
- Affects: ADR-0020
- Amendment: supersedes ADR-0019's v3 plan/work-graph wire contract; ADR-0019 is archived migration context

## Context

Work Graph v3 establishes DAG authority and capability routing, but `dependsOn` carries only ordering. Executor input still receives Task-level history and memory bundles, so a single invocation can repeat sibling work or the top-level goal. Dependency results have no typed handoff contract, completion output has no machine-readable envelope, and WorkUnit facts do not identify a stable attempt.

## Decision

### Work Graph v4

`PlanningAgentPlan.schemaVersion` is exactly `4`. A Subtask uses structured `dependencies`, typed `contextRefs`, and keyed acceptance criteria. Each dependency declares one to twelve required items and supports only `text` and `artifact`; an empty ordering-only edge is invalid. Work Graph types and pure structural validation live behind an independent public seam consumed by Planning, Kernel, and Execution.

Keys match `^[a-z][a-z0-9_-]{0,63}$` and are unique within their acceptance or edge scope. Descriptions are non-empty and at most 500 characters. A node has one to twelve acceptance items, each with at most four evidence requirements, and at most twelve deduplicated context references. `dependencies` is the only topology and delivery source; `dependsOn` is not accepted. Planner declares semantic contracts, Kernel checks graph/routing/reference eligibility, and Runtime consumes the authorized facts without reinterpretation.

### Execution scope

The current Subtask goal is the only operational instruction. The top-level Task is background. Direct dependency handoffs are the only execution results admitted into a downstream context. Siblings are represented only by ID and title as explicit out-of-scope work. Ordinary assistant and Executor history is excluded.

Planner selects stable evidence references. A prior assistant body is eligible only when the user explicitly references it and the reference resolves conservatively to a same-session interaction. Codex and Pi may retrieve Task-scoped user evidence through an attempt-bound read-only port; unsupported executors receive only Planner-selected previews.

Selected evidence previews are stable-sorted and fairly budgeted: at most 4,000 characters per reference and 24,000 total, with explicit truncation markers. `current_user_input` is materialized as stable Task evidence when the graph is persisted. The evidence capability is bound to Task, Subtask, attempt, and process lifetime. General list/search exposes only current-Task user input, materials, and confirmed preferences; explicitly authorized assistant evidence is exact-get only. Pages contain at most 20 records, chunks at most 12,000 characters, and every access writes an `executor_evidence_accessed` Task event without copying evidence bodies.

### Completion protocol

Every Executor response ends with one final `<!-- metaclaw:completion:v1 -->` marker followed by a strict JSON envelope. The envelope identifies the Subtask, acceptance evidence, artifacts, and exact outgoing handoff deliveries. Runtime validates contract equality, size limits, and artifact containment under Task target paths. It persists normalized handoffs and removes the envelope from every user-visible, memory, interaction, and delivery path.

The strict budgets are: 128 KiB UTF-8 for the envelope; one to four acceptance evidence strings per key, 1,000 characters each and 12,000 total; 4,000 characters per text item; 12,000 text characters and 20 artifact paths per edge; 24,000 text characters and 40 artifact paths across all outgoing edges and across all incoming edges of one downstream node; 40 top-level artifacts; and 1,024 characters per path. Artifacts must exist and remain within Task `targetPaths` after realpath resolution; symlink escape is rejected and a handoff artifact must also appear in the top-level artifact set. No limit is satisfied by truncation.

The original v1 protocol used the stable blocking codes `completion_malformed`, `completion_subtask_mismatch`, `completion_acceptance_mismatch`, `completion_handoff_mismatch`, `completion_budget_exceeded`, `completion_artifact_invalid`, `completion_artifact_required`, and `completion_patch_evidence_missing`. Analysis source/limitation and review-verdict heuristics produced warnings only. That phase performed deterministic contract validation and did not claim independent semantic certification.

### Attempt and persistence

An opaque attempt ID is created before WorkUnit claim and remains bound to one Task, Subtask, AgentClass, and WorkUnit through release. Phase 2 persists an immutable terminal receipt containing raw response and validation facts, but no retry counters or recovery policy. Successful receipt, normalized handoffs, and Subtask completion are committed atomically. Contract errors block without retry.

The fixed attempt order is claim, `attempt_started`, context/evidence setup, one Adapter invocation, full-response parsing, deterministic gates, one terminal transaction, then unconditional release. Success atomically commits the receipt, every normalized handoff, clean result/artifacts/warnings, and Subtask `done`. Contract failure atomically commits the receipt and violations and blocks the Subtask/Task without publishing the body. Cancellation or state drift records `cancelled_or_stale` and cannot commit handoffs. Completed Subtasks and persisted handoffs are immutable recovery facts and are never rerun or reparsed.

SQLite schema v22 renames the previous production table to read-only `subtasks_v3_audit`, creates the v4 `subtasks`, `subtask_handoffs`, `executor_attempt_receipts`, and Task-evidence storage, adds `claimed_attempt_id`, and enforces at most one active attempt per Subtask. Non-terminal v3 Tasks are parked for a user-triggered v4 replan; terminal Tasks stay terminal. Migration, startup, timers, and `/task resume` never perform semantic replan or implicit retry.

### Phase boundaries

Phase 2 stays serial. Phase 3 introduces a `handoff_contract_failed` Kernel event carrying attempt, Subtask, WorkUnit, authorized completion contract, and all violations; it may authorize exactly one same-AgentClass correction attempt with precise trailer feedback. A second failure blocks without fallback or backoff. Phase 4 owns general retry/fallback/backoff/circuit-breaker state. Phase 5 introduces partition leases and a versioned `workspace_state` handoff rather than reserving an untyped placeholder now.

### Phase 5 amendment (2026-07-22)

ADR-0024 delivers the deferred workspace contract. Each Task generation + Subtask now owns a persistent workspace whose immutable checkpoint manifest is the versioned `workspace_state`. A downstream Subtask may compose state only from its completed direct dependencies; Runtime must block a conflict and submit a normalized Kernel fact rather than absorb sibling or user-working-tree state implicitly. Git workspace state identifies the MetaClaw-managed commit/branch/diff facts, while non-Git state identifies the workspace URI, checkpoint and content-addressed objects. Large bodies remain outside SQLite.

### Work Graph v6 and identity-free Completion Protocol v3 amendment (2026-08-03)

PlanningAgentPlan hard-upgrades to v7 and the Work Graph contract baseline to v6. `expectedOutput` is removed and every Subtask declares `deliveryKind: edit | report`. The Work Graph wire object does not gain its own schema-version field. Acceptance remains structured; Runtime no longer infers delivery semantics from patch/artifact/analysis/review text categories.

The model-facing Completion Protocol hard-upgrades to v3. A successful report contains only bounded `evidence` strings and nullable `noChangeReason`; a failed report retains the controlled `failure` object. The model does not emit artifacts, schema/status identity, Task/Subtask/attempt/WorkUnit IDs, acceptance keys, or outgoing handoff identities and keys.

After a successful Executor response and before completion validation, Runtime computes and persists one authoritative workspace delta. `report` requires zero created/modified/deleted paths and null `noChangeReason`; changed `edit` requires a null reason; zero-delta `edit` requires a non-empty reason. Runtime derives artifacts from created/modified files only, while deletions remain visible in delta/evidence. Truncated or indeterminate delta fails closed, and response-only correction reuses the source attempt's persisted delta. Runtime then materializes authoritative acceptance and handoff identities. Completion v2, the original v1 blocking-code set, patch/artifact heuristics, and old output-kind execution paths are historical only and are rejected rather than dual-read or repaired.

## Consequences

- Existing non-terminal v3 graphs cannot be executed under the new handoff contract and must be parked for natural-language replanning.
- Executor Adapters become transport-only and consume the same Subtask context semantics.
- Completion formatting is now a strict execution contract; malformed output is a deterministic blocked result rather than best-effort text.
- Storage gains v3 audit, normalized handoff, attempt receipt, and attempt-aware WorkUnit projections.
