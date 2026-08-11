---
status: in_progress
plan_date: 2026-08-10
---

# Ubuntu Runtime And Executor Registry Convergence

## Goal

将 `origin/remote-test` 的统一 Executor Registry、Linux 原生启动、Project
worktree 与批准发布能力合入当前主线，同时把本机唯一 Runtime/Test 镜像从
Debian Bookworm 完整迁移到 Ubuntu 24.04 LTS，删除 per-attempt Docker
兼容执行路径。

完成后只维护一种生产运行模型：AnyFusion Runtime、AnyFusion-Pi Planner、
Codex Executor 和 Pi Executor 都运行在 Ubuntu 24.04 用户空间中，Executor
attempt 只使用 Runtime 子进程和受管 Git worktree。本机 Windows 只负责
Docker 编排；长期运行的 Ubuntu 容器应尽可能复现真实 Ubuntu 服务器，真实
服务器继续作为最终部署 smoke 环境。

## Demo Delivery Principle

本阶段目标是尽快交付一个流程简单、运行稳定、可以重复演示的 Demo。设计优先级
依次是：核心功能正确、两套环境行为一致、实现容易理解和排错。暂不建设生产级
多租户隔离、完整崩溃恢复、跨版本数据迁移、供应链证明或多 Runtime 并发启动
能力；这些需求只有在 Demo 验证后再单独规划。

## Confirmed Deployment Baseline

以下参数来自当前真实服务器，实施时作为容器版本和验收基线：

| Component | Required baseline |
| --- | --- |
| Distribution | Ubuntu 24.04 LTS (Noble Numbat) |
| Architecture | `x86_64` / Docker `linux/amd64` |
| glibc | `2.39` (`2.39-0ubuntu8.4` on the observed server) |
| Node.js | `v22.19.0` |
| npm | `10.9.3` |
| Git | `2.43.0` |
| Codex | `codex-cli 0.146.0` |
| Pi | `0.81.1` |
| Runtime user | `root` (`uid=0`, `gid=0`) |
| Runtime home | `/root` |
| Server commands | `/usr/bin/node`, `/usr/bin/codex`, `/usr/bin/pi` |

The Runtime image must install and verify the exact Node, npm, Codex and Pi
versions above. Package updates must be intentional; floating `latest` versions
are not allowed. The Ubuntu base image should also be digest-pinned after the
first successful build so local and published images use the same rootfs.

## Product Decisions

1. Ubuntu 24.04 replaces Debian Bookworm completely. Do not retain Debian as a
   supported Runtime, test image, fallback stage, or CI matrix entry.
2. Keep one Runtime image and one long-running SSH development container. Do
   not introduce a second Ubuntu image alongside the current Debian image.
3. Windows is an orchestration host only. AnyFusion application processes,
   Planner and Executors do not run directly on Windows.
4. The only production Executor backend is the native process/worktree path.
   Per-attempt Docker containers, attempt images, Docker socket dispatch and
   their compatibility switches are removed rather than deprecated.
5. `$ANYFUSION_CONFIG_HOME/executors.yaml` remains the sole environment-local
   source of real Executor installation facts. Planner, Kernel and Runtime must
   consume projections from the same current immutable snapshot and digest.
6. One environment has one registration binding for an Executor ID. Do not add
   multi-environment or multi-path bindings to one Registry file. Ubuntu server
   and Docker generate their own `executors.yaml` using the same schema and
   registration flow.
7. The container registers the actual `/usr/local/bin/codex` and
   `/usr/local/bin/pi` commands. The server registers its actual `/usr/bin/codex`
   and `/usr/bin/pi` commands. No checked-in config may pretend these paths are
   identical.
8. Runtime initialization, configuration rendering, Registry preparation and
   version checks are shared. Thin packaging wrappers may differ: the native
   launcher starts repository build outputs, while the container entrypoint
   starts image build outputs and configures SSH.
9. Credentials remain bind-mounted or injected below `/run/metaclaw/env` and
   never enter the image, Registry, persistent volume or repository.
10. The Demo treats Runtime, Planner and registered Executors as one trusted
    operating-system user. Read-only credential injection prevents accidental
    persistence but does not claim isolation between Executors. Per-Executor
    users and credential isolation are deferred.

## Ownership And Dependency Boundaries

