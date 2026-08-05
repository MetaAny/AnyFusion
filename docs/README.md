# AnyFusion Documentation

This directory contains both current technical documentation and historical planning material. Start with the current docs before opening dated plans.

## Current Docs

- [Repository Agent Guide](../AGENTS.md): fastest onboarding path, current
  contract versions, module ownership, runtime invariants, entry points, and
  validation rules.
- [Technical Overview](current/technical-overview.md): the previous long-form README, preserved as the current deep architecture and runtime reference.
- [中文技术总览](current/technical-overview.zh-CN.md): the previous long-form Chinese README, preserved as the Chinese deep architecture and runtime reference.
- [Phase 5 Runtime Security And AgentClass Operations](current/phase-5-runtime-security.md): short-lived attempt containers, control/egress networks, persistent workspace retention, image pinning, and runtime elevation operations.
- [Repository README](../README.md): public project overview, install path, repository structure, and high-level architecture.
- [CONTEXT](../CONTEXT.md): current PlanningAgent, ControlKernel, decision-ledger, and work-unit vocabulary.

## Releases

- [AnyFusion v1.2.0 Preview](releases/v1.2.0-preview.0.md): public preview highlights, architecture summary, deployment status, and known limitations.
- [Changelog](../CHANGELOG.md): public release history.

## Architecture Decisions

Use the [ADR authority index](adr/README.md) before opening individual decisions. It records the required reading order, current topic owner and archive policy. ADRs under [archive/adr/](archive/adr/) are historical and must not guide new implementation.

Key recent ADRs:

- [ADR-0011: Single Active Task Admission Gate](adr/0011-single-active-task-admission-gate.md)
- [ADR-0015: Planner-Owned Semantics And Tool-Mediated Context](adr/0015-planner-owned-semantics-and-tool-mediated-context.md)
- [ADR-0017: Kernel Executor Status Projection](adr/0017-kernel-executor-status-projection.md)
- [ADR-0018: Supported Routing Contracts And Unified Executor Definitions](adr/0018-supported-routing-contracts-and-unified-executor-definitions.md)
- [ADR-0020: Core Module Ownership And Dependency Direction](adr/0020-core-module-ownership-and-dependency-direction.md): normative module and dependency guide for the active convergence roadmap.
- [ADR-0022: Unified Kernel Control Plane And Decision Ledger](adr/0022-unified-kernel-control-plane-and-decision-ledger.md): current event, snapshot, decision, ledger, Subtask and synchronous-loop contract delivered by Phase 3.
- [ADR-0023: Durable Kernel Workflow, Recovery And Availability](adr/0023-durable-kernel-workflow-recovery-and-availability.md): Phase 4 durable inbox/application/outbox, recovery, structured failure, retry/fallback, availability, continuation and graph revision authority.
- [ADR-0024: Resource Partition, Sandbox And Runtime Elevation](adr/0024-resource-partition-sandbox-and-runtime-elevation.md): Phase 5 resource identities, Docker attempts, persistent workspaces, leases and structured permission elevation.
- [ADR-0025: Single-Task Concurrency And Git Publication](adr/0025-single-task-concurrency-and-git-publication.md): Phase 6 runnable frontier, batch dispatch, asynchronous attempts, Git-backed workspaces and publication.
- [ADR-0026: Phase 6 Single-Task Reliability Closure](adr/0026-phase-6-single-task-reliability-closure.md): final Phase 6 scope, reliable Task termination/recovery closure and deferral of multi-Task scheduling.

[ADR-0021: Work Graph v4 And Subtask Execution Contract](adr/0021-work-graph-v4-subtask-execution-contract.md)
is the foundational dependency/handoff/completion contract. ADR-0025/0026
evolved the active graph to v5 for concurrent dispatch and publication without
replacing those semantics.

## Completed Roadmap

- [AnyFusion Pi Planner and native TUI migration](plans/2026-07-31-pi-planner-tui-migration.md): completed unified interactive/RPC Planner runtime, fixed AnyFusion-managed models, read-only Task dashboard, native command completion, and strict Planner/Kernel/Executor process separation.
- [Planner、Kernel 与并发调度收敛路线图](plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md): completed convergence from capability-aware work graphs and executor scope through the Kernel control plane, resource partitions, single-Task DAG concurrency, Git publication and reliable asynchronous cancellation/recovery.
- [Phase 6 final reliability closure](archive/plans/2026-07-28-phase-6-single-task-reliability-closure.md): SQLite v27 cancellation/replan facts, durable Task/Subtask cleanup, explicit partial acceptance and the strict completion gate.
- [Executor error recovery refresh](archive/plans/2026-07-30-executor-error-recovery-refresh.md): completed Kernel v5 / SQLite v28 event-driven `error -> healthy` recovery, same-thread Planner revision, and deferred availability proposal lifecycle.

## Active Delivery

- [Node 22 single runtime image migration](plans/2026-08-05-node-22-single-runtime-image-migration.md): unifies MetaClaw and AnyFusion-Pi on one Node 22.19+ image and executable while preserving separate processes and dependency trees.
- [Active permission review](plans/2026-08-04-active-permission-review.md): projects current-session durable permission requests to a transient Pi native Selector while preserving Kernel authorization and non-interactive natural-language resolution.
- [Command surface and task selection cleanup](plans/2026-08-04-command-surface-and-task-selection-cleanup.md): first-batch removal of non-functional command surfaces, richer Executor/Profile facts, and title-first Task completion in AnyFusion-Pi.
- [Pi Executor status and result projection fix](plans/2026-08-04-pi-executor-status-and-result-projection.md): adds a native animated Executor status block and passively persists each integrated Subtask publication into the Pi conversation without triggering a Planner turn or moving Kernel/Execution authority.

