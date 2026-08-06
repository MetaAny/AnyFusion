# Worktree Executor Backend Migration

Status: Completed
Plan date: 2026-08-06
Completion date: 2026-08-06

## Decision In Scope

The Runtime may continue to run inside the unified Linux container needed by
non-Linux hosts. Executor attempts must not require sibling Executor images or
the Docker Engine. They run as short-lived child processes inside the Runtime
container, with the existing per-Subtask Git worktree as the isolation and
publication boundary.

The existing Docker attempt backend remains available as an explicit
compatibility backend while the worktree backend is validated. The backend is
selected with `METACLAW_EXECUTOR_BACKEND=worktree` (default) or `docker`.

## Reused Contracts

- `ManagedGitWorkspaceService` continues to create one worktree per Subtask.
- `WorkspaceStore` continues to create checkpoints and content-addressed
  recovery objects.
- `SubtaskAttemptRunner` continues to own attempt claims, permissions,
  workspace deltas, completion validation, candidate commits, and terminal
  receipts.
- `WorkspacePublicationWorker` continues to integrate candidate commits in
  Kernel-authorized order.
- Planner, ControlKernel, Work Graph dependencies, handoffs, and completion
  protocol remain unchanged.

## Delivery Stages

1. Add a worktree process implementation behind `AttemptSandboxPort` and make
   Executor prompt paths backend-aware.
2. Skip image pin and Docker-network probes for worktree attempts while keeping
   them mandatory for the Docker backend.
3. Put Codex and Pi CLIs, their attempt configuration, and the Pi extension in
   the unified Runtime image. Remove the Docker socket and sibling image
   bootstrap from the default worktree launcher.
4. Run the focused Linux Runtime demo and keep existing Docker integration
   tests as explicit compatibility coverage. Durable `container_id` and label
   fields remain unchanged for this minimal rollout.

## Security Boundary

Worktree execution is intentionally less isolated than a container attempt.
The child process runs as the current Runtime user, uses the managed worktree
as its working directory, and receives the attempt-scoped model-gateway token
and capability/evidence bindings already produced by the existing attempt
runner. It does not receive a Docker socket or Docker Engine endpoint. This
minimal backend is limited to the trusted Codex and Pi binaries installed in
the Runtime image.

## Delivered Behavior

- `METACLAW_EXECUTOR_BACKEND=worktree` is the default; `docker` retains the
  existing compatibility backend.
- Canonical Codex and Pi run as Runtime child processes with the managed
  Subtask worktree as `cwd`.
- Attempt-scoped capability, evidence and model-gateway services use loopback
  addresses. Codex and Pi receive temporary per-attempt homes rendered against
  the model gateway, and those homes are removed after execution.
- Worktree Codex uses `danger-full-access` without a nested CLI sandbox. Docker
  compatibility Codex retains `workspace-write` and its existing container
  restrictions.
- The default launcher and artifact smoke do not mount a Docker socket, create
  an internal control network, build Executor images or start sibling Executor
  containers.
- Existing durable attempt fields, cancellation, permission, checkpoint,
  workspace-delta, completion and Git publication contracts remain unchanged.

## Validation

- `npm run lint`
- `npm run build`
- Focused worktree, Executor and smoke tests: 4 files, 24/24 passed.
- Existing Linux attempt/cancellation/permission/publication coverage: 5 files,
  23/23 passed.
- Unified Runtime image built with Node 22.19.0, Codex 0.144.1 and Pi 0.80.2;
  capability wrappers and the Pi attempt extension are present.
- Live `artifact` smoke passed through Planner proposal, Kernel authorization,
  Codex worktree execution, Completion Protocol v3, workspace delta and Git
  publication. The final Docker check showed one Runtime container on `bridge`,
  with no Docker socket or sibling Executor containers.

Closing commit: Pending; the working tree is intentionally left uncommitted for review.
