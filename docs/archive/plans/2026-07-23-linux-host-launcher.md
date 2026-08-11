# Native Linux Server Launcher

**Status:** Complete

**Plan date:** 2026-08-07

**Completion date:** 2026-08-07

## Objective

Make the repository-root `anyfusion` command the canonical startup path on the
current Linux server. Runtime and AnyFusion-Pi run as separate host Node.js
processes, canonical Executors reuse the existing host-installed Codex and Pi
commands, and every attempt uses an isolated Agent home plus a managed Git
worktree. Docker must not be required for local startup or smoke.

## Delivery

1. Validate Node.js 22.19+, npm, Git, Codex, Pi, provider files, and the sibling
   AnyFusion-Pi checkout without installing a second Agent binary.
2. Build both repositories and launch the current checkout from any working
   directory.
3. Render isolated Planner, Codex, and Pi configuration below
   `~/.config/anyfusion`; keep durable Runtime state below
   `~/.local/share/anyfusion`.
4. Launch AnyFusion-Pi through a wrapper pinned to the same absolute host Node
   executable as the Runtime.
5. Set `METACLAW_EXECUTOR_BACKEND=worktree` and retain attempt-scoped temporary
   homes, model gateway credentials, and managed Git publication.
6. Make `anyfusion smoke --scenario artifact` run the native end-to-end path.
7. Restore branch-only Runtime-image edits to `origin/main` while preserving all
   Dockerfiles that already exist on `main`.
8. Remove local images created by the abandoned launcher experiment after the
   native smoke succeeds.

## Validation

- `bash -n anyfusion setup.sh`
- Focused launcher, smoke-helper, and Docker-preservation tests
- `npm run lint`
- `npm run build`
- `anyfusion --check`
- `anyfusion smoke --scenario artifact`
- Verify no Docker process is used by the native smoke
- Verify `docker/Dockerfile.runtime` matches `origin/main`
- Remove abandoned local Runtime images and confirm cleanup

## Completion Record

Delivered the native Linux launcher, host-installed Codex/Pi reuse, isolated
Planner and Executor homes, Runtime-authorized native Planner workspace,
worktree smoke entry, documentation updates, and restoration of the Runtime
Dockerfile to `origin/main`.

Validation:

- Native launcher and Docker-preservation tests: 20 passed.
- Planner process environment tests: 13 passed.
- AnyFusion-Pi native workspace bootstrap tests: 3 passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `anyfusion --check`: passed.
- Native artifact smoke: passed without Docker.
- Removed local `metaclaw-runtime:latest`; retained canonical phase-5
  compatibility images.

Closing commits: this AnyFusion commit and paired AnyFusion-Pi commit
`dd6e555`.