- `src/executor/` owns Registry schema validation, atomic loading, digesting,
  immutable snapshots, discovery, registration, verification and runtime
  bindings.
- Planning consumes only a Planner-safe projection supplied through a current
  snapshot provider. It must not construct and indefinitely cache an unrelated
  `ExecutorRegistryService` instance.
- Kernel consumes only digest-bound availability, health and capability facts.
  It neither reads YAML nor discovers binaries.
- Execution consumes a required verified runtime binding from the authorized
  snapshot. It must not infer command, home, protocol or environment from an
  AgentClass name or environment-variable fallback.
- Session/Application Shell coordinates Registry reload and projects the same
  resulting snapshot to Planner, Kernel and Runtime.
- `docker/` and launcher scripts own deployment packaging and environment
  preparation only. They do not define Executor semantics.
- Storage may retain verification and audit facts keyed by Registry digest, but
  it is not an alternate Executor-definition source.

Allowed direction:

```text
executors.yaml
    -> ExecutorRegistryService/current snapshot provider
        -> Planner-safe projection
        -> Kernel snapshot facts
        -> verified Runtime binding
```

Forbidden paths:

- Planner, Kernel and Runtime loading separate long-lived snapshots;
- Runtime deriving a binary or home from Executor ID, AgentClass name or
  process environment after authorization;
- Storage rows or built-in catalogs acting as a second Executor definition;
- Docker backend selection changing Executor semantics;
- container-specific paths leaking into the server Registry, or vice versa.

## Persistent Container Layout

Continue using the existing named `/data` and `/workspace` volumes, but move
all mutable Runtime and agent state out of `/var/lib` and `/root` paths that are
lost when the container is recreated.

```text
/data/anyfusion/
  config/
    executors.yaml
    planner/
    codex/
    pi-home/
  runtime/
    config.yaml
    planner-sessions/
    database and durable audit state

/workspace/
  default/                    persistent default Project repository

/run/metaclaw/env/            ephemeral provider env files; never persisted
```

Container defaults:

```text
ANYFUSION_CONFIG_HOME=/data/anyfusion/config
METACLAW_HOME=/data/anyfusion/runtime
ANYFUSION_PLANNER_HOME=/data/anyfusion/config/planner
METACLAW_PLANNER_HOME=/data/anyfusion/config/planner
METACLAW_EXECUTOR_CODEX_HOME=/data/anyfusion/config/codex
METACLAW_EXECUTOR_PI_HOME=/data/anyfusion/config/pi-home
METACLAW_PLANNER_SESSION_DIR=/data/anyfusion/runtime/planner-sessions
```

The Docker launcher must pass the persistent Project explicitly as
`--project /workspace/default`. Recreating the container must preserve the
Registry, verification facts, Planner sessions, agent homes, database and
Project repository without preserving the old container filesystem.

## Delivery Plan

### Implementation Progress

- **Stage 0 completed 2026-08-10:** created
  `codex/ubuntu-registry-convergence`, fetched and merged
  `origin/remote-test@476f87fcd0ca9e90641070d1d3bd19ca4c2e3591` with explicit
  merge commit `c29bde1`, and established the pre-Ubuntu Debian container
  baseline. Container lint/build passed; the initial eight focused test files
  passed 60 tests.
- **Stage 1 completed 2026-08-10:** Planner MCP now reads the live
  Session-owned Registry projection through Planner Host Protocol v2. Runtime
  snapshot input and Adapter Runtime binding are mandatory; legacy name/env
  inference and the private AgentClass Registry loader were deleted. Container
  lint/build passed; two focused runs passed 85 test executions.
- **Stage 2 completed 2026-08-10:** the Runtime, Planner builder, application
  builder and test image now share a pinned Ubuntu 24.04 amd64 base and a
  checksum-verified Node 22.19.0 installation. npm 10.9.3, Codex 0.146.0, Pi
  0.81.1, glibc 2.39 and `tini` were verified in the final Runtime image;
  `better-sqlite3` loads from `/app` in that same final layer. The Windows
  Docker build uses an HTTP-only CA bootstrap followed by Ubuntu HTTPS package
  sources and normalizes the no-extension `anyfusion` launcher to LF. The test
  image passed lint, build and the full suite: 773 passed, 15 skipped, 0
  failed. The locally built Runtime manifest-list digest is
  `sha256:b44943bf8f4dd9ee50396916587037e18649036e7ea3951222d6e8c0439dd734`.
