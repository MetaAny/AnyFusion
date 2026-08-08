# Architecture Decision Records

This directory contains only ADRs that still contribute to the current MetaClaw architecture. Superseded proposals and fully absorbed decisions live under [the ADR archive](../archive/adr/README.md) and are historical context, not implementation authority.

## Required reading order

For architecture or roadmap work, read the smallest applicable set in this order:

1. [ADR-0020: Core Module Ownership And Dependency Direction](0020-core-module-ownership-and-dependency-direction.md) — normative module ownership, public seams and dependency direction.
2. Select only the topic ADRs needed from the table below.

Do not bulk-load archived ADRs. Open one only when investigating why an older design existed or when a current ADR explicitly cites it as historical context.

ADR-0021 is the foundational authority for Work Graph dependency, handoff and
completion semantics. ADR-0025/0026 evolved the active graph contract to v5 for
concurrent dispatch, Git publication, cancellation and generation recovery.
ADR-0023 owns the durable-workflow evolution. The earlier v3 contract and
migration record are archived as ADR-0019.

ADR-0022 is the origin authority for the unified Kernel event/snapshot/decision Interface, decision ledger, `awaiting_decision`, synchronous control loop, capacity candidate switching, and response-only correction. Its contract has since been amended through ADR-0023/0024/0025/0026 and the current Kernel wire version is v5.

ADR-0023 is the current authority for the durable KernelWorkflow, structured failure and availability rules, idempotent application recovery, Work Graph revisions, continuation, outbox, manual recovery, and the 2026-07-30 deferred-availability/executor-recovery amendment.

ADR-0024 is the current authority for Phase 5 resource partitions, persistent workspaces, per-attempt Docker sandboxes, durable resource leases and runtime capability elevation.

ADR-0025 is the current authority for Phase 6A single-Task runnable frontier, Kernel dispatch batches, asynchronous attempt supervision, Git-backed workspaces, deterministic publication and merge-conflict recovery.

ADR-0026 fixes Phase 6's final scope to reliable asynchronous concurrency inside one top-level Task. It preserves ADR-0011; multi-Task scheduling is a future independent roadmap rather than Phase 6 work.

## Current authority matrix

| Topic | Current authority | What it decides |
| --- | --- | --- |
| Single-Task concurrency and Git publication | [ADR-0025](0025-single-task-concurrency-and-git-publication.md) | Runnable frontier, dispatch batches, attempt supervision, Git workspace ownership, publication gate and conflict repair |
| Phase 6 single-Task reliability closure | [ADR-0026](0026-phase-6-single-task-reliability-closure.md) | Task termination, multi-attempt recovery/completion closure, and deferral of multi-Task scheduling |
| Resource partitions and sandboxed attempts | [ADR-0024](0024-resource-partition-sandbox-and-runtime-elevation.md) | Partition identity/conflicts, persistent workspace, Docker attempt boundary, leases, elevation and recovery |
| Core modules and dependencies | [ADR-0020](0020-core-module-ownership-and-dependency-direction.md) | Planner/Kernel/Runtime control loop, module owners, Application Shell, persistence adapters and phase design gates |
| Durable Kernel workflow and recovery | [ADR-0023](0023-durable-kernel-workflow-recovery-and-availability.md) | Durable inbox/application/outbox, structured failure, retry/fallback, deferred availability, Executor recovery, continuation and revisions |
| Unified Kernel control plane | [ADR-0022](0022-unified-kernel-control-plane-and-decision-ledger.md) | Versioned event/snapshot/decision contract, ledger-first loop, attempt landing, capacity recovery and response-only correction |
| Work Graph and Subtask execution foundation | [ADR-0021](0021-work-graph-v4-subtask-execution-contract.md) | dependency/context/handoff/completion/evidence semantics retained by the active v5 graph; concurrent dispatch and publication amendments live in ADR-0025/0026 |
| Executor registry and static routing contracts | [ADR-0018](0018-supported-routing-contracts-and-unified-executor-definitions.md) | `executors.yaml`, Routing Capability, profiles, bindings, digest-bound verification and controlled projections |
| Dynamic AgentClass status | [ADR-0017](0017-kernel-executor-status-projection.md) | bounded health/outcome/recovery projection, static/dynamic fact split, and `error` versus `disabled` semantics |
| Planner semantics and context | [ADR-0015](0015-planner-owned-semantics-and-tool-mediated-context.md) | semantic ownership, isolated planner runner, bounded/tool-mediated read-only context and fail-closed behavior |
| Single-active top-level Task | [ADR-0011](0011-single-active-task-admission-gate.md) | current product constraint; ADR-0020 governs final Kernel ownership of admission policy |

When two current ADRs appear to overlap, the more specific topic ADR defines its data contract while ADR-0020 defines module ownership and dependency direction. A newer ADR must explicitly amend or supersede an older one; implementation plans cannot silently override ADRs.

## Status rules

- `Accepted`: current decision authority, including explicit amendments listed in the file.
- `Superseded` or `Historical`: stored under `docs/archive/adr/` and not valid for new implementation decisions.
- Avoid long-lived `partially superseded` ADRs. Absorb their remaining valid rules into a current ADR, then archive the old record.

New ADRs must state status, date, scope, affected current ADRs and whether they amend or supersede them. Material roadmap phases must also satisfy ADR-0020's design gate.
