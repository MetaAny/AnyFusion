# ADR-0018: Supported Routing Contracts and Unified Executor Definitions

- Status: Accepted; registry authority amended 2026-08-08 and active-snapshot projection amended 2026-08-10; module ownership clarified by ADR-0020
- Date: 2026-07-16
- Scope: host-level Executor definitions, capabilities, profiles, bindings, verification and controlled projections

## Context

MetaClaw needs one authority for which Executors exist, what controlled work they may deliver, how they are discovered and invoked, and whether their installation has been verified. Persisted `agent_classes`, hard-coded built-in catalogs and Runtime branches keyed by names previously allowed those facts to drift. They also made third-party registration and safe session recovery impossible without adding another routing source.

## Decision

A `Routing Capability` is a supported routing contract used to optimize AgentClass choice; it is not an exhaustive inventory of an Executor's tools, permissions or theoretical abilities. An Executor may retain overlapping native tools without advertising the corresponding capability as a primary routing contract. `primaryUseCases` and `avoidUseCases` guide preference rather than physically enabling or disabling tools.

`$ANYFUSION_CONFIG_HOME/executors.yaml` is the sole static source for controlled capability definitions, discovery profiles, Executor descriptions, enablement and installation bindings. Its top level is exactly `schemaVersion`, `capabilities`, `profiles` and `executors`.

Each Capability has a stable ID, delivery contract, required affordances, recovery-safety level and minimum permission profile. Each Profile has discovery commands, one driver, default description and suggested capabilities. Each Executor has a stable ID, non-empty description, at least one controlled Capability, at least one primary use case, enablement and an installation binding. Strengths, weaknesses, risk, domains, input/output types, avoid-use cases and affinity are optional routing metadata.

An installation binding declares an absolute binary path, version probe, driver, absolute private runtime home, environment-file references, inherited environment variable names and confirmed effective permission profile. Configuration never stores credential values. Runtime launches that binding as a child process in the assigned worktree. The generic `cli-session` driver additionally declares initial arguments, resume arguments, session-ID extraction, optional final-output extraction, timeout and termination signal. Codex, Pi and Hermes use dedicated drivers; unknown CLIs may use `cli-session`.

Loading produces one immutable `ExecutorRegistrySnapshot` identified by a SHA-256 `configDigest`. It exposes four controlled projections:

- TUI: registration, configuration, verification, error and disabled state without credentials.
- Planner: controlled capability contracts and routing descriptions for only enabled, verified, digest-matched Executors.
- Kernel: candidate IDs, capability coverage, snapshot digest and health facts without process implementation.
- Runtime: driver, absolute binary path, private home, environment sources, permissions, backend binding and session contract.

All four projections are created from the same loaded version and Executor set. A failed reload retains the prior valid snapshot. Manual YAML changes take effect only after explicit reload or restart. Any configuration digest change makes existing verification stale.

The live Session/Application Shell owns the active loaded snapshot. The
separate Planner MCP process reads the current Planner-safe projection through
the existing read-only Planner Host Protocol instead of creating its own
long-lived Registry loader. Kernel and Runtime consume projections from the
same Session-owned snapshot. Every production execution entry requires the
verified Runtime binding; AgentClass names and process environment are not
fallback binding sources.

Registration, discovery and verification are one application service shared by CLI, slash commands and AnyFusion-Pi. Known profiles discover Codex, Pi and Hermes paths and versions but require user confirmation. Verification runs in a temporary Git workspace and isolated runtime home, checks version and output bounds, sends a random first challenge, extracts the session ID, resumes the same session with a second challenge, and validates cwd/home isolation, timeout, termination and normalized failure. Only a successful verification may atomically replace YAML, store the `executor_id + config_digest` verification fact, enable the Executor and refresh the snapshot.

Planner schema represents Capability and Executor IDs as format-constrained strings. Semantic validation against the current Planner projection rejects invented names, unknown capabilities, disabled, unverified, stale or capability-incomplete Executors. For each Subtask, Planner produces one ordered Preferred AgentClass List from that projection. Kernel independently rechecks the same snapshot digest, membership, coverage and health before execution. `ControlKernel` remains the sole authority for retry, fallback and recovery.

Runtime dispatches through the registry-selected driver contract rather than branching on Executor names. A driver declares backend support, session-resume support, evidence affordance, result collector and private-home materializer. Attempt identity and result-file identity remain separate contracts. ADR-0021 and ADR-0023 continue to govern Work Graph and durable workflow semantics.

## Consequences

- Static capability facts, installation bindings and enablement cannot drift across TUI, Planner, Kernel and Runtime.
- No `agent_classes` table or hard-coded built-in catalog is an Executor definition authority.
- `unverified` and stale Executors are visible administratively but cannot be routed.
- Codex, Pi, Hermes and validated generic CLI Executors share the same registration and invocation source.
- `list_executor_status` remains authoritative for dynamic class health, not for static capability definitions.
- The current Work Graph contract uses controlled requirements and ordered `preferredAgentClassList` values validated against the current snapshot.
- A malformed manual edit cannot replace the last valid runtime snapshot.
