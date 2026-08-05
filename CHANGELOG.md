# Changelog

All notable public changes to AnyFusion are documented in this file.

The project follows [Semantic Versioning](https://semver.org/) for public preview releases.

## [Unreleased]

### Added

- Native Codex Planner thread binding with same-thread resume and a two-turn
  memory smoke gate.
- Event-driven recovery probes for enabled AgentClasses already in `error`,
  including bounded Planner-visible diagnostics and `/executor refresh`.
- Planner and Executor activity state projected to the current Ink TUI.

### Changed

- Advanced the current pre-release baseline to Kernel wire/ledger v5 and
  fresh-install SQLite schema v29 with durable Planner proposal turn/submission identity and accepted-turn locking.
- Completed deterministic asynchronous dispatch of up to four isolated attempts
  inside the one active top-level Task, with Git-backed publication and durable
  cancellation/replan recovery.
- Availability-exhausted replans now persist a deferred proposal and recover
  through Kernel admission instead of leaving an errored Executor permanently
  unavailable.

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
