# Unified Executor Registry And Schema 32

- Status: Complete
- Plan date: 2026-08-07
- Completion date: 2026-08-08

## Scope

Replace persisted/static AgentClass executor definitions with the host-level
`$ANYFUSION_CONFIG_HOME/executors.yaml` authority. Load it into one immutable,
digest-bound registry snapshot projected to the TUI, Planner, Kernel, and
Runtime. Add verified installation bindings, generic session drivers, schema
32 smoke/purge audit facts, controlled terminal Task purge, and smoke Task
visibility rules.

## Ownership

- `src/executor/` owns config validation, digesting, immutable snapshots,
  driver bindings, discovery, registration, and verification application
  services.
- Planning consumes only the Planner-safe projection.
- Kernel consumes candidate, capability coverage, health, and digest facts.
- Execution consumes only verified Runtime bindings and remains responsible for
  process lifecycle and normalized observations.
- `src/task/` owns purge eligibility and the purge application transaction.
- `src/storage/` implements verification, smoke audit, purge audit, and
  fresh-only schema 32 persistence.

## Validation

- Focused Executor config/snapshot/driver tests.
- Planner and Kernel rejection tests for unknown, disabled, unverified, stale,
  and capability-incomplete candidates.
- Fresh schema 32 and v31 rejection tests.
- Task purge trigger, cascade, rollback, and active-resource rejection tests.
- TypeScript lint, build, focused tests, then feasible native smoke validation.

## Completion Record

Delivered:

- Host-level `$ANYFUSION_CONFIG_HOME/executors.yaml` authority with strict
  Capability, Profile, Executor and installation-binding validation.
- Immutable digest-bound snapshots and credential-safe TUI, Planner, Kernel
  and Runtime projections.
- Known Codex, Pi and Hermes discovery/driver support plus the generic
  `cli-session` protocol.
- Shared CLI, slash-command and AnyFusion-Pi registration flow with isolated
  first-session/resume verification and atomic YAML replacement.
- Planner and Kernel semantic rejection of invented, disabled, unverified,
  stale and capability-incomplete Executors; Runtime driver dispatch without
  name-based command/home/result/continuation branches.
- Fresh-only schema 32, digest-bound verification facts, smoke audits, Task
  source metadata, controlled purge authorization and minimal purge audits.
- Hidden `system_smoke` Tasks, formal cancellation/quiescence/purge cleanup and
  bounded smoke-audit retention.
- Terminal Task purge with immutable-fact trigger protection, transactional
  rollback and workspace/CAS cleanup.

Validation completed during implementation:

- AnyFusion TypeScript lint and focused Executor registry, registration,
  Planner, Kernel, Runtime, schema, purge, smoke and TUI tests.
- AnyFusion-Pi `npm run check` and focused dashboard/registration-wizard tests.
- Full AnyFusion build passed. The final Vitest close-out passed 190 test files
  and 761 tests, with 4 files and 15 tests skipped (194 files / 776 tests total).
- The test Registry no longer depends on whether the host default
  `executors.yaml` exists. Tests without an explicit `configPath` always use
  the verified immutable test snapshot; explicit Registry tests still load
  their supplied config path.
- The host main database was recreated as fresh schema 32. It retained no
  Tasks after smoke cleanup, while both `codex-cli` and `pi-agent` remained
  enabled and verified against config digest
  `97b0b72ca2fa72add793a198a01065b2514f88e91a1f4809d2817e242a84d904`.
- Real Codex artifact smoke passed on the current host database, workspace,
  Registry and `/usr/bin/codex`. Run
  `smoke_1786172728995_6c85fbaf-75d5-4e72-8ed4-b02fbf219eb8`
  proved Planner routing, Kernel authorization, native execution, completion
  receipt, Git publication and artifact delivery.
- Real Pi research smoke passed with real `web_search` and `web_fetch` calls
  through `/usr/bin/pi`. Run
  `smoke_1786173372880_6f49c416-d8cd-4929-a48d-39a2975671d9`
  proved Planner routing, Kernel authorization, native session execution,
  source-backed report completion and receipt persistence.
- Pi JSONL result collection now selects the last assistant `message_end`
  text, excluding streaming partials and `agent_end` history from completion
  protocol validation.
- Both successful smoke Tasks were formally purged. Post-purge checks found no
  Task, Subtask, proposal, receipt, Kernel, workspace, publication, sandbox,
  lease, work-unit, task-owned path or CAS-file residue; bounded smoke and
  minimal purge audits remained.
- Hermes was intentionally not registered or smoked because its Executor
  profile and capability information were not supplied.

Closing commit: this archive-point commit records the implementation, current
documentation, real host smoke evidence and final verification results.
