# ADR-0025: Single-Task Concurrency And Git Publication

- **Status**: Accepted
- **Date**: 2026-07-27
- **Scope**: Phase 6A runnable frontier, Kernel dispatch batches, asynchronous attempts, Git-backed workspaces, deterministic publication and merge-conflict recovery
- **Amends**: ADR-0017, ADR-0021, ADR-0023, ADR-0024
- **Preserves**: ADR-0011
- **Governed by**: ADR-0020

> Scope alignment (2026-07-28): ADR-0026 makes this single-Task path the final Phase 6 scope. Multi-Task admission, priority, fairness and starvation protection are deferred to a future independent roadmap; they do not amend this dispatch/publication seam.

## Context

Phase 5 established durable workspaces, per-attempt sandboxes, partition leases and a single durable Kernel workflow, but production still dispatches one Subtask at a time. Attempt success also publishes completion facts immediately, and dependency workspace composition cherry-picks commits. Enabling concurrency on that path would couple outcome timing to result order, expose downstream work before integration, and make same-path writes unsafe.

The product must first prove concurrency inside the single active top-level Task. Multi-Task fairness is a separate policy layer and must not force a second scheduler or rewrite the attempt/publication mechanisms.

## Decision

### Pure scheduling authority

Work Graph v6 remains the only dependency structure and does not gain execution layers. Its `deliveryKind` contract changes completion validation, not scheduling authority. A pure Work Graph function derives a runnable frontier from the current revision and immutable lifecycle facts.

ControlKernel contract v4 receives a scheduling snapshot containing the frontier, pending and active dispatch items, bounded AgentClass availability, normalized resource conflicts, `maxConcurrentAttempts` and free slots. Its `dispatch_batch` Decision authorizes a deterministic ordered set of items. Each item fixes its attempt identity, AgentClass, resource grant, attempt kind and order.

Only the active Task is a scheduling candidate. ADR-0011 remains in force. Multi-Task admission, priority, fairness and starvation protection are deliberately deferred to a future independent roadmap without changing the v4 batch/apply/supervisor seam.

### Durable asynchronous application

`DurableKernelWorkflow` remains the sole serial authorization/application workflow. Applying `dispatch_batch` transactionally inserts durable child items and returns without awaiting execution. An Execution-owned supervisor claims child items by attempt ID, launches them independently and submits normalized events back through the same workflow.

A partial capacity, partition or launch race affects only that child. A partial unique index guarantees that one Subtask cannot have more than one pending or active attempt. Startup reconciles child rows, sandbox records and Docker labels before new work is accepted.

Executor adapters are attempt-reentrant. Active process/container state is keyed by attempt ID; cancellation can target one attempt, while Task cancellation enumerates that Task's attempts.

### Git-backed durable workspaces

Every new file task uses a MetaClaw-managed Git repository. Existing Git sources are cloned into a generation-internal bare repository. Non-Git sources are imported as an immutable initial commit into the same shape. Phase 5 checkpoint/CAS remains supplementary recovery evidence, not an alternative merge authority.

A persistent worktree belongs to `(taskId, generationId, subtaskId)`. Attempts, WorkUnit claims and containers are disposable and one-to-one; retry, fallback, continuation and merge repair preserve the worktree, Git history and checkpoint.

Downstream worktrees merge only their direct dependencies' published branches using complete Git ancestry. Cherry-pick composition is prohibited. The generation integration branch is used only for publication, conflict audit and final output, and is never an implicit input baseline for unrelated downstream nodes.

### Publication is the completion boundary

Attempt success writes an immutable receipt and candidate commit, then moves the Subtask to `awaiting_integration`. It does not publish result, artifacts, handoffs or `done`.

An Execution-owned publication worker integrates candidates in deterministic order: graph topological layer, first Kernel batch authorization order and Subtask ID. Only a successful integration transaction atomically publishes the original completion payload, final workspace state and `done`. Downstream frontier derivation therefore cannot observe unintegrated work.

The Runtime creates only MetaClaw-managed integration commits. It never mutates, merges or pushes a user branch.

### File policy and conflict repair

Text files, identified by `.gitattributes` first and bounded content detection second, may use Git three-way merge. Binary files are tracked but never automatically semantically merged. Once an actual binary write set exists, publication must hold an exclusive lease for each generation/repository-relative path. Tracked SQLite files follow the binary policy.

On conflict, Runtime records immutable base/ours/theirs and conflict paths, stops publication and emits `merge_conflict_observed`. It never chooses a version.

Conflict handling stays on the original Subtask and original AgentClass. No Planner conflict-resolution Subtask is created. Kernel may authorize up to three `merge_repair` attempts after the first conflict. Each uses a new attempt and container but keeps the worktree. Text repair receives conflict material; binary repair receives read-only versions and must regenerate one target. Executor may edit only conflict paths and must return `metaclaw:merge-repair:v1`; Runtime alone performs Git operations and validates the repair.

After three failed repairs, Kernel may issue one `request_merge_replan` for that conflict chain. This budget is independent from normal retry, fallback, AgentClass health and ordinary automatic replan. A failed conflict replan parks the Subtask.

### Configuration

The global `maxConcurrentAttempts` default is four and must be a positive integer. Invalid configuration fails startup and is never silently clamped. Phase 6A has no serial/concurrent feature flag and no alternate scheduler.

## Deferred Work

Database-aware semantic snapshots, active databases and WAL/journal/log/cache/data directories, and Git LFS are deferred. LFS may later change storage transport but cannot make binary files semantically mergeable. Multi-Task scheduling, priority, fairness and starvation protection are likewise deferred; ADR-0026 confirms they are outside final Phase 6 scope.

## Consequences

Concurrency authorization remains pure and auditable while attempt execution becomes asynchronous. Completion facts cannot race ahead of Git publication, result order is independent from executor timing, and conflicts become bounded recovery chains rather than silent overwrites or new semantic work items.

The hard cut requires coordinated Kernel v4, SQLite v26, Runtime, Executor, workspace and projection changes. Legacy v3 applied decisions remain audit records; pending/processing legacy applications fail closed during startup reconciliation rather than running a second contract.
