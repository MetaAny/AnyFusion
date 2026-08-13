#!/usr/bin/env bash
# Container wrapper around the same Runtime bootstrap used by the native Ubuntu
# launcher. It adds only image paths, SSH environment persistence, and command
# execution.
set -euo pipefail

source /opt/metaclaw/runtime-bootstrap.sh

export ANYFUSION_DATA_HOME="${ANYFUSION_DATA_HOME:-/data/anyfusion}"
export ANYFUSION_CONFIG_HOME="${ANYFUSION_CONFIG_HOME:-$ANYFUSION_DATA_HOME/config}"
export METACLAW_HOME="${METACLAW_HOME:-$ANYFUSION_DATA_HOME/runtime}"
export ANYFUSION_TEMPLATE_ROOT=/opt/metaclaw
export ANYFUSION_DEFAULT_CONFIG="${ANYFUSION_DEFAULT_CONFIG:-/opt/metaclaw/default-config.yaml}"
export ANYFUSION_APP_ENTRY=/app/dist/index.js
export METACLAW_PLANNER_COMMAND="${METACLAW_PLANNER_COMMAND:-/opt/anyfusion-planner/bin/anyfusion-planner}"
export METACLAW_PLANNER_TUI_COMMAND="${METACLAW_PLANNER_TUI_COMMAND:-$METACLAW_PLANNER_COMMAND}"
export METACLAW_PLANNER_WORKDIR="${METACLAW_PLANNER_WORKDIR:-/workspace/default}"
export METACLAW_PLANNER_SCHEMA_PATH="${METACLAW_PLANNER_SCHEMA_PATH:-/opt/metaclaw/schema/planning-agent-plan-v7.schema.json}"
export ANYFUSION_PLANNER_SCHEMA_PATH="${ANYFUSION_PLANNER_SCHEMA_PATH:-$METACLAW_PLANNER_SCHEMA_PATH}"
export METACLAW_PI_ATTEMPT_EXTENSION="${METACLAW_PI_ATTEMPT_EXTENSION:-/opt/metaclaw/pi-attempt-tools.ts}"
export ANYFUSION_BOOTSTRAP_AUTO_REGISTER_EXECUTORS="${ANYFUSION_BOOTSTRAP_AUTO_REGISTER_EXECUTORS:-1}"

anyfusion_bootstrap_runtime

# pam_env supplies these non-secret paths to sessions started by sshd.
source /opt/metaclaw/persist-ssh-environment.sh
persist_ssh_environment /etc/environment

if [ "$#" -eq 0 ] || [ "$1" = ":" ]; then
  exit 0
fi

exec "$@"