- **Stage 3 completed 2026-08-10:** deleted the selectable Docker attempt
  backend, attempt images/entrypoints, Docker socket dispatch, image-derived
  Registry fields and their dedicated tests/publish jobs. Every attempt now
  uses one registered CLI child process in its managed worktree. Schema v34
  persists only a backend-neutral runtime handle and child PID; cancellation,
  normal Session shutdown and startup reconciliation perform best-effort
  process termination. Focused lifecycle tests and the complete Ubuntu suite
  pass.
- **Stage 4 completed 2026-08-10:** added `scripts/runtime-bootstrap.sh` and
  made both the native `anyfusion` launcher and Runtime image entrypoint use
  it for validation, directory creation, provider config rendering, command
  discovery and Registry preparation. Native defaults now use
  `~/.local/share/anyfusion/runtime` plus `~/.config/anyfusion`; the container
  uses `/data/anyfusion/runtime` plus `/data/anyfusion/config`, with persistent
  Project `/workspace/default`. A named data volume was started twice and
  retained the same `executors.yaml` checksum. The Stage 4 Runtime manifest
  digest is
  `sha256:8d600e9259b0ad6a9bf18d4dcc16a860e47a4734743830408cf227fd78b78c56`.
- **Stage 5 completed 2026-08-10:** the Ubuntu test image passes the complete
  suite (191 files passed, 3 skipped; 774 tests passed, 13 skipped, 0 failed).
  The Runtime image reports Ubuntu 24.04/x86_64, Node 22.19.0, npm 10.9.3,
  Codex 0.146.0 and Pi 0.81.1; it contains no Docker CLI and loads
  `better-sqlite3` from `/app`. The long-running development container was
  rebuilt on the Stage 4 image, then Codex and Pi were registered through the
  production CLI and reported `enabled / verified`. Recreating that container
  against the same named volumes preserved both verification state and the
  exact Registry checksum
  `72d679c40e7ec2fd1e3221b6f1a43a5f698095f89cfa701e89c70e6ebc167321`.
  The real Codex artifact smoke passed as
  `smoke_1786362417360_85e1ab07-51c0-496f-a2a0-a2accfd3d1f6`; the real Pi
  research smoke passed as
  `smoke_1786362897495_8e2e087d-f452-48be-8beb-dd818eeae4a8`. Both used
  `/workspace/default` and the normal approval/publication path. The smoke run
  also exposed and closed two migration leftovers: AnyFusion Planner now
  accepts managed Project directories below `/workspace`, and the smoke helper
  no longer overwrites a registered Pi home or expects the retired `pi-agent`
  ID. The paired Planner fix is recorded in AnyFusion-Pi commit `63d42d8f`.
  Final cleanup removed the obsolete `anyfusion.sh -> metaclaw.sh` startup
  chain and its separate PID/log/systemd behavior; `anyfusion` and the shared
  bootstrap are now the only native entry path, while Gateway runs in the
  foreground through `anyfusion gateway run`. The final local Registry digest is
  `6ea4f8fdb62a16a007a5b9370d62606fc7c466860e18b1d3a92542e1912e2d8d`;
  the final local Runtime image ID is
  `sha256:452ee29dc7f9c1732555e3fd81cd59ff197d74b069929230d3db7b5e189a7a26`.
  Stage 6 on the real Ubuntu server remains to be completed.
- **Completion contract follow-up completed 2026-08-11:** Completion Protocol
  v4 removes the Planner-authored `edit | report` distinction and workspace
  change restrictions. Every Executor now returns a required result description
  plus optional existing workspace-relative result-file paths. Schema v35 drops
  the obsolete Subtask delivery-kind column, and the local Docker data volume is
  scoped to v35. Host lint, the 68-test focused Ubuntu run and the complete
  Ubuntu suite passed; the full result was 191 files passed, 3 skipped, with
  771 tests passed and 13 skipped.
- **Container registration follow-up completed 2026-08-11:** Runtime container
  bootstrap now uses the shared registration service to idempotently register,
  verify, enable and reload missing canonical `codex` and `pi` Executors. An
  existing definition is skipped, so ordinary restart and rebuild do not repeat
  model verification. The Windows launcher waits for bootstrap and SSH readiness
  before reporting success. Native server startup does not alter its Registry.

### Stage 0 — Integration safety and branch inventory

