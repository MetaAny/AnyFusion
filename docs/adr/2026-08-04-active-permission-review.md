# Active Permission Review

- **Plan date**: 2026-08-04
- **Completion date**: 2026-08-04
- **Status**: Implemented and validated
- **Closing commit**: `feat: add active permission review`

## Scope

Replace local Pi `/permission` and Planner-authored interactive authorization with a Host-projected, button-only review flow. Durable permission requests, Kernel decisions, applications, grants, authorizations, and recovery remain authoritative; Pi owns only transient presentation state.

## Confirmed Decisions

- Remove the shared `/permission approve|deny` command group without deleting the underlying workflow or non-interactive authorization schema.
- Reject interactive `authorization_resolution` before proposal-turn persistence; preserve RPC, Feishu, and Session Planner semantics.
- Project only the active current-session, applied, unresolved escalation for each request inside the existing 24-hour validity window. When a restart leaves an `awaiting_approval` publication owned by an older Session, startup submits the same immutable request through the durable permission workflow to create a current-Session review Decision; it does not create a grant, change the candidate commit, or rerun the Executor.
- Treat each later applied review escalation as superseding the prior presentation through its Decision causation chain. A button from an older Session therefore conflicts even though the underlying request remains unresolved.
- Use Pi's native two-option Selector. Esc snoozes until the next user input; disconnect and expiry never create a resolution fact.
- Keep permission UI out of the Pi session branch and Planner context.

## Delivered Behavior

- Host Protocol v2 advertises `permission_request` and supports backlog, incremental request/closed notifications, and serialized `permission_resolve` requests on interactive sockets only.
- MetaClaw revalidates session ownership, Kernel application state, request status, resolution replay, conflict, and expiry before submitting `source: button` through the existing workflow.
- Startup recovery now re-presents valid unresolved repository-promotion reviews after process replacement. The publication, Task/Subtask/attempt identity, request fingerprint, operation, paths, and candidate commit remain unchanged; expired reviews stay fail-closed with the candidate preserved and an explicit diagnostic.
- Pi strictly validates permission frames, maintains a sorted non-persistent inbox, displays one approval Selector at a time, closes stale requests, and reconnects with 1/2/5-second capped backoff.
- Permission review takes priority over passive Executor-result writes and never sends a custom message or triggers the Agent.

## Validation

- MetaClaw `npm run lint`: passed.
- MetaClaw Docker focused suite: 44 tests passed, including Unix socket and SQLite coverage.
- AnyFusion-Pi `npm run check`: passed.
- AnyFusion-Pi permission inbox focused tests: passed; Unix socket client test is skipped on Windows and runs on Linux.
- MetaClaw Docker full suite: 186 files passed, 4 skipped; 735 tests passed, 15 skipped; zero failures.
- AnyFusion-Pi Linux monorepo full suite: all workspaces passed with zero failures.
- AnyFusion-Pi Docker `npm run build:offline` and `npm run check`: passed.
- Native Planner-session smoke: passed with two-turn memory and one persisted AnyFusion-Pi session.
- Artifact smoke: passed through Planner, Kernel, Codex Executor, Git publication, and authoritative artifact verification.
