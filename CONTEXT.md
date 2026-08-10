# MetaClaw Planning Agent And Work Unit Context

The vocabulary for how MetaClaw turns user intent into kernel-authorized task, subtask, and work-unit runtime actions. Exists because earlier routing layers conflated intent understanding, policy authorization, task state changes, subtask planning, executor instance claims, and fallback behavior.

## Current Implementation Notes

Phase 6 is complete at the single-Task boundary. The active path is `event -> durable inbox -> KernelWorkflow -> snapshot -> ControlKernel.decide -> immutable decision ledger + application -> durable dispatch items -> attempt supervisor -> normalized observation inbox`. `KernelWorkflow` serializes authorization and application, while up to four child attempts may run asynchronously inside the one admitted top-level Task. Startup resolves one explicit Project repository, and every Subtask owns one branch and one physical Git worktree from that repository across retry, fallback, takeover, user review and stale-main resynchronization. Runtime runs verified registry-bound CLI Executors as child processes in those worktrees; Docker is only a packaging option for the single Ubuntu Runtime. The isolated AnyFusion-Pi `PlanningAgent` owns user conversation, read-only queries and natural-language planning semantics; `ControlKernel` owns scheduling, cancellation and recovery policy, and Execution owns Project validation, WorkUnit claims, leases, process runtimes and Git side effects. ADR-0011 remains an intentional product boundary; multi-top-level-Task scheduling belongs to a future independent roadmap.

`src/planning/` owns the PlanningAgent interface (`AnyFusionPlanningAgent`), controlled-lifecycle AnyFusion-Pi JSONL RPC runner, the structured proposal contract, and catalog-aware validation. One live MetaClaw session maps to one persisted Pi session file. Non-interactive surfaces use `--mode rpc` over stdin/stdout JSONL and serialize writers per session; MetaClaw does not replay SQLite interaction history into prompts. Stable instructions and one fixed `metaclaw-planner/SKILL.md` live in the AnyFusion-Pi fork, while dynamic Task, runtime, authorization and routing facts come only from seven allowlisted read-only MetaClaw MCP tools. Pi also exposes only `read`, `grep`, `find` and `ls` against `/workspace`; shell, edit and write remain disabled. MetaClaw remains the only v7 validator and the only owner of Task, Kernel, Executor and storage mutation. Pi submits `PlanningAgentPlan v7` only through its restricted native `submit_planning_proposal` tool. Runtime injects session, turn, user input and deterministic submission identity; the model supplies only `plan`. A rejection remains ordinary structured tool feedback in the same ReAct turn, with no proposal-specific retry count, repair prompt or outer coordination loop. `src/work-graph/` owns the shared v6 graph types and pure structural rules consumed by Planning, Kernel, and Execution. Transport uncertainty is distinct from validation rejection and is resolved only by idempotently replaying the identical submission; there is no assistant-text envelope parser, earlier-schema production parser, legacy intent route, semantic default, keyword fallback or Codex Planner fallback.

The default local surface is the pinned sibling `AnyFusion-Pi` fork. On the supported Linux server path, MetaClaw and Planner use the same host Node 22.19+ executable while retaining separate dependency trees, isolated homes and separate processes. The repository Runtime image is the Ubuntu deployment and Windows-hosted development surface. `src/tui-bridge/` exposes AnyFusion Planner Host Protocol v2 over a mode-`0600` Unix JSONL socket for both native TUI and RPC proposal tools. Both modes use one Planner bootstrap, fixed Skill, exact tool set and proposal path. MetaClaw injects the shared Node command and compiled `planner-mcp.js` arguments; the Planner artifact carries no private Node runtime and never substitutes an uncontrolled executable. A missing fixed query tool fails before the first turn. A mid-turn MCP transport loss locks proposal submission and aborts that agent loop; the TUI remains alive and reconnects before the next turn. The TUI receives only Session projections, requests slash-command completion state from `MetaclawSession`, and may transport an explicit user-authored slash command; completion, validation, dynamic Task/Executor candidates and execution still come only from the existing `CommandCatalog`. Host Protocol v2 also advertises backward-compatible `executor_result` and `permission_request` capabilities. Executor results are passive persisted Planner context as described below. Permission requests are instead transient UI-only facts: the Session projects only current-session, applied, unresolved escalations inside the 24-hour validity window; Pi reviews them through a native Selector and submits only request ID plus approve/deny. Interactive Planner authorization proposals and shared `/permission` commands are rejected, while RPC, Feishu and Session Planner exact natural-language authorization remain supported. Permission arrival and resolution never enter the Pi branch or create a semantic turn. `MetaclawSession` reruns the v7 schema and semantic validation before emitting `plan_proposed` into `DurableKernelWorkflow`. The first accepted proposal locks the turn; rejected revisions remain open, identical submissions replay their persisted result, and a different post-acceptance submission conflicts. The bridge has no direct database, Kernel, scheduler or Executor dependency. Planner cannot synthesize privileged commands, edit, execute shell, mutate Task state, authorize work or publish Git changes. The Executor registration window is also an Application-Shell adapter: discovery and form input are presented in Pi, but registration, verification, YAML replacement, enablement and snapshot refresh occur only through the shared MetaClaw command/application service. The original Ink implementation under `src/tui/` remains intact as an explicitly unmaintained standby module selected with `METACLAW_STANDBY_TUI=1`.