1. Fetch and record the exact `origin/remote-test` head before integration.
2. Start from a clean integration branch based on the current branch; preserve
   unrelated local work.
3. Review the full branch range, not only the Registry commit. The branch also
   contains Linux launcher, schema 32/33, Project workspaces, publication,
   smoke and documentation changes that form one dependency chain.
4. Merge `origin/remote-test` with an explicit merge commit so branch provenance
   remains visible. Do not squash or cherry-pick only the Registry files.
5. Resolve documentation and schema conflicts using current code/tests,
   accepted ADRs and the remote branch's newer schema 33 contract as authority.
6. Before replacing the image, run `git diff --check`, TypeScript lint, build
   and focused branch tests in the existing Linux test container. Windows host
   results are advisory only. This establishes whether a failure came from the
   merge or a later convergence stage.

Exit gate: the merged worktree builds and the focused Registry, Planner,
Kernel, Runtime, Project and publication tests pass without Ubuntu migration
changes mixed into their diagnosis.

### Stage 1 — Close Registry single-source merge blockers

1. Make Session/Application Shell own the current loaded Registry snapshot.
   Planner MCP must read the current Planner-safe projection through the
   existing Planner host bridge instead of constructing its own long-lived
   `ExecutorRegistryService` or re-reading YAML on every query. Kernel and
   Runtime must use projections from that same loaded snapshot and digest.
2. Add one long-lived native TUI/RPC test proving an explicit Registry reload
   becomes visible to Planner, Kernel and Runtime with the same digest without
   restarting the Planner process. Existing focused Registry tests continue to
   cover register, enable, disable and verification behavior.
3. Make the verified snapshot/runtime binding mandatory at every production
   execution entry.
4. Delete `legacyRuntimeBinding()` and old adapter constructor paths that infer
   command, home, driver or environment from AgentClass names or environment
   variables.
5. Move legacy tests to explicit test Registry snapshots. Test helpers may
   construct fixtures, but production interfaces must not expose a test-only or
   optional snapshot path.
6. Confirm stale, disabled, unknown, unverified and digest-mismatched Executors
   fail before process launch with stable diagnostics.

Exit gate: one Registry mutation is observed consistently by all three
consumers, and no production execution path can bypass Registry verification.

### Stage 2 — Replace the Debian image with Ubuntu 24.04

1. Introduce one common Ubuntu 24.04 base stage used by Planner builder,
   AnyFusion builder and final Runtime. Do not build native dependencies on
   Debian and copy them into Ubuntu.
2. Install Node `22.19.0` from a pinned, checksum-verified distribution and pin
   npm `10.9.3`. Do not rely on Ubuntu's unpinned default Node package.
3. Install the required Ubuntu packages non-interactively: Bash, CA
   certificates, curl, Git, OpenSSH client/server, Python 3, ripgrep and
   `fd-find`, plus native build tooling required by `better-sqlite3` when no
   matching prebuild is available.
4. Preserve the `fdfind` to `fd` command compatibility link.
5. Install and verify Codex `0.146.0` and Pi `0.81.1` in
   `/usr/local/bin`; assert their versions during image build.
6. Configure SSH through an explicit Ubuntu drop-in instead of assuming edits
   to `/etc/ssh/sshd_config` cannot be overridden.
7. Use `tini` as the final Runtime container's PID 1 so stopped Executor child
   processes are reaped reliably.
8. Migrate `Dockerfile.test` to the same Ubuntu 24.04/Node 22.19 baseline.
9. Remove Debian mirror configuration, Bookworm tags and Debian-only comments
   from the Runtime/test images and current operational documentation. Do not
   migrate the per-attempt images scheduled for deletion in Stage 3; their
   remaining Bookworm references disappear with that compatibility path.
10. Build and publish only `linux/amd64` until another production architecture
   is explicitly approved and tested.

Exit gate: builders and runtime report Ubuntu Noble, glibc 2.39, Node 22.19.0,
npm 10.9.3, Codex 0.146.0 and Pi 0.81.1; `better-sqlite3` loads in the final
image rather than only in a builder.

### Stage 3 — Remove per-attempt Docker compatibility completely

1. Remove `DockerCliAttemptSandboxAdapter`, backend selection through
   `METACLAW_EXECUTOR_BACKEND`, Docker host-path mapping and Docker socket
   requirements from production composition.
