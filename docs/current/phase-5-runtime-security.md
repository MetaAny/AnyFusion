# Runtime Security And Executor Registry Operations

## Demo runtime topology

AnyFusion has one execution path. Runtime launches the CLI from the verified
Executor Registry binding as a child process in the Subtask's persistent Git
worktree. Ubuntu server deployment runs Runtime, Planner and Executors directly
on the host. Windows development runs the same Linux process model inside one
Ubuntu Runtime container. Docker packages that Runtime container; it is not an
Executor backend and Runtime does not need the Docker socket or Docker CLI.

Runtime, Planner and Executor child processes are trusted at the same operating
system user boundary. A worktree separates Git state and makes publication and
cleanup predictable, but it is not a security sandbox: an Executor process can
technically access paths available to the Runtime user. The Demo therefore must
run only registered CLIs and must not claim per-Executor filesystem or credential
isolation.

Every attempt receives an attempt-private materialized CLI home. Provider keys
remain in Runtime; the child receives only a random scoped bearer token and the
loopback URL of its short-lived model gateway. Capability and evidence services
also use loopback addresses.

## Executor Registry

`$ANYFUSION_CONFIG_HOME/executors.yaml` is the sole static authority. It stores
absolute binary and source-home paths, environment-file references, inherited
variable names, driver/session contracts and confirmed permission profiles, but
never credential values. Loading creates one immutable `configDigest`-bound
snapshot. A digest change makes previous verification stale; a malformed reload
keeps the previous valid snapshot.

Planner reads the current Session-owned Planner projection through Planner Host
Protocol v2. Kernel and Runtime receive projections from the same loaded snapshot
and digest. They do not construct another Registry or infer a binding from an
AgentClass name or environment variable.

Initial verification creates a temporary Git workspace and independent runtime
home, checks the absolute binary and version pattern, sends a random first
challenge, resumes the same session when the driver supports continuation, and
validates cwd/home handling, output limits, timeout, termination and normalized
failure. Only `enabled + verified + digest matched` Executors are routable.

Dynamic recovery is deliberately small for the Demo. It checks that the current
Registry binding and permission profile exist and that provider URL/key settings
can be loaded. It does not make an extra provider network request; an actual
attempt reports authentication or network failure through the normal execution
result.

## Worktree and process lifecycle

- Runtime starts the registered binary with `cwd` set to the assigned Subtask
  worktree. The Registry driver determines arguments, continuation, result
  collection and private-home materialization.
- One Subtask keeps the same branch and physical worktree across retry, fallback
  and review. Runtime alone publishes the complete branch to local Project
  `main` after approval.
- The attempt record stores a backend-neutral runtime handle and the child PID.
  Cancellation and normal Runtime shutdown terminate the child process group.
  Startup treats an active persisted attempt as interrupted, makes a best-effort
  termination of its recorded PID and reports a normalized lost-attempt fact.
- PID cleanup is intentionally best-effort for the Demo. There is no process
  fingerprint database or general process supervisor.
- Schema 35 is fresh-only. Stop Runtime and copy `/data/anyfusion` to one
  timestamped backup before first startup; older pre-release databases are
  rejected instead of upgraded or read through a compatibility path.
- Workspaces persist under
  `${METACLAW_HOME}/project-worktrees/<project>/workspaces/<task>/<generation>/<subtask>/files`.
  Cancelled or archived workspaces receive the configured cleanup deadline.

## Permission and audit flow

Default operations come from the verified Registry permission profile. An
Executor calls `request_capability` only for a concrete out-of-profile operation.
Runtime canonicalizes and persists the request, pauses the process when supported,
checkpoints the worktree, and submits `permission_requested` to Kernel. Kernel
grants, denies, or escalates; Planner never grants authority directly.

Grants are attempt-bound and budgeted. `use_capability` records and consumes the
grant ID, expiry, call count and byte count for the supplied operation payload.
Repository publication is a separate Runtime-owned action for one exact candidate
commit and Project-main base.

These controls provide routing, audit and predictable Git state. They do not
mediate every native filesystem, network or external side effect. Requests for
Docker/host sockets, devices, policy mutation, credential probing, cross-Task
data or persistent security weakening remain denied by policy, but the shared
Runtime user remains the actual Demo trust boundary.

## Validation

```bash
npm run lint
npm run build
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
npm run smoke:metaclaw
npm run smoke:metaclaw -- --scenario artifact
```

The Ubuntu test image is the authoritative Windows-development test surface.
The artifact smoke verifies Planner → Kernel → registered CLI child process →
scoped model gateway → persistent worktree/artifact → controlled publication
and cleanup. Credentialed smoke must run only after confirming the active
Registry, Project, database and provider configuration are safe.
