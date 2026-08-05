---
status: accepted
amended_by: ADR-0017, ADR-0018, ADR-0020, ADR-0021, ADR-0022, ADR-0023
last_updated: 2026-08-02
---

# Planner-Owned Semantics And Tool-Mediated Context

> Architecture alignment (2026-07-17): Planner semantic ownership, isolated execution, bounded context and fail-closed behavior remain accepted. PlanningAgentPlan v2, WorkUnit-only class health, Runtime-owned strategic fallback, configured-default resume routing and the `authorizeDirectReply` target exception are superseded by ADR-0017 through ADR-0020.

## Context

After ADR-0014 established `PlanningAgent -> PolicyKernel -> Runtime`, semantic decisions still leaked into session and task helpers. Keyword lists inferred continuation, recovery, priority, risk, clear scope, durable-task ownership, and natural-language memory capture. Planner input also passively included recent tasks, executor classes, focus state, and rule hints whether they were relevant or not. Executor availability was represented both as static `AgentClass.availability` and as live `WorkUnit` state, while a seeded `executor-1` made capacity appear healthy before any runtime probe.

These overlaps made the same request answerable by several conflicting mechanisms and made Planner behavior difficult to audit.

## Decision

All natural-language semantic interpretation belongs to the AnyFusion-Pi `PlanningAgent`. Code may still parse deterministic syntax: slash commands, explicit IDs, paths, URLs, and attachments. ADR-0021 and ADR-0023 own the current Work Graph/Planning contract and durable evolution; this ADR does not define a parallel plan version or semantic defaults.

The Planner runs through a dedicated AnyFusion-Pi process runner. Non-interactive surfaces use `--mode rpc` over stdin/stdout JSONL with one controlled child lifecycle per turn and serialization per persisted Pi session. Interactive TUI and RPC turns submit through the same restricted Pi-native `submit_planning_proposal({ plan })` tool and AnyFusion Planner Host Protocol v2 over a mode-`0600` Unix JSONL socket. Pi runtime, not the model, injects `sessionId`, `turnId`, `userInput` and deterministic `submissionId`. The same socket may request completion for deterministic slash input and transport an explicit user-authored slash command, but Pi does not own its semantics or execute it: `MetaclawSession` delegates completion to, and routes execution through, the existing `CommandCatalog`/`InputController`, which remain the only dynamic-candidate, validation and mutation authority. The fork fixes the system prompt, Provider/Model configuration and allowed tools; only bounded read-only query/file-read capabilities plus the proposal tool are available. Arbitrary shell, edit/write, extension/package installation, account login, model switching and self-update are disabled.

Proposal rejection is structured tool feedback inside the current Pi ReAct turn. The Agent may naturally revise and call the tool again; there is no proposal-specific retry count, repair prompt, assistant-text envelope parser, trailing-brace recovery or outer validation loop. The first accepted proposal locks the turn and terminates the Agent response with the MetaClaw-authoritative display result. Identical submissions replay idempotently; a different submission after acceptance returns conflict. Transport uncertainty is a distinct result and can only be resolved by replaying the identical submission. Planner failure, timeout or bridge/RPC unavailability never synthesizes a fallback plan; no keyword routing or Codex Planner fallback is allowed.

Each non-interactive turn sends only the current user input into the bound persisted Pi session; Pi owns the current-session conversation history and fixed system instructions. MetaClaw does not reconstruct SQLite interactions into each prompt. Trusted session identity, authorization boundaries and schema location are supplied by the Application Shell, while MetaClaw-owned task/session/runtime facts may cross only bounded read-only query or snapshot contracts rather than a passive context dump. The host binds the current session; the model cannot request another session. Tool and run audits store only bounded, redacted summaries.

`PolicyKernel` remains deterministic authorization. A state-changing plan with `risk.requiresConfirmation=true` is converted to clarification. A later confirmation or cancellation is a new Planner turn that may inspect recent planning decisions. Invalid status and clear scopes are rejected; unknown clear scope never means `all`. (2026-07-27: ADR-0022 renamed this seam to `ControlKernel` and removed the `authorizeDirectReply` shortcut ADR-0014 recorded; there is now exactly one public decision Interface.)