2. Delete Codex/Pi attempt Dockerfiles and entrypoints, attempt-image build and
   publish jobs, and integration tests whose only purpose is the deleted
   backend.
3. Remove the Docker CLI binary from the Runtime image. Retain Docker only on
   the Windows host as the mechanism for running the single Ubuntu Runtime
   container.
4. Remove Docker-attempt image fields and validation from Executor Registry
   definitions. The runtime binding contains only the native CLI/session driver
   facts required by worktree execution.
5. Simplify the attempt process lifecycle interface to the one worktree-backed
   implementation. Rename persisted or public `containerId` terminology to a
   backend-neutral runtime handle where the fact remains necessary.
6. Add only the process cleanup needed by the Demo: record the child PID,
   terminate it on cancellation and normal Runtime shutdown, and on startup
   mark interrupted attempts failed and make a best-effort termination of the
   recorded PID. Do not add process fingerprinting or a general-purpose process
   supervisor in this phase.
7. Because the product is unreleased and persistence is fresh-only, introduce
   the next schema version if persisted Docker-only columns or image fields are
   removed; reject older schemas rather than adding dual-read compatibility.
   Before first startup with that schema, stop Runtime and copy the current
   `/data/anyfusion` tree to one timestamped backup.
8. Remove Docker compatibility language from `CONTEXT.md`, ADR-0024/0025,
   current technical/security documentation, README files and examples. Keep
   archived plans unchanged as historical records.
9. Preserve the standby Ink TUI and unrelated Dockerized Runtime/SSH support.
   Removing attempt containers does not authorize removing the Runtime
   container or the standby UI.

Exit gate: searching active code and docs finds no selectable Docker Executor
backend, attempt image, Docker socket dispatch or Docker-derived Registry
binding. Every real attempt uses the registered CLI as a Runtime child process
in its assigned Git worktree. Cancellation, clean Runtime shutdown and one
Runtime restart test leave no known Executor process running.

### Stage 4 — Share runtime bootstrap and converge paths

1. Extract one shell bootstrap for the final native-worktree runtime model. It
   validates the environment, creates persistent directories, renders config,
   discovers commands and prepares the Registry; it does not retain selectors
   for the deleted Docker attempt backend.
2. Make both the repository-root `anyfusion` launcher and Docker entrypoint call
   that bootstrap. Keep source build orchestration in the native wrapper and
   SSH supervision in the container wrapper.
3. Remove duplicated defaults that currently disagree between
   `~/.config/anyfusion`, `~/.local/share/anyfusion`, `/var/lib/metaclaw` and
   `/data/metaclaw`.
4. Keep the same trusted root user and `/root` HOME in the Demo container as the
   observed server, while redirecting intended durable state through the
   explicit `/data/anyfusion` variables above. Do not claim per-Executor
   credential isolation in current security documentation.
5. Register and verify `/usr/local/bin/codex` and `/usr/local/bin/pi` inside the
   container using the normal Executor CLI. Do not ship a pre-generated
   environment-specific `executors.yaml` in the image.
6. Prove that container recreation does not require re-registration unless a
   binary version/path or Registry definition intentionally changes.

Exit gate: native server and container execute the same bootstrap contracts;
their only remaining differences are packaging, volume paths, credentials and
service/SSH supervision.

### Stage 5 — Local Ubuntu container validation

Run validation from Windows through the long-running Ubuntu container, not
through native Windows Node.js:

1. Build the unified Runtime image from both repository BuildKit contexts.
2. Recreate the named development container with `/data` and `/workspace`
   volumes and the three provider env files.
3. Assert OS, architecture, glibc and all pinned tool versions.
4. Run `npm run lint`, `npm run build` and the complete Vitest suite in Ubuntu.
5. Run focused Registry lifecycle tests, Planner MCP long-lifetime reload tests,
   Kernel digest rejection tests, Runtime binding tests, Project worktree tests,
   publication tests and the minimal process cleanup/restart test.
6. Run `executor discover`, register Codex and Pi, verify both, then confirm
   Planner-safe list, Kernel facts and Runtime bindings carry the same digest.
7. Run the real artifact smoke through Codex and the real research smoke through
   Pi using the persistent Project.
8. Approve publication through the real Session path and verify the result is
   merged to Project `main` with no leaked task worktree.
9. Recreate the container and repeat Registry listing plus one real smoke to
   prove durable state survives container replacement.
