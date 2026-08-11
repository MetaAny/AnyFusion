#!/usr/bin/env bash

# Shared bootstrap for the native Ubuntu launcher and the Ubuntu Runtime image.
# Packaging wrappers set paths; this file owns the common mutable layout,
# provider config rendering, command discovery, and built-in Executor Registry
# preparation.

anyfusion_bootstrap_fail() {
  printf '[ERROR] %s\n' "$*" >&2
  return 1
}

anyfusion_bootstrap_require_command() {
  command -v "$1" >/dev/null 2>&1 \
    || anyfusion_bootstrap_fail "Missing required command: $1"
}

anyfusion_bootstrap_env_file_value() {
  local env_file="$1"
  local key="$2"
  local line
  local value

  if [[ -n "$env_file" && -f "$env_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
      if [[ "$line" =~ ^[[:space:]]*${key}[[:space:]]*=(.*)$ ]]; then
        value="${BASH_REMATCH[1]}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        if [[ "$value" == \"*\" && "$value" == *\" ]] \
          || [[ "$value" == \'*\' && "$value" == *\' ]]; then
          value="${value:1:${#value}-2}"
        fi
        printf '%s' "$value"
        return 0
      fi
    done < "$env_file"
  fi

  printf '%s' "${!key:-}"
}

anyfusion_bootstrap_validate_provider_env() {
  local label="$1"
  local env_file="$2"
  local source_label="${env_file:-process environment}"

  if [[ -n "$env_file" && ! -f "$env_file" ]]; then
    anyfusion_bootstrap_fail "Missing $env_file; configure the $label provider."
    return
  fi
  [[ -n "$(anyfusion_bootstrap_env_file_value "$env_file" OPENAI_API_KEY)" ]] \
    || anyfusion_bootstrap_fail "$label OPENAI_API_KEY is empty in $source_label"
  [[ -n "$(anyfusion_bootstrap_env_file_value "$env_file" OPENAI_BASE_URL)" ]] \
    || anyfusion_bootstrap_fail "$label OPENAI_BASE_URL is empty in $source_label"
}

anyfusion_bootstrap_render() {
  local template="$1"
  local output="$2"
  local base_url="$3"
  sed "s|__OPENAI_BASE_URL__|${base_url}|g" "$template" > "$output"
}

anyfusion_bootstrap_ensure_executor() {
  local executor_id="$1"
  local profile_id="$2"
  local binary_path="$3"
  local runtime_home="$4"
  local env_file="$5"
  local description="$6"
  local capabilities="$7"
  local use_cases="$8"

  if node "$ANYFUSION_APP_ENTRY" executor show "$executor_id" >/dev/null 2>&1; then
    return 0
  fi

  printf '[INFO] Registering and verifying Executor %s...\n' "$executor_id"
  node "$ANYFUSION_APP_ENTRY" executor register "$executor_id" \
    --profile "$profile_id" \
    --binary "$binary_path" \
    --home "$runtime_home" \
    --env-files "$env_file" \
    --description "$description" \
    --capabilities "$capabilities" \
    --use-cases "$use_cases"
}

anyfusion_bootstrap_ensure_canonical_executors() {
  anyfusion_bootstrap_ensure_executor \
    codex \
    codex \
    "$(command -v codex)" \
    "$METACLAW_EXECUTOR_CODEX_HOME" \
    "$METACLAW_CODEX_EXECUTOR_ENV_FILE" \
    'Repository implementation, testing, and code review.' \
    workspace-engineering \
    implementation,testing,code-review

  anyfusion_bootstrap_ensure_executor \
    pi \
    pi \
    "$(command -v pi)" \
    "$METACLAW_EXECUTOR_PI_HOME" \
    "$METACLAW_PI_EXECUTOR_ENV_FILE" \
    'Current public-web research and source verification.' \
    current-web-research \
    research,source-verification,cited-reports
}

anyfusion_bootstrap_runtime() {
  local default_data_home="${XDG_DATA_HOME:-$HOME/.local/share}/anyfusion"
  local default_config_home="${XDG_CONFIG_HOME:-$HOME/.config}/anyfusion"
  local planner_base_url
  local codex_base_url
  local pi_base_url

  export ANYFUSION_DATA_HOME="${ANYFUSION_DATA_HOME:-$default_data_home}"
  export ANYFUSION_CONFIG_HOME="${ANYFUSION_CONFIG_HOME:-$default_config_home}"
  export METACLAW_HOME="${METACLAW_HOME:-$ANYFUSION_DATA_HOME/runtime}"
  export ANYFUSION_PLANNER_HOME="${ANYFUSION_PLANNER_HOME:-$ANYFUSION_CONFIG_HOME/planner}"
  export METACLAW_PLANNER_HOME="${METACLAW_PLANNER_HOME:-$ANYFUSION_PLANNER_HOME}"
  export METACLAW_EXECUTOR_CODEX_HOME="${METACLAW_EXECUTOR_CODEX_HOME:-$ANYFUSION_CONFIG_HOME/codex}"
  export METACLAW_EXECUTOR_PI_HOME="${METACLAW_EXECUTOR_PI_HOME:-$ANYFUSION_CONFIG_HOME/pi-home}"
  export METACLAW_PLANNER_SESSION_DIR="${METACLAW_PLANNER_SESSION_DIR:-$METACLAW_HOME/planner-sessions}"
  export PI_SKIP_VERSION_CHECK="${PI_SKIP_VERSION_CHECK:-1}"
  export PI_TELEMETRY="${PI_TELEMETRY:-0}"

  : "${ANYFUSION_TEMPLATE_ROOT:?ANYFUSION_TEMPLATE_ROOT is required}"
  : "${ANYFUSION_DEFAULT_CONFIG:?ANYFUSION_DEFAULT_CONFIG is required}"
  : "${ANYFUSION_APP_ENTRY:?ANYFUSION_APP_ENTRY is required}"
  : "${METACLAW_PLANNER_ENV_FILE:?METACLAW_PLANNER_ENV_FILE is required}"
  : "${METACLAW_CODEX_EXECUTOR_ENV_FILE:?METACLAW_CODEX_EXECUTOR_ENV_FILE is required}"
  : "${METACLAW_PI_EXECUTOR_ENV_FILE:?METACLAW_PI_EXECUTOR_ENV_FILE is required}"

  anyfusion_bootstrap_require_command node
  anyfusion_bootstrap_require_command codex
  anyfusion_bootstrap_require_command pi
  anyfusion_bootstrap_validate_provider_env 'Planner' "$METACLAW_PLANNER_ENV_FILE"
  anyfusion_bootstrap_validate_provider_env 'Codex Executor' "$METACLAW_CODEX_EXECUTOR_ENV_FILE"
  anyfusion_bootstrap_validate_provider_env 'Pi Executor' "$METACLAW_PI_EXECUTOR_ENV_FILE"

  planner_base_url="$(anyfusion_bootstrap_env_file_value "$METACLAW_PLANNER_ENV_FILE" OPENAI_BASE_URL)"
  codex_base_url="$(anyfusion_bootstrap_env_file_value "$METACLAW_CODEX_EXECUTOR_ENV_FILE" OPENAI_BASE_URL)"
  pi_base_url="$(anyfusion_bootstrap_env_file_value "$METACLAW_PI_EXECUTOR_ENV_FILE" OPENAI_BASE_URL)"
  mkdir -p \
    "$METACLAW_HOME" \
    "$METACLAW_PLANNER_SESSION_DIR" \
    "$ANYFUSION_PLANNER_HOME" \
    "$METACLAW_EXECUTOR_CODEX_HOME" \
    "$METACLAW_EXECUTOR_PI_HOME/.pi/agent"

  anyfusion_bootstrap_render \
    "$ANYFUSION_TEMPLATE_ROOT/planner-pi-config/models.json" \
    "$ANYFUSION_PLANNER_HOME/models.json" \
    "$planner_base_url"
  cp "$ANYFUSION_TEMPLATE_ROOT/planner-pi-config/settings.json" \
    "$ANYFUSION_PLANNER_HOME/settings.json"
  anyfusion_bootstrap_render \
    "$ANYFUSION_TEMPLATE_ROOT/codex-config/executor/config.toml" \
    "$METACLAW_EXECUTOR_CODEX_HOME/config.toml" \
    "$codex_base_url"
  anyfusion_bootstrap_render \
    "$ANYFUSION_TEMPLATE_ROOT/pi-config/models.json" \
    "$METACLAW_EXECUTOR_PI_HOME/.pi/agent/models.json" \
    "$pi_base_url"
  cp "$ANYFUSION_TEMPLATE_ROOT/pi-config/settings.json" \
    "$METACLAW_EXECUTOR_PI_HOME/.pi/agent/settings.json"

  if [[ ! -f "$METACLAW_HOME/config.yaml" ]]; then
    cp "$ANYFUSION_DEFAULT_CONFIG" "$METACLAW_HOME/config.yaml"
  fi

  if [[ "${ANYFUSION_BOOTSTRAP_PREPARE_REGISTRY:-1}" == '1' ]]; then
    [[ -f "$ANYFUSION_APP_ENTRY" ]] \
      || anyfusion_bootstrap_fail "Missing Runtime entry: $ANYFUSION_APP_ENTRY"
    node "$ANYFUSION_APP_ENTRY" executor list >/dev/null
    node "$ANYFUSION_APP_ENTRY" executor discover >/dev/null
    if [[ "${ANYFUSION_BOOTSTRAP_AUTO_REGISTER_EXECUTORS:-0}" == '1' ]]; then
      anyfusion_bootstrap_ensure_canonical_executors
    fi
  fi
}
