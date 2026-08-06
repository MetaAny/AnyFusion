# ADR-0024: Resource Partition, Sandboxed Attempts And Runtime Elevation

- **Status**: Accepted
- **Date**: 2026-07-22
- **Scope**: Phase 5 resource identity, persistent workspace, resource leases, per-attempt Docker sandbox, permission audit budgets and recovery
- **Amends**: ADR-0021, ADR-0023
- **Governed by**: ADR-0020

## Context

Phase 4 made authorization and recovery durable but still runs Executor adapters as host child processes, gives them the process working directory, and validates artifacts mainly after execution. The historical `worktree_leases` table has no production consumer and does not express attempt ownership, access mode, partition identity, wait relationships or crash-safe sandbox lifecycle. Enabling concurrency on this base would make conflicts and external effects nondeterministic.

Requiring Planner to predict concrete paths, network targets, secrets and external objects would also move runtime facts into the semantic planning seam. Most such needs appear only while an Executor is working. Phase 5 therefore needs a final resource model and a runtime approval boundary without creating a second strategic interpreter.

## Decision

### Resource authority

MetaClaw introduces an independent pure Resource Model. `PartitionIdentity` is a discriminated union for repository, worktree, mount-relative path, logical resource and external object. It owns canonical keys, read/write overlap and conflict rules plus grant/lease invariants. It owns neither scheduling nor filesystem operations.

Planner continues to propose delivery capabilities through Work Graph v5 and does not enumerate concrete resource claims. Runtime derives a bounded default claim from the Kernel-visible AgentClass permission profile, Task-bound resources and persistent workspace identity. An Executor that needs more submits a structured capability request. This explicitly replaces the roadmap shorthand that said Planner itself would enumerate resource claims.

ControlKernel remains the only strategic authority. Kernel v3 may grant a bounded capability, deny it and let the Executor continue with the reason, or deny it and escalate the reason to Planner. Unknown or fuzzy requests fail closed. Kernel reads no repository, clock, Docker state, raw stderr or host path; Runtime supplies normalized versioned facts.

### Worktree-first, workspace-durable execution

The default execution attempt is a short-lived Codex/Pi child process launched
inside the unified Runtime with `cwd` set to the persistent Task-generation +
Subtask Git worktree. The existing Docker attempt backend remains available as
an explicit compatibility mode. Every Task generation + Subtask owns a
persistent workspace record and immutable checkpoints. Retry and fallback may
resume only the authorized workspace state. A paused process/container is
retained only during bounded automatic Kernel/Planner review; waiting for a user
or replan checkpoints the workspace, terminates the runtime instance and
releases active leases.

The original repository, Task evidence and dependency inputs are read-only. The private workspace and `/tmp` are writable. Git executions use a MetaClaw-managed repository/worktree and managed Task branch; Runtime owns `.git` and controlled commits. No Phase 5 action mutates, merges or pushes the user's branch. Non-Git workspaces use filesystem checkpoints and content-addressed objects. SQLite stores metadata, not large contents.

Docker compatibility attempt containers are non-root with read-only root
filesystem, dropped Linux capabilities, no-new-privileges, bounded
CPU/memory/PIDs/logs, no host namespaces/devices/Docker socket, and no direct
ungoverned egress. Worktree attempts are trusted Runtime child processes and do
not receive a Docker Engine endpoint. The trusted Runtime uses the existing
Docker Engine adapter only when the compatibility backend is selected.

Provider credentials also remain in the trusted Runtime. Each attempt receives only a random attempt-scoped token and a fixed internal model-gateway URL; the gateway binds the token to the configured provider endpoint and process lifetime. In worktree mode canonical Codex uses `danger-full-access` inside the already-trusted Runtime process, so there is no second CLI sandbox beyond the managed worktree boundary. Docker compatibility attempts keep Codex's nested `workspace-write` sandbox and non-interactive fail-closed approval policy. Because that nested Linux sandbox requires user-namespace syscalls, the Docker adapter may add `seccomp=unconfined` only for the pinned canonical Codex attempt image; non-root UID, read-only rootfs, dropped capabilities, no-new-privileges, internal networking and all mount boundaries remain mandatory. No custom image inherits this exception.

### Default profiles and permission audit

Default authority is an AgentClass fact, not a Planner field. Canonical definitions own immutable execution image and permission profile bindings. Custom AgentClasses must provide a resolvable immutable image and controlled profile; missing or drifted images are configuration failures and never fall back to host execution. Permission details are excluded from the Planner-safe catalog.

