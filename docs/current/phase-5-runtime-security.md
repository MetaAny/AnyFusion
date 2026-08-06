# Phase 5 Runtime Security And AgentClass Operations

## Runtime topology

The default backend runs the canonical Codex/Pi CLI as a trusted child process
inside the unified Runtime container. Its working directory is the existing
private Subtask Git worktree; capability, evidence and model-gateway services
use loopback addresses. This is the minimal demo boundary and does not claim a
second OS-level sandbox for the child process.

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

## Canonical Docker compatibility images

Build both immutable attempt images after building the application bundles:

```bash
./scripts/build-attempt-images.sh
```

On PowerShell:

```powershell
.\scripts\build-attempt-images.ps1
```

In Docker compatibility mode, MetaClaw resolves each canonical image tag to a
Docker image ID. Custom AgentClasses must be registered with an image reference,
its current immutable `sha256:` image ID, a valid permission profile, and the
command/arguments inside the image. Worktree mode is restricted to the two
canonical built-ins and does not add a custom registration path. A changed
Docker tag fails closed until the class is explicitly updated.

Example:

```text
/executor register research-bot \
  --image registry.example/research-bot:1.2.3 \
  --image-id sha256:<64-hex-digest> \
  --permission-profile restricted-custom \
  --command research-bot --args "run --prompt {prompt}"
```

Historical custom classes without the Docker image/profile triplet remain visible
for audit but cannot execute. Worktree execution is an explicit trusted backend,
not a host-process fallback for arbitrary custom classes.

Executor availability uses a structured `probe()` rather than a boolean command
check. For Docker classes, the recovery probe verifies the local Engine,
immutable image, `metaclaw-control` network, runtime command, and configuration
in layers. For worktree classes, it verifies the trusted runtime/profile and
provider configuration without an Engine or Docker-network probe.
Authentication/provider-network failures may add the Adapter's minimal remote
validation. A successful recovery check may only move that checked class from
`error` to `healthy`. Healthy/unverified classes are not periodically polled,
disabled classes never auto-recover, and a shared infrastructure result is not
projected onto classes that were not checked.

## Mount and persistence contract

- Worktree mode starts the child with `cwd` set to `/data/metaclaw/workspace-store/workspaces/<task>/<generation>/<subtask>` and does not mount a second workspace. Canonical Codex uses `danger-full-access` in this mode so its tools operate directly in that worktree without a nested CLI sandbox.
- Docker mode exposes `/workspace` as the only writable bind-mounted tree; `/source`, `/inputs`, `/handoffs` and a Git worktree's `/workspace/.git` are read-only mounts, with a read-only root filesystem, UID/GID 1000, dropped Linux capabilities and `no-new-privileges`.
- Canonical Codex Docker attempts also run their own `workspace-write` sandbox with fail-closed non-interactive approval. Only the pinned canonical Codex image receives `seccomp=unconfined` so that nested user namespaces work; every other Docker restriction remains active, and custom images cannot request this exception.
- Workspaces persist under `${METACLAW_HOME}/workspace-store/workspaces/<task>/<generation>/<subtask>`; only the child process or compatibility container is disposable.
- Checkpoints are immutable manifests. File bodies live in the SHA-256 CAS; SQLite stores URI, hash, size and reference metadata.
- Cancelled or archived Task workspaces receive a seven-day cleanup deadline. CAS objects are removed only after the last checkpoint reference disappears. Files explicitly exported outside the managed workspace/CAS roots are not removed.

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

The Docker integration and artifact smoke require the canonical attempt images
and a trusted local Docker Engine. Their test bodies run inside a trusted
control-plane container; the host only performs Docker orchestration. The
artifact smoke verifies Planner → Kernel → disposable Executor attempt → scoped
model gateway → persistent workspace/artifact → container cleanup. The default
smoke instead verifies native Planner-thread continuity and does not prove the
Executor artifact path. The attempt itself never receives the Engine socket.

Worktree validation additionally requires a Linux Runtime image with the trusted
Codex/Pi CLIs installed. The focused gate verifies child-process start, loopback
capability/evidence services, cancellation, checkpoint/delta capture and Git
publication without sibling Executor containers. Docker integration remains
compatibility coverage.
