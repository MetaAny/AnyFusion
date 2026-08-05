# ADR-0023: Durable Kernel Workflow, Recovery And Availability

- **Status**: Accepted
- **Date**: 2026-07-21
- **Scope**: Phase 4 durable workflow, application recovery, structured failure, retry/fallback, availability, continuation, replan revisions, outbox and manual recovery
- **Amends**: ADR-0017, ADR-0018, ADR-0021, ADR-0022
- **Governed by**: ADR-0020

## Context

ADR-0022 established a ledger-first synchronous loop but intentionally failed closed after a crash between Decision issuance and apply. It also deferred structured failure, retry/fallback, continuation, automatic replan and reliable external effects. Implementing these independently in Session, timers, adapters or a workflow framework would recreate competing strategic interpreters.

## Decision

MetaClaw introduces one durable application seam:

```ts
interface KernelWorkflow {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
  recover(): Promise<KernelRecoveryReport>;
}
```

`submit` durably enqueues before synchronously draining. `recover` reconciles applications, orphan attempts and due events before external input opens. The pure `ControlKernel.decide(event, snapshot)` Interface remains the only strategic authority.

SQLite v24 separates immutable authorization (`kernel_decisions`) from inbox lifecycle (`kernel_events`), application lifecycle (`kernel_decision_applications`), external effects (`kernel_effect_outbox`), attempt continuation metadata (`executor_attempt_runtime`) and work graph generations (`work_graph_revisions`). Issuance, application creation and source-event advancement are atomic. Runtime apply is idempotent by Decision ID and checks durable postconditions before mutating state.

Kernel contracts hard-upgrade to v2 and carry structured, bounded `KernelFailure` facts. Completion Protocol hard-upgrades to v2 and Work Graph/Planning to v5. Capacity remains separate from execution failure and never affects health history. Runtime and workflow engines may not perform hidden semantic retry.

Retry policy is deterministic: the preferred AgentClass gets at most one delayed continuation after a recoverable infrastructure failure; each fallback gets one attempt. Task/domain failure skips same-class retry. Exhaustion may authorize one automatic replan per user generation. Contract correction remains an isolated one-shot path.

AgentClass “circuit breaking” is a pure derived availability rule, not a new persisted state machine. Kernel interprets the bounded recent structured projection and explicit event time. Class-level permanent faults are skipped; three attributable transient failures in ten minutes cause a five-minute cooldown; the next eligible serial dispatch is the probe. Capacity and task-domain outcomes are excluded.

Recovery safety is canonical Routing Capability metadata: `read_only`, `workspace_reconcilable`, or `external_non_idempotent`. Native continuation is preferred, otherwise Runtime supplies a bounded recovery packet and workspace delta. Unknown non-idempotent external effects fail closed unless a stable provider idempotency key exists.

Replan creates a new graph revision within the same generation. Completed facts remain immutable task evidence, unfinished old nodes are cancelled, dependencies stay revision-local, and only the new revision provides the frontier. User plans and explicit recovery create generations; automatic revisions do not reset the one-replan quota.

External effects use an outbox. Unknown delivery without provider idempotency becomes `uncertain` and requires a Kernel-authorized Task recovery command; it is never blindly resent.

### Phase 5 amendment (2026-07-22)

Kernel contract v3 extends the same durable workflow with `permission_requested`, `permission_resolution_received`, `partition_conflict_observed` and `sandbox_lost`. Permission grants/denials/escalations, partition waits and workspace-attempt recovery are Decision actions, not Runtime policy. Runtime persists and checkpoints before pausing or destroying an attempt; duplicate request/event/apply identities reuse the prior Decision, grant, lease or outbox effect. Startup reconciles Docker labels with SQLite before accepting input and converts missing or leftover sandboxes into normalized events. ADR-0024 owns the detailed resource, workspace and elevation contracts.

### Executor error recovery amendment (2026-07-30)

Kernel wire/ledger contract v5 closes the availability-replan lifecycle. Planning and recovery refresh start concurrently; plan admission waits for refresh completion. If an Executor used by the proposal recovers, Planner may revise the proposal once in the same native Codex thread. A second availability change does not start an unbounded repair loop.

An existing Task whose replan has no usable eligible Executor is not rejected as if it were a new request. Kernel authorizes `defer_task_plan_for_availability`: the Task becomes `blocked` with a `kernel_availability` dependency, the generation replan request becomes `waiting_for_availability`, and the exact Planner proposal plus natural-language explanation are persisted. Initial requests in the same condition produce a Planner direct reply and do not create a Task.

Successful recovery emits a durable `executor_recovered` fact. Kernel revalidates the current Task, generation/revision, deferred proposal and current Executor projection. A stale, cancelled, or still-exhausted proposal is a `no_op`; an executable proposal authorizes `activate_deferred_task_plan`. Runtime activates that graph revision, resolves the replan request, removes the availability blocker and moves the Task to `ready`, without immediately dispatching or inserting a recovery notification into the conversation.

Recovery refresh is event-driven at session startup, each planning cycle, Task recovery/resume, Executor configuration changes and `/executor refresh [name|all]`. It never runs as a periodic background health loop.

## LangGraph Boundary

LangGraph may replace only the durable workflow cursor/replay implementation after the MetaClaw contracts and fault tests freeze. The evaluation uses Functional API tasks and an independent SQLite checkpointer. Checkpoints are disposable implementation state: loss or corruption must be recoverable from the main database. LangGraph never owns Kernel policy, retry semantics, Work Graph topology, ledger authority, domain types or model/agent abstraction.

Adoption requires the full crash matrix, no domain-framework coupling, at least 30% net removal of cursor/replay implementation, checkpoint-loss recovery, and exactly one production workflow path. Failure of any gate requires deleting the spike and dependency.

### Planning v7 and schema v30 recovery amendment (2026-08-03)

SQLite schema v30 is the current baseline. The only supported upgrade is one
transactional 29→30 migration. It rebuilds active Subtasks with
`delivery_kind`, deterministically maps old output kinds, and upgrades every
still-recoverable v6 Planning/Work Graph payload in pending Kernel events,
unapplied decisions/applications, active dispatch, and unresolved deferred
replans. Terminal Kernel ledger entries remain immutable historical facts and
cannot re-enter current validation or execution. Any ambiguous recoverable
payload rolls back the whole migration and refuses startup; runtime has no v6
fallback reader.

The Phase 4 gated evaluation closed on 2026-07-21 without adoption. The replaceable drain/apply loop was materially smaller than the required MetaClaw inbox/application/outbox recovery layer, while Functional API integration would add a second SQLite cursor and replay glue. It could not produce the required 30% net removal. `DurableKernelWorkflow` is therefore the sole production workflow implementation and no LangGraph dependency or compatibility path is retained.

## Ownership And Dependencies

- Kernel owns pure decisions and may depend only on pure domain/routing/work-graph facts.
- Workflow is a deep Application module owning durable sequencing, recovery and handler orchestration, not policy.
- Runtime owns idempotent effects, attempt execution and normalized observations.
- Storage implements transactional repositories; tables do not define policy.
- Session, Gateway and commands only submit events, call startup recovery and project results.

## Consequences

Crashes no longer create an uninspectable ledger/apply gap, and repeated submission resumes the same application instead of duplicating authorization. Retry, fallback, replan, availability, permission, partition waiting and sandbox recovery are auditable Kernel actions. The hard schema cuts require coordinated migration and replacement of every manual issue/apply path. Phase 5 remains serial; multi-Task and concurrent-frontier scheduling remain Phase 6.