`src/kernel/` owns the pure `ControlKernel` and the deep control-loop interface. Kernel contract v5 includes the executor-recovery and deferred-availability lifecycle in addition to the Phase 6 dispatch, cancellation, publication and permission contracts. `ControlKernel` reads no time, IDs, repositories, adapters or raw logs. Storage and Runtime implement the ledger and apply seams from outside the Kernel module.

`src/execution/subtask-attempt-runner.ts` executes one Kernel-authorized deterministic attempt. The Executor must commit its complete result, merge the current local Project `main`, resolve conflicts, and leave its assigned branch clean. A successful primary/correction attempt commits an immutable receipt and exact candidate commit, then moves the Subtask to `awaiting_integration`; it does not publish result, artifacts, handoffs or `done`. Runtime validates branch identity, clean state and `main` ancestry, creates an `awaiting_approval` publication plus exact `repository_promotion` request, and waits for the user. Approval merges the complete branch into Project `main`, atomically publishes completion facts, and removes the Subtask worktree and branch. Denial blocks the Task/Subtask and preserves them. If `main` changed after the request, Runtime parks the stale publication, preserves the worktree, and returns the Subtask for Executor resynchronization and a new approval. Every non-success commits a terminal receipt and returns control to Kernel policy. A first completion-contract failure may receive one response-only correction on the same AgentClass.

