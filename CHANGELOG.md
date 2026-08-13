# Changelog

All notable public changes to AnyFusion are documented in this file.

The project follows [Semantic Versioning](https://semver.org/) for public preview releases.

## [Unreleased]

### Added

- A persistent Windows-hosted Feishu Gateway container with per-chat durable
  sessions, mounted credential files, WebSocket readiness health checks,
  `unless-stopped` recovery, and one-command rebuild operations.
- An opt-in Feishu publication auto-approval policy that preserves the durable
  Kernel permission, grant, and Git publication chain while removing the
  user-visible approval turn.
- Native Codex Planner thread binding with same-thread resume and a two-turn
  memory smoke gate.
- A host-level `$ANYFUSION_CONFIG_HOME/executors.yaml` Registry with controlled
  Capability/Profile/Executor definitions, dedicated Codex/Pi/Hermes drivers,
  generic `cli-session` support, and shared CLI/slash/TUI registration.
- Digest-bound Executor installation verification using isolated two-turn
  session/resume challenges, absolute binary and runtime-home bindings, version
  checks, timeout/abort validation, and credential-free snapshot projections.
- Controlled terminal Task purge with immutable-fact authorization, minimal
  purge audits, workspace/CAS cleanup, and hidden `system_smoke` ownership.
- Event-driven recovery probes for enabled AgentClasses already in `error`,
  including bounded Planner-visible diagnostics and `/executor refresh`.
- Planner and Executor activity state projected to the current Ink TUI.

### Changed

- Feishu final delivery now waits for the complete Task to reach `done`; an
  integrated upstream Markdown handoff can no longer terminate tracking or be
  delivered in place of a downstream PDF or other final artifact.
- Advanced the current pre-release baseline to Kernel wire/ledger v5 and
  fresh-only SQLite schema v32. Schema v31 and older databases are rejected
  with their exact paths; there is no migration, automatic deletion, or
  dual-read path.
- Removed `agent_classes` as an Executor definition and installation-binding
  source. Planner, Kernel, Runtime, CLI, slash commands, and the AnyFusion-Pi
  registration surface now consume one immutable Registry snapshot.
- Runtime dispatch is driver-bound rather than keyed by canonical Executor
  names. Pi JSONL result collection selects the final assistant `message_end`
  and excludes streaming partials from Completion Protocol validation.
- Completed deterministic asynchronous dispatch of up to four isolated attempts
  inside the one active top-level Task, with Git-backed publication and durable
  cancellation/replan recovery.
- Availability-exhausted replans now persist a deferred proposal and recover
  through Kernel admission instead of leaving an errored Executor permanently
  unavailable.

### Validation

- Real Codex artifact smoke and real Pi public-web research smoke passed against
  the fresh schema 32 host database and current Registry; both smoke Tasks were
  formally purged with no Task-scoped database, workspace, artifact, CAS, lease,
  sandbox, or WorkUnit residue.
- The final close-out passed TypeScript lint, production build, 190 Vitest files
  and 761 tests; 4 files and 15 tests remained intentionally skipped.

## [1.2.0-preview.0] - 2026-07-17

### Added

- Public AnyFusion product positioning backed by AnyInt and MetaFusion.
- Developer Preview and limited Internal Pilot status indicators.
- GitHub Actions CI covering TypeScript checks, the Vitest suite, and production builds.
- Public `anyfusion` CLI command with a retained legacy compatibility alias.
- Formal preview release notes and reusable social-preview artwork.

### Changed

- Restructured the English and Chinese README first screens around product positioning, project status, Quick Start, Architecture, and Roadmap.
- Aligned public package metadata with the AnyFusion `1.2.0-preview.0` preview release.
- Updated public-facing documentation to use the AnyFusion brand while preserving internal implementation identifiers.

### Deployment status

- Deployed for limited internal pilot use.
- Current execution scope supports one active top-level task with dependency-aware subtask execution.

### Known limitations

- Only one top-level task can be active at a time.
- Public CI excludes credential-dependent live-model smoke tests.
- CLI, configuration, and runtime contracts may change during the preview period.
- Some command and TUI workflows remain under active development.

[Unreleased]: https://github.com/MetaAny/AnyFusion/compare/v1.2.0-preview.0...HEAD
[1.2.0-preview.0]: https://github.com/MetaAny/AnyFusion/releases/tag/v1.2.0-preview.0