`AgentClass` and Routing Capability definitions are static catalog data governed by ADR-0018. Dynamic class health and recent outcomes come from the bounded ADR-0017 projection; WorkUnit state remains instance/claim/heartbeat fact and is not interchangeable with class health. Startup inserts or upgrades eligible built-in definitions according to provenance rules, does not overwrite user-modified/custom rows, and does not seed a fictitious executor WorkUnit.

After authorization, Runtime follows the Kernel-approved v3 `preferredAgentClassList` for claim/probe mechanics: it may claim an idle WorkUnit or create/probe a `starting` instance, and a failed probe becomes a Runtime fact. Runtime does not switch AgentClass after execution failure or decide the terminal Task action. (2026-07-27: Phase 3–4 completed this move — capacity exhaustion, retry, fallback, replan and terminal policy are now decided only by `ControlKernel`.)

The runtime image contains the compiled MetaClaw application, generated current schema, versioned Planner host bridge, isolated Planner/Executor templates and entrypoint. It copies a pinned self-contained AnyFusion-Pi Planner artifact carrying Node 22 into the Node 20 MetaClaw control image. Planner and MetaClaw exchange only JSON/JSONL and environment configuration; Planner source and dependencies are not linked into MetaClaw. Executor Codex and Executor Pi remain separate canonical attempt images.

## Supersedes

- This ADR supersedes ADR-0014's exception that natural-language memory/preference capture fast paths may bypass PlanningAgent. Explicit `/memory add` remains deterministic; natural-language “remember” input is planned normally.
- This ADR superseded the historical ADR-0013 fixed `planner-1` plus `executor-1` pool. `planner-1` may represent the in-process planner slot, but executor WorkUnits are created and probed on demand.
- ADR-0020 is authoritative for the PlanningAgent/Kernel/Runtime module chain and vocabulary ownership; ADR-0022 is authoritative for the Kernel decision Interface. ADR-0021 and ADR-0023 govern the current Work Graph and durable execution contracts.

## Consequences

There is one semantic owner and one logical authorization seam. New tasks do not consume unrelated history, while continuation/status requests can obtain evidence on demand. Static Routing Catalog facts survive restarts without pretending to be runtime health. Runtime follows approved claim/probe order but owns no post-failure fallback or configured-default resume policy.

The current Planner does not receive a reconstructed per-turn SQLite history block and has no write-capable tools. Current-session dialogue stays in the persisted Pi session; confirmed preferences, task facts and runtime diagnostics remain MetaClaw-owned and may be exposed only through bounded read-only query contracts. Cross-session semantic search remains unavailable. Parallel execution, preemption, AgentClass versioning, and Planner replanning after probe exhaustion also remain out of scope.

## Superseded amendment: bounded initial memory context

As of 2026-07-15, the Planner received confirmed global memory up to `top_k_preferences` plus bounded current-session conversation history at the start of each planning turn. This closes the `direct_reply` gap where explicit `/memory add` records were persisted but invisible to the agent producing the answer. The block is read-only data, current user input and authorization rules retain precedence, and task execution keeps its existing independent memory review and injection path.

## Amendment: bounded read-only file access for the Planner

The Planner may read explicitly selected repository file bodies when answering or planning, but it does not receive arbitrary shell access. The AnyFusion-Pi fork exposes the built-in read-only `read` capability and disables `bash`, `edit`, `write`, `grep`, `find` and `ls` tool entrypoints. Repository reads therefore remain an information capability rather than an execution capability. Task, Kernel, Executor, storage and Git mutation remain outside the Planner process.

## Amendment: tool-mediated runtime diagnostics