10. Verify no attempt starts a nested container and no Docker socket is mounted
    into the Runtime container.

Exit gate: all local tests and both real smokes pass inside Ubuntu 24.04, and a
container recreation preserves the intended state.

### Stage 6 — Real Ubuntu server acceptance

1. Build both repositories with the shared native launcher on the existing
   Ubuntu 24.04 server.
2. Validate the recorded server baseline and fail clearly if a pinned tool has
   drifted.
3. Load the server-local Registry containing `/usr/bin/codex` and `/usr/bin/pi`;
   verify both against the current Registry digest.
4. Run the same focused Registry/Planner/Kernel/Runtime acceptance checks used
   in Docker.
5. Run real Codex artifact and Pi research smokes against an isolated Project.
6. Confirm approved publication, durable audit records, smoke Task purge and no
   orphan process/worktree residue.
7. Record run IDs, Registry digest, tool versions and the closing commit in this
   document before marking it complete.

Exit gate: the same application commit and Registry schema pass on both the
local Ubuntu container and the real Ubuntu server. Only then may Ubuntu be
declared the sole supported Runtime environment.

## Validation Matrix

| Evidence | Windows host | Ubuntu container | Ubuntu server |
| --- | --- | --- | --- |
| Docker build/orchestration | required | n/a | n/a |
| TypeScript lint/build | not authoritative | required | required |
| Full Vitest suite | do not use for SQLite/POSIX acceptance | required | optional final confirmation |
| Registry reload/digest tests | no | required | required |
| `better-sqlite3` load | no | required | required |
| Codex real artifact smoke | no | required | required |
| Pi real research smoke | no | required | required |
| Container recreation persistence | orchestrated | required | n/a |
| Native launcher acceptance | no | bootstrap contract only | required |

## Documentation And ADR Updates

Implementation changes the accepted runtime boundary and therefore must update:

- `CONTEXT.md` — native worktree execution becomes the sole active path;
- ADR-0017/0018 — Registry snapshot ownership and single-binding authority;
- ADR-0020 — shared Registry provider and dependency direction if its public
  interface changes;
- ADR-0024/0025 — remove Docker attempt compatibility and container-specific
  execution claims;
- `docs/current/phase-5-runtime-security.md` — replace Docker-attempt security
  material with the Demo's trusted native process/worktree model, without
  claiming isolation between Executors;
- current technical overviews, README files and `AGENTS.md` — Ubuntu-only
  runtime and validation workflow;
- image publishing workflow — publish only the Ubuntu Runtime image.

Archived plans and ADR history remain unchanged unless an active authority
contains a direct link that needs to be redirected.

## Risks And Controls

- **Native module ABI mismatch:** build and run `better-sqlite3` on the same
  Ubuntu base and verify loading in the final image.
- **Registry snapshot drift:** use one current snapshot provider and cover
  long-lived Planner reload behavior.
- **Hidden legacy dispatch:** make runtime binding mandatory and search for
  name/env/image inference before acceptance.
- **Lost container configuration:** move all mutable homes and Registry data to
  `/data` before recreating the existing container.
- **Executor process left running:** record its PID, terminate it during normal
  cancellation/shutdown and perform best-effort cleanup during Runtime startup.
- **Remote branch scope surprises:** merge and validate `remote-test` before
  layering platform changes, retaining its full commit provenance.
- **Ubuntu package drift:** pin the base digest and application-facing tool
  versions; assert them in builds and smokes.
- **False local confidence:** Windows-host checks are orchestration checks only;
  Ubuntu container and real server smokes are mandatory release evidence.

## Rollback Boundary

Before a schema or Registry hard cut, stop Runtime and make one timestamped copy
of `/data/anyfusion`. Rollback means restoring the previous application image or
commit together with that matching data backup; an old image must not open the
new-schema database. Do not write a Debian fallback, schema migrator or dual-read
compatibility path for the unreleased format.

## Completion Record

Fill this section only after every exit gate passes:

- Completion date:
- Closing commit:
- Merged `origin/remote-test` head:
- Ubuntu Runtime image digest:
- Registry digest used by local Docker smoke:
- Registry digest used by Ubuntu server smoke:
- Codex artifact smoke run IDs:
- Pi research smoke run IDs:
- Full-suite result:
- Deleted compatibility files and interfaces:
