# ADR-0017: Kernel Executor Status Projection

- Status: Accepted; module ownership clarified by ADR-0020 and recovery policy amended by ADR-0023
- Date: 2026-07-16
- Scope: registry-projected Planner catalog and Kernel-owned dynamic executor-status projection

## Context

Executor facts currently reach the Planner through `list_executor_classes`. That MCP query combines stable AgentClass metadata with WorkUnit-state counts and implementation details. It makes the Planner fetch static routing facts at runtime and gives it a view of capacity that does not match the intended executor model: selecting an AgentClass starts an independent instance, so an already-running WorkUnit does not make the class busy or unavailable.

The Planner needs two different inputs from one registry version:

1. a stable description of the enabled, verified Executor definitions and their routing differences; and
2. a current, bounded indication of each class's health and recent outcomes.

The second input is also a control-plane concern. The future Kernel expansion recorded in `kernel-decision-authority-scattered-in-runtime-debt.md` will own scheduling and recovery decisions, but that work is not part of this ADR. This decision establishes the durable status vocabulary and projection boundary it can later consume.

## Decision

### Inject the registry-derived executor catalog into Planner context

The Planner receives a stable, Planner-safe catalog from the current immutable `ExecutorRegistrySnapshot` when each planning run starts. It contains only enabled Executors whose verification succeeds for the snapshot's exact `configDigest`, along with routing differences and key affordances. It does not contain live health, WorkUnit state, capacity, runtime commands, binary paths, runtime homes, environment sources, credentials, raw logs, or tool transcripts.

The Planner does not query MCP for this catalog. ADR-0018 is the authority for `$ANYFUSION_CONFIG_HOME/executors.yaml`, digest-bound snapshot loading, verification gating and the Planner projection.

### Persist a Kernel Executor Status Projection

The system keeps one persisted `Kernel Executor Status Projection` row per AgentClass. It is a current control-plane projection derived synchronously from confirmed Runtime work-unit facts and execution outcomes. It is not an execution log, a WorkUnit, or a capacity pool.

Each row exposes the following Planner-safe data:

- `agentClassName`;
- `classHealth`: `unverified`, `healthy`, `error`, or `disabled`;
- up to the three most recent execution attempts, each with completion time, success/failure outcome, classified failure kind, and safe reason text.
- a bounded recent recovery-check history with trigger, completion time, result, and redacted structured failure.

No prompt, model output, tool trace, raw process output, credential, or runtime command is exposed through this projection.

`classHealth` means:

| State | Meaning | Planner candidate behavior |
| --- | --- | --- |
| `unverified` | The Executor has no successful installation verification for the current registry digest. | Must not be selected. |
| `healthy` | Verification matches the current digest and no confirmed Executor-level fault prevents a new instance from starting. | May be selected. |
| `error` | A confirmed AgentClass-level fault prevents normal use, such as invalid adapter binding, missing required command, or incompatible class configuration. | Excluded by default. |
| `disabled` | The class was explicitly disabled by administration or policy, not by a runtime incident. | Must not be selected. |

A busy, running, waiting, or failed WorkUnit is an instance fact and never becomes an AgentClass health state. A single network or timeout failure is recorded in recent attempts but does not make the AgentClass unhealthy. The later Kernel control-plane work owns transition rules for systemic failure, recovery, retry caps, circuits, and re-enable behavior.

### Error recovery amendment (2026-07-30)

`error` is a re-verifiable observation, not an administrative lock. Event-driven recovery refresh checks only registry-enabled Executors with a current digest-matched verification whose dynamic health is already `error`; it never turns an unverified or stale configuration into a routable candidate. A successful structured probe performs the sole automatic transition `error → healthy`. A failed or timed-out probe keeps the class in `error` and updates only its bounded recovery-check evidence. `disabled` is the only management-locked state and is never automatically recovered.

Recovery checks validate the local deployment chain required to start an attempt, including the registry-selected absolute binary, driver, private home materialization, environment sources, immutable image resolution when Docker is enabled, control-network existence/properties, and provider configuration. Authentication or provider-network failures may trigger the adapter's minimal remote validation. Concurrent checks for the same Executor share one in-flight operation. There is no periodic poller.

### Keep control-plane semantics pure and persistence in Runtime adapters

The projection vocabulary is an Executor Registry control-plane contract. Control Kernel owns the pure rules that interpret health, systemic failure, recovery and future circuit state. Runtime records confirmed execution facts, applies the pure transition result and synchronously updates the persisted projection through a persistence adapter. Planner and Control Kernel read the resulting bounded projection alongside the same snapshot digest.

This preserves the original control-plane ownership intent without making the pure Kernel module depend on a Repository. The current Repo-backed `KernelExecutorStatusProjector` is a migration-period application service; its physical name/location is not a public Kernel seam and must converge under ADR-0020 when the area is next refactored.

### Expose only dynamic status through Planner MCP

Planner MCP replaces the mixed `list_executor_classes` capability query with a dynamic status query. It returns the bounded projection rows above. Static catalog facts remain startup context, while the dynamic query helps Planner order its single v3 `preferredAgentClassList`.

The Planner emits one ordered `preferredAgentClassList` per Subtask containing the complete eligible Executor set from its current snapshot projection. Its first item is preferred. Kernel validates snapshot membership, digest consistency, capability coverage and dynamic health, and rejects unknown, disabled, unverified, stale or capability-incomplete candidates. Runtime follows only the Kernel-approved order; `ControlKernel` remains the sole authority for cross-Executor retry and fallback after execution failure. A Runtime outcome updates the projection for subsequent decisions but does not retroactively mutate an already-authorized graph.

## Consequences

- Planner has a small digest-bound capability context and a separate, current health query.
- `busy` and raw capacity are not routing signals for AgentClasses that start independent instances.
- A transient instance failure remains visible to Planner without falsely declaring its AgentClass unusable.
- The Kernel gains a durable control-plane state boundary that future scheduling/recovery work can extend without redefining Planner-facing vocabulary.
- Registry configuration and Runtime bindings remain excluded from dynamic MCP discovery, while the bounded status projection is available through a dedicated read-only Planner MCP query. ADR-0018 owns the snapshot side of this split.

## Deferred

- Periodic health discovery for currently healthy classes;
- circuit breaking and retry-limit changes beyond ADR-0023;
- capacity limits, shared worker pools, and parallel scheduling;
- remote Executor registries and fleet-wide certification.