Runtime materializes a versioned explicit rule set from that profile and the current Task bindings. `permission-profile-v1` permits additional-read requests only for exact Task-registered partitions, and permits normalized public HTTP(S) target requests only for `public-web-research`. The other profiles receive no network allow rule. No profile rule approves secrets, external mutation or repository promotion.

The capability request protocol is deliberately small: capability, resource, operation, reason and suggested once/attempt scope. Runtime canonicalizes and binds identity. Read/network grants are attempt-bound with policy TTL/use/byte budgets; sensitive requests remain one-shot. A granted request returns an opaque grant ID but does not itself widen sandbox authority. `use_capability` records and atomically consumes attempt identity, TTL, call and byte budgets for the supplied operation payload. Stable fingerprints make request, Decision, grant and budget consumption idempotent.

The initial product guarantee ends at the sandbox profile and this authorization/audit budget. It does not claim operation-specific broker mediation or fine-grained Runtime enforcement for every file, network or external mutation. In particular, consuming a grant is not proof that an arbitrary native tool operation was mediated. Platform escape, Docker socket/device/host namespace access, proxy bypass, system credential probing, cross-Task access and persistent security weakening remain non-overridable denials at the sandbox/profile boundary. A future provider adapter may add a separately specified mediated effect, but this ADR does not treat such an adapter as generally implemented.

### User authorization

PlanningAgentPlan v7 retains only an authorization-resolution action for a pending exact request; Work Graph v6 does not add resource authority. Planner may interpret an ordinary-language approve/deny response but cannot change the request target or scope. Deterministic commands and connector actions produce the same `permission_resolution_received` event. User input records an authorization fact; ControlKernel still issues the final bounded grant.

For the local interactive Pi surface, the exact request is projected only after its escalation Decision application is durable and remains valid for 24 hours. Pi uses a transient native button Selector and submits only request ID plus approve/deny with `source: button`; it never stores the request or resolution in conversation context. The shared `/permission` command and interactive Planner authorization proposal are unavailable. An applied resolution Decision is authoritative even when recovery intentionally leaves the request row escalated. Same-button replay is idempotent; opposite, cross-session, resolved, stale, and expired submissions conflict. Feishu, RPC, and Session Planner retain the exact natural-language path described above.

### Persistence and recovery

SQLite v25 separates resource leases/waits, workspace/checkpoints/content references, permission requests/grants/user authorizations and attempt sandbox lifecycle. The old unused worktree lease shape becomes legacy audit. Resource and WorkUnit leases are attempt-bound, heartbeat-driven and idempotent. Startup reconciles database facts with Docker labels before accepting input and converts missing/orphaned/paused containers into normalized facts for the durable Kernel workflow.

Phase 5 remains serial. Partition conflicts and wait relationships are exercised now so Phase 6 may derive concurrent dispatch without changing identity, authorization or recovery semantics.

## Ownership And Dependencies

- Resource Model owns pure identity, overlap, conflict and lease/grant invariants.
- Routing/AgentClass catalog owns controlled default permission profiles and image bindings.
- ControlKernel owns grant/deny/escalate, partition wait and recovery policy through the single `decide` seam.
- Execution Runtime owns workspace, lease application, selected backend lifecycle, permission request/audit-budget handling, checkpoint and normalized observations.
- Storage, Docker, Git/CAS and external providers implement ports owned by Resource/Execution.
- Session, Commands, TUI and Gateway submit events and project status; they never write grants or leases directly.

Kernel may not depend on Docker, Storage, Session, Planning implementation or raw paths. Runtime may not infer permission from stderr or widen a grant. Executor adapters may not run outside the selected Runtime backend or directly mutate external systems.

## Consequences

Executor work remains reproducible and recoverable across short-lived worktree
processes or compatibility containers while large workspace contents stay
outside SQLite. Permission interruptions and budget consumption are auditable
Kernel facts rather than hidden Adapter prompts. Fine-grained mediation remains
outside the product claim until an operation-specific adapter is implemented and
tested. Planner remains focused on semantic decomposition and is involved only
when an otherwise valid request lacks explicit authority. The default demo
requires the unified Linux Runtime (Docker Desktop on macOS/Windows); sibling
Executor containers are not required. Custom Executor registration remains a
Docker compatibility concern and is unchanged by this minimal worktree path.
