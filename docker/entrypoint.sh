#!/usr/bin/env bash
# Container entrypoint that:
#  1. Persists non-secret MetaClaw runtime paths for SSH login sessions.
#  2. Reads AnyFusion Planner, Executor Codex, and Executor Pi provider
#     settings from their assigned env files.
#  3. Renders the writable Planner, Codex, and Pi configs with each base URL.
#  4. Executes the requested runtime command.
set -euo pipefail

env_file_value() {
  local env_file="$1"
  local key="$2"
  local line
  local value

  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      case "$line" in
        ''|'#'*) continue ;;
      esac
      if [[ "$line" =~ ^[[:space:]]*${key}[[:space:]]*=(.*)$ ]]; then
        value="${BASH_REMATCH[1]}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        if [[ "$value" == \"*\" ]] || [[ "$value" == \'*\' ]]; then
          value="${value:1:${#value}-2}"
        fi
        printf '%s' "$value"
        return 0
      fi
    done < "$env_file"
  fi

  printf '%s' "${!key:-}"
}

require_base_url() {
  local label="$1"
  local env_file="$2"
  local base_url
  local source_label="${env_file:-process environment}"
  base_url="$(env_file_value "$env_file" OPENAI_BASE_URL)"
  if [ -z "$base_url" ]; then
    echo "entrypoint: OPENAI_BASE_URL is empty for ${label}; set it in ${source_label}" >&2
    exit 1
  fi
  printf '%s' "$base_url"
}

render() {
  local template="$1"
  local base_url="$2"
  # The URL must not contain a literal pipe because it is the sed delimiter.
  sed "s|__OPENAI_BASE_URL__|${base_url}|g" "$template"
}

PLANNER_ENV_FILE="${METACLAW_PLANNER_ENV_FILE:-}"
CODEX_EXECUTOR_ENV_FILE="${METACLAW_CODEX_EXECUTOR_ENV_FILE:-}"
PI_EXECUTOR_ENV_FILE="${METACLAW_PI_EXECUTOR_ENV_FILE:-}"
PLANNER_OPENAI_BASE_URL="$(require_base_url 'AnyFusion Planner' "$PLANNER_ENV_FILE")"
CODEX_EXECUTOR_OPENAI_BASE_URL="$(require_base_url 'Executor Codex' "$CODEX_EXECUTOR_ENV_FILE")"
PI_EXECUTOR_OPENAI_BASE_URL="$(require_base_url 'Executor Pi' "$PI_EXECUTOR_ENV_FILE")"

# pam_env supplies these non-secret paths to sessions started by sshd.
source /opt/metaclaw/persist-ssh-environment.sh
persist_ssh_environment /etc/environment

PLANNER_AGENT_DIR="${ANYFUSION_PLANNER_HOME:-/var/lib/metaclaw/anyfusion-planner/agent}"
PLANNER_TEMPLATE_DIR="/opt/metaclaw/planner-pi-config"

if [ -d "$PLANNER_TEMPLATE_DIR" ]; then
  mkdir -p "$PLANNER_AGENT_DIR"
  for f in models.json settings.json; do
    if [ -f "$PLANNER_TEMPLATE_DIR/$f" ]; then
      render "$PLANNER_TEMPLATE_DIR/$f" "$PLANNER_OPENAI_BASE_URL" > "$PLANNER_AGENT_DIR/$f"
    fi
  done
fi

PI_AGENT_DIR="${HOME}/.pi/agent"
PI_TEMPLATE_DIR="/opt/metaclaw/pi-config"

if [ -d "$PI_TEMPLATE_DIR" ]; then
  mkdir -p "$PI_AGENT_DIR"
  for f in models.json settings.json; do
    if [ -f "$PI_TEMPLATE_DIR/$f" ]; then
      render "$PI_TEMPLATE_DIR/$f" "$PI_EXECUTOR_OPENAI_BASE_URL" > "$PI_AGENT_DIR/$f"
    fi
  done
fi

EXECUTOR_CODEX_HOME="${METACLAW_EXECUTOR_CODEX_HOME:-/var/lib/metaclaw/codex/executor}"
CODEX_TEMPLATE_DIR="/opt/metaclaw/codex-config"

mkdir -p "$EXECUTOR_CODEX_HOME"
render "$CODEX_TEMPLATE_DIR/executor/config.toml" "$CODEX_EXECUTOR_OPENAI_BASE_URL" > "$EXECUTOR_CODEX_HOME/config.toml"

METACLAW_HOME_DIR="${METACLAW_HOME:-/data/metaclaw}"
mkdir -p "$METACLAW_HOME_DIR"
if [ ! -f "$METACLAW_HOME_DIR/config.yaml" ]; then
  cp /opt/metaclaw/default-config.yaml "$METACLAW_HOME_DIR/config.yaml"
fi

if [ "$#" -eq 0 ] || [ "$1" = ":" ]; then
  exit 0
fi

exec "$@"
