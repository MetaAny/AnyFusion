# Phase 5 Runtime Security And Executor Registry Operations

## Runtime topology

The default backend runs the driver from a verified Executor Registry binding
as a trusted child process of the Runtime. On the supported Linux server path,
Runtime, Planner and Executors are host processes. The child working directory
is the existing private Subtask Git worktree. Its driver materializes a separate
attempt-private runtime home and exposes only declared environment-file sources
and inherited variable names. Capability, evidence and model-gateway services
use loopback addresses when the binding's driver supports them. This is the
minimal worktree boundary and does not claim a second OS-level sandbox for the
child process.

The compatibility backend runs every attempt in a new Docker container. In that mode, the control plane,
`metaclaw-egress` proxy and attempt containers share the Docker-internal
`metaclaw-control` network. Only the proxy also joins a non-internal outbound
network. Attempt containers never receive the Docker socket, host networking,
host namespaces, devices or privileged mode.

The control plane may run on the host or in a container. Docker attempts must
reach it from `metaclaw-control` as the DNS name configured by
`METACLAW_CONTROL_HOST` (default `metaclaw-control`). Worktree attempts do not
need the Docker Engine endpoint.
Containerized Docker compatibility deployments should use a restricted Docker
socket proxy or a remote Engine endpoint through `DOCKER_HOST`; do not mount
the Engine socket into attempt containers or native Executor processes.

When the control plane sees container-local paths but the Docker Engine resolves host paths, configure `METACLAW_DOCKER_HOST_PATH_MAP` as JSON from container prefix to Engine-host prefix. Runtime rejects unmapped bind sources instead of guessing. Provider API keys stay in the trusted control plane: every attempt receives only a random scoped bearer token and the internal URL of its short-lived model gateway.

Docker compatibility topology:

```bash
docker network create --internal metaclaw-control
docker network create metaclaw-egress-public
docker build -f docker/Dockerfile.egress-proxy -t metaclaw-egress:phase5 .
docker run -d --name metaclaw-egress --network metaclaw-control --restart unless-stopped metaclaw-egress:phase5
docker network connect metaclaw-egress-public metaclaw-egress
```

The Squid policy permits only public HTTP/HTTPS destinations and rejects loopback, link-local, RFC1918, carrier-grade NAT and IPv6 unique-local ranges after DNS resolution. No proxy port is published to the host. `workspace-engineering` and `restricted-custom` attempts do not receive proxy variables and remain on the internal network only.

## Registry-bound Docker compatibility images

Build both immutable attempt images after building the application bundles:

```bash
./scripts/build-attempt-images.sh
```

On PowerShell:

```powershell
.\scripts\build-attempt-images.ps1
```

In Docker compatibility mode, each Executor binding declares both an image
reference and its current immutable `sha256:` image ID. A missing ID, changed
tag or unsupported backend fails closed. Worktree and Docker are explicit
binding capabilities; neither is an implicit fallback for a failed binding.
Codex, Pi and Hermes use dedicated drivers. Unknown CLIs use `cli-session` only
after their complete initial/resume/session-output/timeout/termination contract
passes verification.

`$ANYFUSION_CONFIG_HOME/executors.yaml` is the sole static authority. It stores
absolute binary and source-home paths, environment-file references, inherited
variable names and confirmed permission profiles, but never credential values.
Loading creates one immutable `configDigest`-bound snapshot. A digest change
makes previous verification stale; malformed reload retains the previous valid
snapshot.

Initial installation verification is stronger than the dynamic recovery
`probe()`. It creates a temporary Git workspace and independent runtime home,
checks the absolute binary and version pattern, sends a random first challenge,
extracts the session ID, resumes the same session with a second challenge, and
validates cwd/home isolation, output limits, timeout, termination and normalized
failure. Only `enabled + verified + digest matched` Executors are routable.

For a routable Docker Executor, dynamic recovery verifies the local Engine,
immutable image, `metaclaw-control` network, driver command and configuration in
layers. For a routable worktree Executor, it verifies the selected driver,
private-home materialization, permission profile and provider configuration
without an Engine probe. Authentication/provider-network failures may add the
Adapter's minimal remote validation. A successful recovery check may only move
that checked class from `error` to `healthy`; disabled classes never
auto-recover, and shared infrastructure results are not projected onto
unchecked Executors.

## Mount and persistence contract

- Worktree mode starts the child with `cwd` set to the managed
  `<task>/<generation>/<subtask>` Git worktree and does not mount a second
  workspace. The registry driver, not the Executor ID, selects arguments,
  session continuation, evidence affordance, result collector and private-home
  materializer.
- Docker mode exposes `/workspace` as the only writable bind-mounted tree; `/source`, `/inputs`, `/handoffs` and a Git worktree's `/workspace/.git` are read-only mounts, with a read-only root filesystem, UID/GID 1000, dropped Linux capabilities and `no-new-privileges`.
- A dedicated Codex Docker driver may run its own `workspace-write` sandbox
  with fail-closed non-interactive approval. Any compatibility image exception
  must remain tied to the verified driver/image binding; generic images cannot
  request it.