Executor path invariant: Runtime-generated `workingDirectory` and `targetPaths` identify the Subtask-owned Project worktree, while each Executor also needs a private runtime home for provider configuration, tools, and sessions. These are separate path contracts. Planner never chooses host paths or branch names. Every registration binding declares an absolute binary path and source runtime home; the selected driver materializes an attempt-private home before process launch and never relies on implicit `HOME` discovery. Pi sets `HOME`, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` and pre-creates the session directory. Codex sets an isolated `CODEX_HOME` containing the rewritten provider config. Hermes materializes its private config, and generic `cli-session` receives an empty isolated home plus only declared environment-file and inherited-variable sources. The child process `cwd` remains the Runtime-assigned worktree. Missing worktree, binary, source home, or materialized home fails with a path-specific diagnostic.

The unreleased product uses fresh-only SQLite schema version 34. Fresh databases start at v34; every v33 or older pre-release database is rejected with its exact path and there is no migration, automatic deletion, or dual-read path. Schema v34 retains the v33 Project, publication, Executor Registry and purge baseline while replacing Docker-attempt image/container facts with one worktree process runtime handle and child PID. It retains persisted Planner proposal turns/submissions and their accepted-turn lock, the Kernel v5 decision/workflow ledger, resource/workspace/permission/sandbox facts, durable dispatch/publication audit, cancellation cleanup, lease revocation, generation replan requests, deferred availability proposals, bounded Executor recovery checks and `full | partial_accepted` revision completion. `kernel_events` and `task_events` keep their complete durable history until an explicitly authorized terminal Task purge. Executor Skill progress remains bounded attempt-lifetime verifier evidence, while only `skill_completed`, `skill_failed`, `skill_skipped` and `skill_suggested_patch` events are persisted; the same transaction updates `skill_effect_summaries` through its owning repository. Learning candidates reference the source Skill usage event directly; reflection, guidance and executor-route event tables are not part of the schema. `awaiting_decision` and `awaiting_integration` remain Subtask-only states; startup recovery reconciles applications, child items, cancellation cleanup, worktree process records, leases and publication state before accepting input.

Host product data defaults to `$XDG_DATA_HOME/anyfusion`, or `~/.local/share/anyfusion` when `XDG_DATA_HOME` is unset. Runtime state lives in its `runtime/` child; `METACLAW_HOME` remains the explicit override. The legacy `~/.metaclaw` location is not a fallback and must not become a second runtime database. The Ubuntu container uses the same layout rooted at `/data/anyfusion`.

The repository-root `anyfusion` command is the sole native startup and bootstrap path. Gateway service mode runs in the foreground through `anyfusion gateway run`; repository-owned PID/log wrappers and generated systemd service launchers do not exist. A server process supervisor may wrap that command without introducing another configuration path.

The legacy routing/intent subsystem, `PolicyKernel`, `TaskAdmissionGate`, `SchedulerEngine`, queue/preemption policy and parked auto-resume have been removed. The target active path is `PlanningAgent/Application Shell → KernelWorkflow → ControlKernel → idempotent Runtime handlers → SubtaskAttemptRunner`; do not reintroduce a parallel strategic interpreter or allow a workflow framework to own domain retry policy.

`$ANYFUSION_CONFIG_HOME/executors.yaml` is the sole static authority for controlled capabilities, discovery profiles, Executor descriptions, enablement and installation bindings. Loading it produces one immutable, digest-bound `ExecutorRegistrySnapshot` with credential-free TUI, Planner, Kernel and Runtime projections. Planner receives only enabled Executors with successful verification for the current digest. Kernel receives the same candidate set plus capability coverage and health facts and revalidates every proposed name. Runtime receives only driver/path/home/environment/backend bindings for the same verified digest. A reload failure retains the previous valid snapshot; a manual YAML edit takes effect only after explicit reload or restart, and any digest change makes prior verification stale. Only `planner-1` is seeded; Executor WorkUnits are created and probed on demand after Kernel authorization.

The live `MetaclawSession` owns the active Registry snapshot. Planner MCP reads
its current credential-free Registry projection through Planner Host Protocol
v2 rather than constructing another Registry loader. Kernel and Runtime receive
projections from that same Session-owned snapshot. Production execution requires
an explicit verified Runtime binding; name- and environment-derived fallback
bindings do not exist.

Registration is one application service shared by CLI, slash commands and AnyFusion-Pi. Codex, Pi and Hermes use known discovery profiles and dedicated drivers; unknown CLIs must declare the full `cli-session` initial/resume/session-output/timeout/termination protocol. Verification uses a temporary Git workspace and isolated runtime home, checks the absolute binary and version, returns one random challenge in the first session, extracts its session ID, resumes the same session for a second challenge, and verifies output, timeout, abort, cwd and home isolation. Registration atomically replaces `executors.yaml`, records the digest-bound verification, enables the Executor and refreshes the snapshot only after all checks pass. Configuration stores environment file paths and inherited variable names, never credential values.

Executor recovery is event-driven rather than periodic. `ExecutorRecoveryRefreshService` inspects only enabled AgentClasses whose persisted health is already `error`, coalesces concurrent checks for the same class, records a bounded redacted recovery audit and permits only `error -> healthy`; `disabled` never auto-recovers. Planning and recovery refresh run concurrently, but Kernel admission waits for both. If a relevant class recovers, the proposal may be revised once in the same persisted AnyFusion-Pi session. An existing Task with no usable eligible class persists its latest proposal as `waiting_for_availability`; a later `executor_recovered` fact lets Kernel re-admit the proposal and move the Task to `ready` without another model call or immediate dispatch.

When touching dispatch, update focused behavior tests around `ControlKernel`, `DurableKernelWorkflow`, the decision/application ledger, work-graph runtime, work-unit claims and attempt landing. Attempt terminal regressions remain anchored in `tests/execution/subtask-attempt-runner.test.ts` and `tests/session/planning-agent-session-routing.test.ts`.

## Routing Language

**Task**:
A durable top-level unit of user work. ADR-0011 admits at most one active top-level Task; Phase 6 allows independent Subtasks inside it to execute concurrently and keeps the Task's single-active slot occupied while cancellation cleanup still owns containers or leases.
_Avoid_: request, prompt, executor run, browser tab

**Subtask**:
A decomposed piece of work inside a Task, planned so it can have at most one pending/active attempt at a time. Its lifecycle is `ready | running | awaiting_integration | awaiting_decision | blocked | done | cancelled`.
_Avoid_: work unit, executor instance, raw prompt

**Task State**:
The top-level Task lifecycle: created, ready, running, parked, blocked, done, archived, and cancelled. It never contains `awaiting_decision`.
_Avoid_: executor state, work unit state

**Agent Class**:
A compatibility value projection used by existing WorkUnit and receipt contracts. Planner remains a seeded AgentClass; Executor-class values are derived from the current Executor Registry Snapshot and are never a separate static or installation-binding authority.
_Avoid_: persisted executor definition, executor profile, capability class, instance, worker

**Routing Capability**:
A controlled, supported delivery contract that helps Planner prefer an Executor AgentClass. It is not an exhaustive inventory of that Executor's native tools, permissions, or theoretical abilities.
_Avoid_: tool list, hard permission, free-form capability tag

**Executor Registry Snapshot**:
The immutable, `configDigest`-bound load of `$ANYFUSION_CONFIG_HOME/executors.yaml` plus matching verification facts. Its controlled TUI, Planner, Kernel and Runtime projections share one Executor set and version while exposing only the fields needed by each consumer. Failed reload retains the previous valid snapshot.
_Avoid_: mutable YAML object, database definition table, built-in catalog, Work Unit inventory

**Executor Catalog**:
The Planner-safe projection of the current Executor Registry Snapshot. It contains only enabled, verified, digest-matched Executors, controlled delivery capabilities and routing descriptions; it excludes binary paths, homes, environment sources, credentials, health implementation and process details.
_Avoid_: executor status, Work Unit capacity, runtime binding, built-in catalog

**Planner**:
The agent class responsible for understanding user intent and proposing structured plans. A concrete planner work unit implements the PlanningAgent interface; it proposes but does not authorize or apply runtime state changes.
_Avoid_: leader, router agent, implementation agent, executor

**PlanningAgent**:
The small interface exposed by a planner work unit: given a planning context, return a structured PlanningAgentPlan. It is the semantic understanding seam, not a storage or runtime authority.
_Avoid_: policy kernel, session intent service, executor

**PlanningAgentPlan**:
A strict v7 proposal from the PlanningAgent describing intent, target, task control, risk, confidence and clarification needs. It contains one non-empty v6 work graph only for `plan_work_graph`, or an exact approve/deny resolution only for a pending `authorization_resolution`; all other action-specific fields are null. Work-graph nodes use structured dependencies, typed context references, keyed acceptance criteria, `deliveryKind: edit | report`, controlled delivery capabilities and ordered AgentClass preferences. A plan is not executable until its durable event is authorized or rewritten by `ControlKernel` and recorded in the decision ledger.
_Avoid_: runtime command, task event, execution policy

**ControlKernel**:
The pure deterministic v5 decision module for Planning, frontier batch dispatch, capacity, execution outcome, Task/Subtask cancellation, partial-result acceptance, generation replan, deferred availability, Executor recovery, publication conflict, contract failure and timer events. Its only public Interface is `decide(event, snapshot)`.
_Avoid_: planning agent, runtime applier, executor router

**KernelDecision**:
The one high-level authorization that Runtime may apply. Its identity is deterministically derived from the triggering event ID.
_Avoid_: raw plan, route decision, executor output

**KernelSnapshot**:
The minimal, complete and bounded immutable facts required for one Kernel event.
_Avoid_: live repository handle, mutable runtime state, session transcript

**Executor**:
The agent class responsible for carrying out claimed subtasks and reporting results back to the planner/task context. Executors do not own task planning.
_Avoid_: planner, leader, router

**Work Unit**:
A concrete runtime agent instance that belongs to an agent class and can be either a planner or an executor. A work unit is the runtime slot that starts, idles, claims work, runs, waits, heartbeats, drains, fails, or stops.
_Avoid_: subtask, task, agent class, capability class

**Work Unit State**:
The runtime lifecycle vocabulary for work units: starting, idle, claimed, running, waiting, heartbeat_lost, failed, draining, and stopped.
_Avoid_: task state, subtask state

**Work Graph**:
The sole execution-structure fact for one task generation: a v6 revisioned DAG of capability-minimal Subtasks whose `dependencies` are both topology and typed delivery contracts. Every node declares whether it may change the workspace (`edit`) or must remain read-only (`report`). Every edge has one to twelve keyed `text` or `artifact` items; only published direct-edge handoffs and controlled task evidence enter downstream context. A pure function derives the runnable frontier without persisting an execution layer. Kernel may authorize up to four independent nodes in one deterministic batch; retry, fallback, continuation, merge repair and bounded replans remain Kernel policy.
_Avoid_: raw prompt, route decision, executor plan, issue thread

**Subtask Execution Context**:
The only Executor input contract: Task background, the current operational Subtask, direct incoming handoffs, outgoing requirements, Planner-selected evidence, sibling titles marked out of scope, workspace boundaries, the completion-report contract, and evidence-tool availability. Runtime retains Task/Subtask/attempt/WorkUnit identities and all acceptance/handoff keys outside model output.
_Avoid_: Task prompt passthrough, conversation history, task-level memory bundle, sibling goals

**Completion Protocol**:
The required final Executor response contract: non-empty clean Markdown followed by exactly one `metaclaw:completion:v3` strict identity-free JSON report containing only `evidence` and nullable `noChangeReason`, or a controlled `failure`. Runtime computes one authoritative workspace delta before completion validation, injects the bound schema/Subtask/attempt/WorkUnit identities, acceptance keys and exact outgoing handoffs, and derives artifacts only from created/modified files in that delta. `report` requires zero delta and null reason; changed `edit` requires null reason; zero-delta `edit` requires a non-empty reason. Truncated or indeterminate delta fails closed. Runtime strips the report from every user-facing and memory-facing result.
_Avoid_: model-supplied identity/key fields, legacy envelope fallback, best-effort trailer, visible machine block

**Execution Evidence**:
The attempt-bound, Task-scoped read-only port for eligible user input, user materials, and confirmed preferences. Ordinary assistant/Executor output and dependency results are not generally searchable; an explicitly authorized assistant interaction is exact-get only.
_Avoid_: conversation transcript, cross-task search, dependency output channel

**Attempt Receipt**:
The immutable terminal audit for one Task/Subtask/attempt/WorkUnit/AgentClass invocation, including attempt kind, provenance, raw response and parsing/verification facts. A successful receipt proves candidate production, not publication or Subtask completion.
_Avoid_: retry state machine, user-visible result, mutable handoff

**Cancellation Fence**:
The durable Kernel-authorized transaction that makes a Task or an atomic downstream Subtask closure non-runnable before Runtime starts physical cleanup. Active dispatch/publication rows remain `cancelling` and continue to occupy capacity until the sandbox is exited or missing and WorkUnit/resource leases are released. Outcomes arriving after the fence are stale `no_op` facts.
_Avoid_: best-effort process abort, status-only update, rollback of published facts

**Generation Replan Request**:
The one durable ordinary automatic-replan request for a Task generation/revision. Multiple exhausted Subtasks coalesce into it; independent work drains first, Planner runs only at quiescence, and an exact token prevents a cancelled or stale Planner result from superseding the graph.
_Avoid_: conflict-chain replan, per-attempt hidden retry, parallel Planner calls

**Work Unit Event**:
A durable runtime event about a work unit, such as state changes, claims, heartbeats, failures, draining, or stop events.
_Avoid_: TUI output line, transient progress text, task message

**Kernel Executor Status Projection**:
The Kernel-owned, persisted, one-row-per-AgentClass current control-plane view of class health, recent execution outcomes, and bounded redacted recovery checks. AgentClass instances are independently started, so a busy Work Unit does not change this projection; it is not a Work Unit or an execution log.
_Avoid_: AgentClass availability, Work Unit state, executor call log

**AgentClass Health**:
The Kernel's dynamic classification of whether a registered Executor itself is usable: unverified, healthy, error, or disabled. `unverified` is never routable; configuration verification must succeed for the current registry digest before the Executor enters Planner or Kernel candidates. `error` is a re-verifiable observation and may recover only through a successful structured recovery probe; `disabled` is the administrative lock and never auto-recovers. A failed executor instance does not change class health unless its cause proves a class-level fault or meets the configured systemic-failure rule.
_Avoid_: Work Unit status, last execution result, capacity

**Task Purge**:
The sole application-service path that can permanently remove a terminal, fully quiescent Task and its Task-scoped graph, execution, publication, search, memory, workspace and artifact facts. It writes a minimal audit and a transaction-scoped authorization before deleting immutable receipts, handoffs or merge attempts; ordinary SQL deletion remains trigger-blocked. Smoke cleanup may purge only a `system_smoke` Task whose `smoke_run_id` exactly matches the run.
_Avoid_: ordinary Task cancellation, ad hoc SQL cleanup, automatic database reset

**Recent Recovery Checks**:
The bounded Planner-safe audit of event-driven probes performed only for enabled AgentClasses currently in `error`. Each entry records trigger, time, recovered/still-error/timeout outcome, and a redacted structured failure. It never enters Recent Execution Attempts and never discovers new faults in healthy classes.
_Avoid_: periodic health poll, raw Docker/provider logs, execution attempt

**Deferred Availability Plan**:
The exact latest replan proposal persisted with a `waiting_for_availability` generation replan request after Kernel determines that a current Task has no usable eligible Executor. Recovery re-admits this proposal without another model call; stale/cancelled revisions are no-ops.
_Avoid_: Planner retry loop, blocker-text parsing, immediate dispatch

**Recent Execution Outcome**:
The latest recorded result and classified reason for an AgentClass execution attempt. It informs Planner choice without by itself making the AgentClass unhealthy.
_Avoid_: AgentClass Health, executor availability

**Recent Execution Attempts**:
The bounded, Planner-safe history of the three latest execution outcomes for one AgentClass. It contains outcome time and classified reason, not prompts, raw logs, tool traces, or credentials.
_Avoid_: execution transcript, executor call log

**Task Event**:
A durable event about a task or subtask, such as planned, recovered, dispatched, blocked, succeeded, failed, cancelled, or resumed. Task events are the replayable source of truth for planner recovery; session output is only a UI projection.
_Avoid_: executor-only log, route event, progress line

**Task Runtime View**:
The runtime picture MetaClaw maintains for a task: the task conversation, subtasks, current work graph, claimed work units, progress, and reports.
_Avoid_: executor-only status, route event, transcript

**No Action**:
A valid planner outcome meaning no subtask should be dispatched. The runtime must preserve it as an intentional decision rather than forcing an executor run or marking the task done.
_Avoid_: failure, clarification, unknown route

**Selection Signal**:
A controlled fact used by Planner to order AgentClasses for a Subtask, such as a static Routing Capability or current AgentClass Health and Recent Execution Outcome. Natural-language keyword weights, legacy AgentClass availability, and WorkUnit busy state are not selection signals.
_Avoid_: static historical success as truth, user preference

**Preferred AgentClass List**:
The ordered AgentClasses proposed for one Subtask. The first item is preferred and the remaining items form its fallback chain; the list is still subject to Kernel validation before execution.
_Avoid_: unordered candidates, Work Unit pool, capability registry

**Fallback Chain**:
The ordered tail of a Preferred AgentClass List after its first item. Runtime may try these already-approved alternatives in order when the preferred class cannot be used; new cross-class retry and recovery policy remains a separate Kernel concern.
_Avoid_: preferred AgentClass, race, parallel candidates, unplanned platform reroute

**Verification Level**:
The strength of post-execution validation: none, compile, test, or review.
_Avoid_: quality gate, acceptance check, validator

**Persistent Workspace**:
The private `(projectId, taskId, generationId, subtaskId)` Git worktree created from the selected Project repository and retained across attempt process/container restarts, retry, fallback and publication review. Its branch is `anyfusion/task/<taskId>/subtask/<subtaskId>` and its files live under `$METACLAW_HOME/project-worktrees/<projectId>/workspaces/<taskId>/<generationId>/<subtaskId>/files`. The Executor commits and synchronizes local `main`; only exact user-approved publication merges the complete branch into Project `main`. Checkpoint/CAS material supplements Git recovery but is not a second merge authority.
_Avoid_: internal bare repository, nested project repository, unversioned sibling directory, treating a container or prompt constraint as filesystem isolation

**Resource Lease**:
The attempt-bound claim over one normalized repository, worktree, mount-relative path, logical resource or external object. It records read/write access, owner, heartbeat, expiry, release and wait relationships; overlapping claims conflict whenever either side writes.
_Avoid_: permanent workspace ownership, WorkUnit identity, host absolute path

**Capability Request**:
An Executor's structured request for one concrete operation outside its default AgentClass permission profile. Runtime canonicalizes it; Kernel v5 alone grants a bounded capability, denies with an Executor-visible reason, or denies and escalates the exact request to Planner/user authorization. A granted request returns an opaque grant ID but does not itself widen sandbox authority. Runtime supplies versioned explicit rules: exact Task-registered read partitions, plus normalized public HTTP(S) targets only for the public-web-research profile; secrets and mutations are never profile-allowed.
_Avoid_: Planner resource claim, stderr parsing, broad permission prompt

**Capability Use**:
One attempt-bound audit-budget consumption of a previously granted capability. The Executor supplies the operation payload; trusted Runtime measures its UTF-8 size and atomically enforces attempt identity, expiry, call and byte budgets. This is not proof of universal operation mediation and does not add fine-grained authority beyond the sandbox profile.
_Avoid_: universal capability broker, syscall enforcement claim, caller-declared byte count
