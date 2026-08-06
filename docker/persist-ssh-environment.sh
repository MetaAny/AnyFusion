#!/usr/bin/env bash

# Persist container runtime settings for pam_env.so, which supplies the
# environment of sessions started by sshd.
persist_ssh_environment() {
  local environment_file="${1:?environment file path is required}"
  local tmp
  tmp=$(mktemp)

  grep -vE "^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|DEEPSEEK_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|OPENROUTER_API_KEY|PI_SKIP_VERSION_CHECK|PI_TELEMETRY|METACLAW_HOME|ANYFUSION_PLANNER_HOME|METACLAW_PLANNER_HOME|METACLAW_EXECUTOR_BACKEND|METACLAW_EXECUTOR_CODEX_HOME|METACLAW_EXECUTOR_PI_HOME|METACLAW_PLANNER_SESSION_DIR|METACLAW_PLANNER_SCHEMA_PATH|METACLAW_PLANNER_WORKDIR|METACLAW_PLANNER_ENV_FILE|METACLAW_PLANNER_COMMAND|METACLAW_PLANNER_TUI_COMMAND|METACLAW_PLANNER_TUI_SOCKET|ANYFUSION_BRIDGE_SOCKET|ANYFUSION_PLANNER_MODE|ANYFUSION_PLANNER_SCHEMA_PATH|METACLAW_CODEX_EXECUTOR_ENV_FILE|METACLAW_PI_EXECUTOR_ENV_FILE)=" "$environment_file" > "$tmp" 2>/dev/null || true
  for kv in \
    "PI_SKIP_VERSION_CHECK=${PI_SKIP_VERSION_CHECK:-1}" \
    "PI_TELEMETRY=${PI_TELEMETRY:-0}" \
    "METACLAW_HOME=${METACLAW_HOME:-/data/metaclaw}" \
    "ANYFUSION_PLANNER_HOME=${ANYFUSION_PLANNER_HOME:-/var/lib/metaclaw/anyfusion-planner/agent}" \
    "METACLAW_PLANNER_HOME=${METACLAW_PLANNER_HOME:-${ANYFUSION_PLANNER_HOME:-/var/lib/metaclaw/anyfusion-planner/agent}}" \
    "METACLAW_EXECUTOR_BACKEND=${METACLAW_EXECUTOR_BACKEND:-worktree}" \
    "METACLAW_EXECUTOR_CODEX_HOME=${METACLAW_EXECUTOR_CODEX_HOME:-/var/lib/metaclaw/codex/executor}" \
    "METACLAW_EXECUTOR_PI_HOME=${METACLAW_EXECUTOR_PI_HOME:-/root}" \
    "METACLAW_PLANNER_SESSION_DIR=${METACLAW_PLANNER_SESSION_DIR:-/var/lib/metaclaw/anyfusion-planner/sessions}" \
    "METACLAW_PLANNER_SCHEMA_PATH=${METACLAW_PLANNER_SCHEMA_PATH:-/opt/metaclaw/schema/planning-agent-plan-v7.schema.json}" \
    "METACLAW_PLANNER_WORKDIR=${METACLAW_PLANNER_WORKDIR:-/workspace}" \
    "METACLAW_PLANNER_ENV_FILE=${METACLAW_PLANNER_ENV_FILE:-/run/metaclaw/env/planner-pi.env}" \
    "METACLAW_PLANNER_COMMAND=${METACLAW_PLANNER_COMMAND:-/opt/anyfusion-planner/bin/anyfusion-planner}" \
    "METACLAW_PLANNER_TUI_COMMAND=${METACLAW_PLANNER_TUI_COMMAND:-/opt/anyfusion-planner/bin/anyfusion-planner}" \
    "METACLAW_PLANNER_TUI_SOCKET=${METACLAW_PLANNER_TUI_SOCKET:-/data/metaclaw/anyfusion-planner.sock}" \
    "ANYFUSION_BRIDGE_SOCKET=${ANYFUSION_BRIDGE_SOCKET:-/data/metaclaw/anyfusion-planner.sock}" \
    "ANYFUSION_PLANNER_MODE=${ANYFUSION_PLANNER_MODE:-1}" \
    "ANYFUSION_PLANNER_SCHEMA_PATH=${ANYFUSION_PLANNER_SCHEMA_PATH:-/opt/metaclaw/schema/planning-agent-plan-v7.schema.json}" \
    "METACLAW_CODEX_EXECUTOR_ENV_FILE=${METACLAW_CODEX_EXECUTOR_ENV_FILE:-/run/metaclaw/env/executor-codex.env}" \
    "METACLAW_PI_EXECUTOR_ENV_FILE=${METACLAW_PI_EXECUTOR_ENV_FILE:-/run/metaclaw/env/executor-pi.env}"
  do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    if [ -n "$val" ]; then
      case "$val" in
        *[[:space:]\"\'#$]*) printf "%s='%s'\n" "$key" "$val" ;;
        *) printf "%s=%s\n" "$key" "$val" ;;
      esac
    fi
  done >> "$tmp"

  cat "$tmp" > "$environment_file"
  rm -f "$tmp"
}