- Workspaces persist under `${METACLAW_HOME}/workspace-store/workspaces/<task>/<generation>/<subtask>`; only the child process or compatibility container is disposable.
- Checkpoints are immutable manifests. File bodies live in the SHA-256 CAS; SQLite stores URI, hash, size and reference metadata.
- Cancelled or archived Task workspaces receive a seven-day cleanup deadline. CAS objects are removed only after the last checkpoint reference disappears. Files explicitly exported outside the managed workspace/CAS roots are not removed.

Task purge is the only immediate permanent cleanup path. It accepts only
`done`, `archived` or `cancelled` Tasks after dispatch, publication, sandbox,
lease and WorkUnit resources are quiescent. In one transaction it writes a
minimal `task_purge_audits` row, creates a scoped authorization, deletes
Task-scoped graph/execution/publication/search/memory/CAS references, and removes
the authorization. Immutable receipt, handoff and merge-attempt triggers still
block ordinary SQL deletion. A transaction failure rolls back both audit and
deletion; filesystem cleanup runs only after commit.

## Runtime permission and audit flow

Default profile operations do not request permission. An Executor calls `request_capability` only for a concrete out-of-profile operation. Runtime canonicalizes and persists the request, pauses the attempt, checkpoints the now-quiescent workspace, and submits `permission_requested` to the durable Kernel workflow. The Kernel returns grant, deny-to-Executor, or deny-and-escalate-to-Planner. Grants are attempt-bound and budgeted; user authorization is a durable fact from `/permission approve|deny <requestId>`, a gateway action, or a precise Planner interpretation.

The Runtime supplies `permission-profile-v1` rules to both the live attempt and authorization-recovery workflows. Exact Task-registered partitions may receive `additional_read_resource` grants. Only `public-web-research` may receive a `network_target` grant after the target is normalized as credential-free public HTTP(S). Docker compatibility attempts use the egress proxy; worktree demo attempts use the Runtime's normal network namespace. No profile rule permits secrets, external mutation or repository promotion.

A granted response includes a `grantId`, but neither the request nor grant changes sandbox authority. `use_capability` accepts the operation payload, measures its UTF-8 bytes and atomically consumes attempt identity, expiry, call count and byte count. Read/network grants retain the 100-call/100-MiB audit budget; one-shot sensitive and logical requests allow one control payload up to 1 MiB. Budget rejection fails closed.

This initial model is a sandbox profile plus an authorization/audit budget. It does not provide a universal operation broker and does not claim fine-grained enforcement over every native file, network or external operation. A consumed grant proves budgeted authorization was recorded, not that an arbitrary native tool call was mediated. Requests for privileged mode, Docker/host sockets, devices, host namespaces, policy mutation, credential probing, cross-Task data or proxy bypass are always denied by the profile boundary. Future external-mutation or repository-promotion support requires a separately implemented and tested provider adapter/outbox; a grant never exposes raw host credentials or host write access to the attempt container.

## Verification

```bash
npm run lint
npm run build
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
# Run the Docker integration test from a control container with the Engine
# socket and an explicit host-path map.
# The default live smoke verifies two turns in one persisted AnyFusion-Pi Planner session.
npm run smoke:metaclaw
# The explicit artifact gate exercises Planner -> Kernel -> attempt -> publication.
npm run smoke:metaclaw -- --scenario artifact
```

The Docker integration and artifact smoke require the registry-bound attempt
images and a trusted local Docker Engine. Their test bodies run inside a trusted
control-plane container; the host only performs Docker orchestration. The
artifact smoke verifies Planner → Kernel → disposable Executor attempt → scoped
model gateway → persistent workspace/artifact → controlled cleanup. The default
smoke instead verifies native Planner-thread continuity and does not prove the
Executor artifact path. The attempt itself never receives the Engine socket.

Worktree validation requires Linux and verified host CLI bindings. The native
artifact gate uses the current main database, current workspace and current
`executors.yaml`. Every smoke Task is created with `source = system_smoke` and a
unique `smoke_run_id`, so it is hidden from normal Task lists, search and memory
generation. In `finally`, the smoke runner formally cancels any nonterminal
owned Task, waits for resource quiescence, invokes `/task purge`, removes
worktree/artifact/temporary-home residue, checks foreign keys, and records a
bounded smoke audit. Only the latest 20 smoke audits, minimal purge audits,
Executor verification and current health facts remain. Smoke cleanup rejects
arbitrary user Task IDs and requires the exact matching `smoke_run_id`.

Credentialed real smoke must not run until the current host registry, database
and provider configuration are confirmed safe. Docker integration remains
compatibility coverage.

The 2026-08-08 host acceptance completed that safety confirmation for the
current Codex and Pi bindings. It passed a real Codex artifact smoke and a real
Pi public-web research smoke, then formally purged both Tasks with no
Task-scoped database, workspace, artifact, CAS, lease, sandbox or WorkUnit
residue. Hermes remains unregistered and was not part of the acceptance. See
the [schema 32 completion plan](../plans/2026-08-07-unified-executor-registry-and-schema-32.md)
for exact run IDs and close-out evidence.
