# Linux Host Launcher Plan

**Status:** Complete

**Plan date:** 2026-07-23

**Completion date:** 2026-07-23

## Objective

Add a repository-root Linux launcher that runs the latest AnyFusion source directly on the host without PowerShell, Docker, SSH, or container volumes. The launcher must continue using the three ignored provider env files under `docker/` while preventing Planner Codex, Executor Codex, and Executor Pi from inheriting the host user's agent configuration directories.

## Scope

1. Add an executable repository-root `anyfusion` Bash launcher.
2. Validate Linux, Node.js 20+, npm, Codex CLI, Pi CLI, and all three provider env files.
3. Install locked Node.js dependencies when the local installation is missing or stale.
4. Build the current TypeScript source before every launch.
5. Render host-compatible Codex and Pi runtime configuration from the Docker templates.
6. Use isolated agent configuration directories under `METACLAW_HOME` and point the Planner MCP configuration at the host build output.
7. Preserve the Docker TUI defaults when no host `config.yaml` exists.
8. Pass AnyFusion CLI arguments through unchanged and provide a non-secret `--check` mode.

## Validation

- `bash -n anyfusion`
- `./anyfusion --check`
- Verify generated Planner, Codex executor, and Pi configuration paths without printing credentials.
- `./anyfusion gateway doctor`
- Start the TUI from the repository root and terminate it cleanly after confirming initialization.
- `npm run lint`
- `git diff --check`

## Completion Record

Delivered:

- Added the executable repository-root `anyfusion` Bash launcher.
- Added Linux, Node.js, npm, Codex CLI, Pi CLI, provider-file, URL, and API-key prerequisite checks.
- Added locked dependency installation when `node_modules` is missing or stale.
- Rebuilds the TypeScript project on every launch so `dist/` always reflects the current checkout.
- Renders Planner Codex, Executor Codex, and Executor Pi configuration from the existing Docker templates.
- Rewrites the Planner MCP executable path from the container path to the repository's host `dist/planner-mcp.js`.
- Isolates both Codex homes and the Pi agent directory under `METACLAW_HOME/agent-runtime`, avoiding host `~/.codex` and `~/.pi/agent` skills, hooks, plugins, and sessions.
- Preserves an existing MetaClaw data/config directory and seeds `docker/tui-config.yaml` only when `config.yaml` does not exist.
- Added `--check` and `--launcher-help` launcher-only commands while passing all AnyFusion CLI arguments through unchanged.

Validation performed:

- `bash -n anyfusion` — passed.
- `shellcheck anyfusion` — passed.
- `./anyfusion --check` — passed with all three configured provider files.
- Generated configuration audit — passed; no Docker URL placeholder or `/app/dist/planner-mcp.js` path remained.
- Agent-home isolation audit — passed; generated Codex and Pi homes do not use host agent directories.
- `./anyfusion gateway doctor` — entered the current host build successfully; reported only the existing disabled/unconfigured Feishu checks.
- Repository-root `./anyfusion` TUI smoke — initialized the dashboard and Markdown preview successfully, then exited manually.
- `npm run lint` — passed.
- Added-file whitespace checks — passed.

Implementation commits:

- `feat: add Linux host launcher`
