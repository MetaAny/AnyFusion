# AnyFusion Runtime Fact Map

Use this map after preserving the incident scene. Query only the incident's time window and
identifiers; avoid dumping unrelated user content or secrets.

## Locate The Evidence

- Identify containers and host processes before assuming where AnyFusion runs.
- Inspect the process tree and command line to distinguish Runtime, AnyFusion-Pi, Planner MCP,
  Executors, and supervisor processes.
- Determine the real stdout/stderr target. A process attached to a TTY or supervisor may
  produce no useful `docker logs` output.
- Resolve the configured database path from the running process/configuration. Container
  deployments normally keep runtime data under `/data/anyfusion/runtime`.
- Open SQLite read-only with `fileMustExist` and `PRAGMA query_only=ON`. Discover tables and
  columns from `sqlite_master` and `PRAGMA table_info(...)` before querying.

## Correlation Order

Start with the user-visible Task and follow its durable ownership chain:

| Question | Primary facts |
| --- | --- |
| What did the user request and when? | `tasks`, `task_events`, `interactions` |
| Which graph work was active? | `work_graph_revisions`, `subtasks`, `subtask_handoffs` |
| What did the Kernel observe and authorize? | `kernel_events`, `kernel_decisions`, `kernel_decision_applications` |
| Was work actually dispatched? | `kernel_dispatch_items` |
| Did the attempt reach an immutable terminal fact? | `executor_attempt_receipts`, `executor_attempt_runtime` |
| Which Executor still owned work? | `work_units`, `work_unit_events` |
| Were partitions still reserved or waiting? | `resource_leases`, `resource_waits` |
| Was the sandbox alive, exited, lost, or removed? | `attempt_sandboxes` plus live process/container inspection |
| Was recoverable workspace state preserved? | `workspace_records`, `workspace_checkpoints`, `workspace_checkpoint_objects` |
| Was execution waiting on permission or publication? | `permission_requests`, `permission_grants`, `workspace_publications`, `workspace_merge_attempts` |
| Was a completion side effect pending? | `kernel_effect_outbox` |

Not every incident needs every table. Stop expanding once the first inconsistent transition
and its owning write path are identified.

## Timeline Method

1. Record the Task ID and narrowest credible UTC time window.
2. Collect related Subtask, attempt, decision, WorkUnit, sandbox, workspace, permission, and
   publication IDs.
3. Order creation, update, terminal, cancellation, lease, and heartbeat timestamps.
4. Compare each transition with its invariant: parent/child status, dispatch/receipt pairing,
   claim/lease ownership, sandbox lifecycle, workspace checkpoint, and publication state.
5. Mark the first divergence. Treat later errors as consequences until evidence proves otherwise.

Common high-value contradictions include:

- a parked or terminal Task with a running Subtask;
- an active or uncertain dispatch without a terminal receipt after its sandbox exited;
- a terminal attempt with an unreleased WorkUnit claim or resource lease;
- a ready Subtask blocked by an allegedly active prior dispatch;
- a completed candidate waiting in permission/publication state while retry launches again;
- a UI projection that disagrees with durable Task or Kernel facts.

## Evidence Discipline

- Quote exact IDs, timestamps, statuses, and error codes; summarize large payloads.
- Label every conclusion as **fact**, **deduction**, or **unknown**.
- Prefer the earliest violated invariant over the loudest later error.
- Use logs to explain transitions and the database to establish durable state; neither replaces
  the other.
- After a fix, verify both user-visible behavior and the durable terminal/cleanup chain.
