#!/usr/bin/env bash

set -Eeuo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_MODE="${METACLAW_INSTALL_MODE:-link}"

fail() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

main() {
  require_command node
  require_command npm
  require_command git
  require_command codex
  require_command pi

  node -e '
    const actual = process.versions.node.split(".").map(Number);
    const minimum = [22, 19, 0];
    for (let index = 0; index < minimum.length; index += 1) {
      if (actual[index] > minimum[index]) process.exit(0);
      if (actual[index] < minimum[index]) process.exit(1);
    }
  ' || fail "Node.js >= 22.19.0 is required; found $(node --version)."

  cd "$REPO_ROOT"
  ./anyfusion build

  case "$INSTALL_MODE" in
    link)
      npm link
      ;;
    none|skip)
      ;;
    *)
      fail 'METACLAW_INSTALL_MODE must be link or none'
      ;;
  esac

  ./anyfusion --check
  printf '[INFO] Native AnyFusion installation is ready. Run: anyfusion\n'
}

main "$@"