## Future Roadmap

- [Multi-top-level-Task scheduling](plans/future-multi-task-scheduling-roadmap.md): deferred independent work for admission, priority, fairness and starvation protection. It is not an unfinished Phase 6 stage; ADR-0011 remains active.

## Historical Plans

Files in [plans/](plans/) contain active plans explicitly linked above. Superseded and completed plans are moved to [archive/plans/](archive/plans/); treat archived plans as historical context unless they are referenced by the current README, `CONTEXT.md`, or an ADR.

The completed [Phase 1 work-graph semantics convergence plan](archive/plans/2026-07-16-phase-1-work-graph-semantics-convergence.md) records the v3 contract, migration, runtime cutover, and validation evidence.

The completed [Phase 2 overall action plan](archive/plans/2026-07-17-phase-2-executor-scope-and-dependency-handoff.md) and [detailed implementation plan](archive/plans/2026-07-17-phase-2-executor-scope-and-handoff-detailed-implementation-plan.md) record the Work Graph v4, execution-scope, evidence, completion, handoff, attempt, migration, and validation contracts.

The completed [Phase 2 attempt-terminal and Work Graph regression fix plan](archive/plans/2026-07-20-phase-2-attempt-terminal-and-work-graph-regression-fix-plan.md) records the pre-Phase-3 hardening of blocked/stale terminal ownership, attempt-safe release, restored Phase 1 topology rules, and behavior-test coverage.

The completed [Phase 3 overall action plan](archive/plans/2026-07-20-phase-3-kernel-control-plane-convergence.md) and [detailed implementation plan](archive/plans/2026-07-20-phase-3-kernel-control-plane-detailed-implementation-plan.md) record the unified ControlKernel, decision ledger, synchronous control loop, capacity handling, outcome landing, response-only correction, and validation evidence.

The completed [Phase 5 implementation plan](archive/plans/2026-07-22-phase-5-resource-partition-sandbox-elevation-detailed-implementation-plan.md) records resource identities, persistent workspaces, leases, Docker attempt sandboxes, runtime elevation, Kernel v3 recovery and validation evidence.

The completed [Phase 6 concurrency and Git integration plan](archive/plans/2026-07-27-phase-6a-single-task-concurrency-and-git-integration.md) and [Phase 6 reliability closure plan](archive/plans/2026-07-28-phase-6-single-task-reliability-closure.md) record the single-Task asynchronous frontier, attempt isolation, Git publication, durable cancellation, generation replan and strict completion gate.

The completed [Executor probe diagnostics and Docker shell fix plan](archive/plans/2026-07-29-executor-probe-diagnostics-and-docker-shell-fix.md) records Docker socket access, durable probe diagnostics and Planner-visible troubleshooting evidence.

The completed [Planner native Codex session integration plan](archive/plans/2026-07-29-planner-native-codex-session-integration.md) records session-to-thread binding, native resume, Planner-only prompts and the two-turn memory smoke.

The failed [AnyFusion Codex native TUI migration](archive/plans/2026-07-30-codex-native-tui-migration.md) records the abandoned downstream Codex TUI route. Its Planner/Kernel/Executor boundaries remain historical design input, but its Rust build and release cost made the implementation route unacceptable; the Pi migration plan is now authoritative for replacement work.

The [2026-06-30 temporary issue handoff](archive/ISSUES-2026-06-30-temp-handover.md)
is archived because several entries reference modules removed by later cleanup.
It is historical review context, not an active issue tracker or architecture map.

## Operational Notes

- [Docker + SSH runtime](current/technical-overview.md#running-in-docker-windows--containerized): the checked-in runtime builds MetaClaw and the sibling AnyFusion-Pi Planner into one Node 22.19+ image while keeping their processes, dependency trees, and provider/config boundaries independent.
- The failed AnyFusion-Codex Planner wiring has been removed from active source, Docker templates, and smoke scripts. The archived migration plan and Git history remain the rollback/audit record; the original Ink source, tests, and dependencies remain a standby module and must not be deleted.
- [Tech Debt](tech-debt/): [Pi Planner behavior parity and PlanningAgentPlan v7](tech-debt/planner-pi-migration-parity-debt.md) closed on 2026-08-04 after Linux Docker acceptance and final user verification. The post-Phase-6 first-release cleanup handoff is tracked in [redundancy and compatibility cleanup](tech-debt/post-phase6-first-release-redundancy-cleanup.md). Active command/TUI work is tracked in the [UX backlog](tech-debt/task-command-and-tui-ux-backlog.md), with visible command placeholders listed in [pending command implementations](tech-debt/pending-command-implementations.md). The closed [natural-language inference inventory](archive/tech-debt/nl-keyword-semantic-inference-debt.md) is retained as historical input to the completed P0 cleanup. The closed [Kernel decision authority record](archive/tech-debt/kernel-decision-authority-scattered-in-runtime-debt.md) documents how Phase 3–5 converged every strategic decision onto `ControlKernel`. The closed [LangGraph durable workflow evaluation](archive/tech-debt/langgraph-durable-workflow-adoption-candidates.md) records why Phase 4 retained the smaller self-owned workflow. Closed capability and workspace-partition records also remain under [archive/tech-debt/](archive/tech-debt/).

## For Agents

Read `AGENTS.md`, then `CONTEXT.md`, then this map. Open
`current/technical-overview.md` for deep runtime/deployment context and select
only the applicable accepted ADRs. Avoid loading every dated plan by default.