Runtime failures, interruptions and recovery facts are not passive Planner context. The owning Runtime or adapter persists a bounded, redacted reason at the point where the failure is observed. Planner receives that evidence only through an explicit read-only diagnostic tool when the user asks why execution is blocked or unavailable, and explains the persisted fact in natural language. Raw logs, credentials and write authority remain outside the Planner interface.

## Superseded amendment: native Codex conversation ownership

As of 2026-07-30, this amendment supersedes the earlier ephemeral-runner and
per-turn startup-context rules. One live MetaClaw session is bound to one native
Codex thread: the first Planner turn uses `codex exec`, captures
`thread.started.thread_id`, and later turns use `codex exec resume` with that
thread. Codex owns dialogue history and compaction. MetaClaw keeps only the
in-process `sessionId -> threadId` resume handle for this pre-release scope; it
does not replay a second model conversation.

In that superseded Codex design, stable Planner authority was registered through native Codex mechanisms:
`developer_instructions`, the `metaclaw-planner` Skill, the structured output
schema, and the session-scoped read-only MCP. Each turn sent only the current
user input; one validation repair sent only validation errors in the same
thread. Confirmed preferences, canonical routing facts, exact pending
authorization, task/runtime state and diagnostics are queried through MCP when
needed rather than serialized into every prompt.

SQLite interactions and Kernel decisions remain durable product audit/query
facts. They are not reconstructed into Codex dialogue history.


## Amendment: AnyFusion-Pi conversation ownership

As of 2026-07-31, this amendment supersedes the native Codex conversation
ownership amendment above and the earlier per-turn SQLite history reconstruction rule. One live MetaClaw session maps to one persisted Pi
session file. Non-interactive Gateway, Feishu and scripted surfaces start the
Planner in `--mode rpc`, send the current prompt as one correlated JSONL command,
wait for the authoritative `agent_end` event, and close the child only after the
session writer has settled. Concurrent turns for the same session are serialized.
The interactive TUI uses the same AnyFusion-Pi semantic implementation and a
separate versioned host protocol for read-only snapshots and proposal submission.

The Planner submits an internal v7 plan through the Pi-native
`submit_planning_proposal({ plan })` tool. MetaClaw remains the only
schema/semantic validator and the only component allowed to emit
`plan_proposed` into `DurableKernelWorkflow`. Bridge or RPC failure is reported
as unavailable and never implies that a Task was created. MetaClaw Node 20 and
Planner Node 22 remain isolated processes; they share no source modules or
in-process objects.

## Amendment: Pi Planner behavior parity (2026-08-03)

Native TUI and RPC now use one AnyFusion-Pi Planner bootstrap. The fork injects
one fixed `metaclaw-planner/SKILL.md` exactly once behind a small stable system
prompt. Dynamic facts are not serialized into that prompt: the Planner receives
only seven allowlisted read-only MetaClaw MCP tools (`search_tasks`,
`get_task_context`, `get_current_session_context`, `get_planning_context`,
`get_runtime_state`, `list_executor_status`, and `get_executor_diagnostics`) and
four Pi-native repository readers (`read`, `grep`, `find`, and `ls`) rooted at
`/workspace`. Extra MCP tools and external Skills, extensions, MCP configuration,
prompt templates, model controls, package installation, and updates remain
unavailable.

MetaClaw injects its absolute Node 20 executable and compiled Planner MCP entry
path. Pi's Node 22 runtime never substitutes `process.execPath`. Missing fixed
tools fail before the first turn. A mid-turn MCP transport loss locks proposal
submission, aborts the current agent loop, and is retried only by reconnecting
before the next user turn. Ordinary MCP domain errors remain ordinary tool
results. Proposal-host uncertainty retains its independent idempotent replay
contract.

PlanningAgentPlan v7 is exposed only through the proposal tool schema. Rejected
plans remain natural tool feedback inside the same Pi ReAct loop. The retired
Codex Stop hook, model text output schema, JSON extraction/trailer repair,
fixed validation repair count, outer repair prompt/loop, generic read-only shell,
catalog environment injection, and unused `get_session_interaction` exposure are
not compatibility paths.
