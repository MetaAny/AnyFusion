---
name: diagnosing-anyfusion-bugs
description: Diagnose AnyFusion/MetaClaw bugs from existing runtime evidence before forming or testing hypotheses. Use whenever AnyFusion is broken, inconsistent, stuck, slow, failing to pause/resume/recover/publish, showing unexpected Task or Executor state, or when a report involves live processes, Docker, SQLite, Kernel events, attempts, sandboxes, WorkUnits, leases, permissions, or workspaces.
---

# Diagnose AnyFusion Bugs

Use logs and the durable database as the primary diagnostic instrument. They exist to make
the runtime explainable; do not bypass them by beginning with code speculation.

For this repository, this evidence-first order takes precedence over generic
reproduction-first debugging workflows whenever runtime evidence exists.

## Mandatory Workflow

1. **Preserve the scene.** Do not restart processes, remove containers, clear state,
   mutate SQLite, or manually repair records before capturing evidence. Use read-only
   commands and queries. Ask before any state-changing diagnostic action.
2. **Locate the real runtime.** Identify the host process, container, child processes,
   database path, and actual stdout/stderr sinks. If `docker logs` is empty, inspect process
   file descriptors or the supervisor/terminal destination instead of assuming no logs exist.
3. **Read the durable facts.** Read all of
   [references/runtime-fact-map.md](references/runtime-fact-map.md), then inspect relevant
   records. Discover the current schema before relying on remembered columns.
4. **Build one correlated timeline.** Join facts by Task, Subtask, attempt, Kernel event,
   decision, WorkUnit, sandbox, workspace, permission, and publication IDs. Identify the
   last consistent state and the first missing, contradictory, or rejected transition.
5. **State evidence before theory.** Report observed facts, supported deductions, and
   unknowns separately. Never present an inference as a log or database fact.
6. **Trace the owning write path.** From the first broken transition, inspect its writer,
   transaction or terminal fence, and caller. Use current code, tests, ADRs, and `CONTEXT.md`;
   do not begin with a broad code tour.
7. **Escalate only when facts are insufficient.** Then form ranked falsifiable hypotheses,
   add targeted instrumentation, or construct a minimal reproduction. State which missing
   fact each probe is intended to obtain.
8. **Fix and close the loop.** Add a regression test at the owning seam, apply the smallest
   fix, rerun focused tests, and re-check the original fact chain when safe and available.
   Verify terminal receipts and cleanup facts, not merely the visible UI state.

## Hard Gates

- Do not edit product code for a reported live-runtime bug until an initial fact report
  exists, unless no runtime evidence is available.
- If access is unavailable, request logs, a database snapshot, container access, or temporary
  instrumentation before speculating.
- Do not treat a screenshot, UI projection, or single log line as the whole state.
- Do not copy a live WAL database without its WAL/SHM files; prefer a read-only live
  connection or SQLite's backup mechanism.
- Do not expose credentials or persist production data in the repository.

## Initial Fact Report

Before proposing a cause, provide:

```text
Incident scope: <runtime/container/task and time window>
Observed facts: <timestamped records and process/log observations>
First inconsistency: <expected transition versus durable result>
Unknowns: <facts not available>
Next read-only check: <only if not yet localized>
```
