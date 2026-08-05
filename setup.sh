#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METACLAW_HOME="${METACLAW_HOME:-$HOME/.metaclaw}"
CONFIG_FILE="$METACLAW_HOME/config.yaml"
INSTALL_MODE="${METACLAW_INSTALL_MODE:-link}"
INSTALL_CODEX="${METACLAW_INSTALL_CODEX:-auto}"
INTERACTIVE="${METACLAW_SETUP_INTERACTIVE:-auto}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! command_exists "$1"; then
    log_error "缺少必需命令：$1"
    exit 1
  fi
}

node_meets_minimum_version() {
  node -e '
    const actual = process.versions.node.split(".").map(Number);
    const minimum = [22, 19, 0];
    for (let index = 0; index < minimum.length; index += 1) {
      if (actual[index] > minimum[index]) process.exit(0);
      if (actual[index] < minimum[index]) process.exit(1);
    }
  ' >/dev/null 2>&1
}

is_interactive() {
  case "$INTERACTIVE" in
    true|1|yes) return 0 ;;
    false|0|no) return 1 ;;
    auto) [ -t 0 ] && [ -t 1 ] ;;
    *)
      log_error "METACLAW_SETUP_INTERACTIVE 只能是 auto/true/false"
      exit 1
      ;;
  esac
}

executor_label() {
  case "$1" in
    codex) echo "Codex CLI (codex)" ;;
    pi) echo "Pi Agent (pi)" ;;
    hermes) echo "Hermes Agent (hermes)" ;;
    claude) echo "Claude Code (claude)" ;;
    deepseek-tui) echo "DeepSeek TUI (deepseek-tui)" ;;
    openclaw) echo "OpenClaw (openclaw)" ;;
    *) echo "$1" ;;
  esac
}

executor_profile_name() {
  case "$1" in
    codex) echo "codex-cli" ;;
    pi) echo "pi-agent" ;;
    hermes) echo "hermes-agent" ;;
    claude) echo "claude-code" ;;
    deepseek-tui) echo "deepseek-tui" ;;
    openclaw) echo "openclaw" ;;
    *) echo "$1" ;;
  esac
}

executor_install_hint() {
  case "$1" in
    codex) echo "npm install -g @openai/codex" ;;
    pi) echo "npm install -g @earendil-works/pi-coding-agent" ;;
    hermes) echo "请按 Hermes 官方说明安装 hermes CLI" ;;
    claude) echo "请按 Claude Code 官方说明安装 claude CLI" ;;
    deepseek-tui) echo "请按 DeepSeek TUI 项目说明安装 deepseek-tui" ;;
    openclaw) echo "请按 OpenClaw 项目说明安装 openclaw" ;;
    *) echo "请安装 $1 并确保命令在 PATH 中" ;;
  esac
}

can_auto_install_executor() {
  [ "$1" = "codex" ] || [ "$1" = "pi" ]
}

install_executor_command() {
  case "$1" in
    codex)
      npm install -g @openai/codex
      ;;
    pi)
      npm install -g @earendil-works/pi-coding-agent
      ;;
    *)
      log_warn "$(executor_label "$1") 暂不支持 setup 自动安装：$(executor_install_hint "$1")"
      return 1
      ;;
  esac
}

detect_executors() {
  DETECTED_EXECUTORS=()
  DETECTED_COMMANDS=()

  if command_exists codex; then
    DETECTED_EXECUTORS+=("codex-cli")
    DETECTED_COMMANDS+=("codex")
  fi
  if command_exists pi; then
    DETECTED_EXECUTORS+=("pi-agent")
    DETECTED_COMMANDS+=("pi")
  fi
  if command_exists hermes; then
    DETECTED_EXECUTORS+=("hermes-agent")
    DETECTED_COMMANDS+=("hermes")
  fi
  if command_exists claude; then
    DETECTED_EXECUTORS+=("claude-code")
    DETECTED_COMMANDS+=("claude")
  fi
  if command_exists deepseek-tui; then
    DETECTED_EXECUTORS+=("deepseek-tui")
    DETECTED_COMMANDS+=("deepseek-tui")
  fi
  if command_exists openclaw; then
    DETECTED_EXECUTORS+=("openclaw")
    DETECTED_COMMANDS+=("openclaw")
  fi
}

print_executor_table() {
  local commands=(codex pi hermes claude deepseek-tui openclaw)

  echo ""
  echo "Executor 检测结果："
  local index=1
  for command_name in "${commands[@]}"; do
    if command_exists "$command_name"; then
      printf "  %d) %-28s 已安装  %s\n" "$index" "$(executor_label "$command_name")" "$(command -v "$command_name")"
    else
      printf "  %d) %-28s 未安装  %s\n" "$index" "$(executor_label "$command_name")" "$(executor_install_hint "$command_name")"
    fi
    index=$((index + 1))
  done
  echo ""
}

parse_executor_selection() {
  local selection="$1"
  local commands=(codex pi hermes claude deepseek-tui openclaw)
  SELECTED_COMMANDS=()

  selection="${selection//,/ }"
  for item in $selection; do
    case "$item" in
      all)
        SELECTED_COMMANDS=("${commands[@]}")
        return
        ;;
      1|codex|codex-cli)
        SELECTED_COMMANDS+=("codex")
        ;;
      2|pi|pi-agent)
        SELECTED_COMMANDS+=("pi")
        ;;
      3|hermes|hermes-agent)
        SELECTED_COMMANDS+=("hermes")
        ;;
      4|claude|claude-code)
        SELECTED_COMMANDS+=("claude")
        ;;
      5|deepseek|deepseek-tui)
        SELECTED_COMMANDS+=("deepseek-tui")
        ;;
      6|openclaw)
        SELECTED_COMMANDS+=("openclaw")
        ;;
      "")
        ;;
      *)
        log_warn "忽略未知选择：$item"
        ;;
    esac
  done

  local unique=()
  for command_name in "${SELECTED_COMMANDS[@]}"; do
    local seen=false
    for existing in "${unique[@]}"; do
      if [ "$existing" = "$command_name" ]; then
        seen=true
        break
      fi
    done
    if [ "$seen" = false ]; then
      unique+=("$command_name")
    fi
  done
  SELECTED_COMMANDS=("${unique[@]}")
}

choose_executors_interactively() {
  local default_selection=""
  if [ "${#DETECTED_COMMANDS[@]}" -gt 0 ]; then
    default_selection="${DETECTED_COMMANDS[*]}"
  else
    default_selection="codex"
  fi

  print_executor_table
  echo "请选择要接入 AnyFusion 的 Executor。"
  echo "可输入编号或命令名，多个用空格或逗号分隔。例如：1,2,3 或 codex pi hermes"
  echo "默认：$default_selection"
  printf "Executor 选择> "
  local selection
  read -r selection
  selection="${selection:-$default_selection}"
  parse_executor_selection "$selection"

  if [ "${#SELECTED_COMMANDS[@]}" -eq 0 ]; then
    log_warn "没有选择任何 Executor，默认选择 codex"
    SELECTED_COMMANDS=("codex")
  fi
}

ensure_selected_executors() {
  for command_name in "${SELECTED_COMMANDS[@]}"; do
    if command_exists "$command_name"; then
      continue
    fi

    if can_auto_install_executor "$command_name"; then
      printf "%s 未安装。是否现在安装？[Y/n] " "$(executor_label "$command_name")"
      local answer
      read -r answer
      answer="${answer:-Y}"
      case "$answer" in
        y|Y|yes|YES)
          install_executor_command "$command_name"
          ;;
        *)
          log_warn "跳过安装 $(executor_label "$command_name")"
          ;;
      esac
    else
      log_warn "$(executor_label "$command_name") 未安装，setup 暂不自动安装。$(executor_install_hint "$command_name")"
    fi
  done

  detect_executors

  AVAILABLE_SELECTED_COMMANDS=()
  for command_name in "${SELECTED_COMMANDS[@]}"; do
    if command_exists "$command_name"; then
      AVAILABLE_SELECTED_COMMANDS+=("$command_name")
    fi
  done
}

select_default_executor_interactively() {
  SELECTED_DEFAULT_EXECUTOR=""
  if [ "${#AVAILABLE_SELECTED_COMMANDS[@]}" -eq 0 ]; then
    return
  fi

  echo ""
  echo "请选择默认 Executor："
  local index=1
  for command_name in "${AVAILABLE_SELECTED_COMMANDS[@]}"; do
    printf "  %d) %s\n" "$index" "$(executor_label "$command_name")"
    index=$((index + 1))
  done

  local recommended=1
  local i=1
  for command_name in "${AVAILABLE_SELECTED_COMMANDS[@]}"; do
    if [ "$command_name" = "codex" ]; then
      recommended="$i"
      break
    fi
    i=$((i + 1))
  done

  printf "默认 Executor [%d]> " "$recommended"
  local choice
  read -r choice
  choice="${choice:-$recommended}"

  if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#AVAILABLE_SELECTED_COMMANDS[@]}" ]; then
    SELECTED_DEFAULT_EXECUTOR="${AVAILABLE_SELECTED_COMMANDS[$((choice - 1))]}"
    return
  fi

  for command_name in "${AVAILABLE_SELECTED_COMMANDS[@]}"; do
    if [ "$choice" = "$command_name" ] || [ "$choice" = "$(executor_profile_name "$command_name")" ]; then
      SELECTED_DEFAULT_EXECUTOR="$command_name"
      return
    fi
  done

  log_warn "默认 Executor 选择无效，使用 ${AVAILABLE_SELECTED_COMMANDS[$((recommended - 1))]}"
  SELECTED_DEFAULT_EXECUTOR="${AVAILABLE_SELECTED_COMMANDS[$((recommended - 1))]}"
}

select_default_executor_command() {
  if command_exists codex; then
    echo "codex"
    return
  fi
  if command_exists pi; then
    echo "pi"
    return
  fi
  if command_exists hermes; then
    echo "hermes"
    return
  fi
  if command_exists claude; then
    echo "claude"
    return
  fi
  if command_exists deepseek-tui; then
    echo "deepseek-tui"
    return
  fi
  if command_exists openclaw; then
    echo "openclaw"
    return
  fi
  echo ""
}

install_codex_cli_if_needed() {
  if command_exists codex; then
    return
  fi

  case "$INSTALL_CODEX" in
    auto|true|1|yes) ;;
    false|0|no|skip)
      log_warn "未检测到任何 Executor，且 METACLAW_INSTALL_CODEX=$INSTALL_CODEX，跳过 Codex CLI 安装"
      return
      ;;
    *)
      log_error "METACLAW_INSTALL_CODEX 只能是 auto/true/false"
      exit 1
      ;;
  esac

  log_warn "未检测到可用 Executor，正在默认安装 OpenAI Codex CLI..."
  npm install -g @openai/codex

  if ! command_exists codex; then
    log_error "Codex CLI 安装后仍未在 PATH 中找到 codex。请检查 npm global bin 目录。"
    exit 1
  fi
}

setup_executors_noninteractive() {
  DEFAULT_EXECUTOR=""
  detect_executors
  if [ "${#DETECTED_EXECUTORS[@]}" -gt 0 ]; then
    log_info "检测到 Executor：${DETECTED_EXECUTORS[*]}"
  else
    log_warn "未检测到 codex/pi/hermes/claude/deepseek-tui/openclaw"
    install_codex_cli_if_needed
    detect_executors
  fi

  DEFAULT_EXECUTOR="$(select_default_executor_command)"
}

setup_executors_interactive() {
  DEFAULT_EXECUTOR=""
  detect_executors
  choose_executors_interactively
  ensure_selected_executors

  if [ "${#AVAILABLE_SELECTED_COMMANDS[@]}" -eq 0 ]; then
    log_warn "所选 Executor 均不可用，尝试默认安装 Codex CLI"
    install_codex_cli_if_needed
    detect_executors
    if command_exists codex; then
      AVAILABLE_SELECTED_COMMANDS=("codex")
    fi
  fi

  select_default_executor_interactively
  DEFAULT_EXECUTOR="$SELECTED_DEFAULT_EXECUTOR"
}

write_config() {
  local default_executor="$1"

  mkdir -p "$METACLAW_HOME"

  if [ -f "$CONFIG_FILE" ] && [ "${METACLAW_OVERWRITE_CONFIG:-false}" != "true" ]; then
    log_warn "已存在配置文件，保持不覆盖：$CONFIG_FILE"
    log_warn "如需重写配置，请设置 METACLAW_OVERWRITE_CONFIG=true 后重新运行 setup.sh"
    return
  fi

  cat > "$CONFIG_FILE" <<EOF
version: 1

executor:
  command: $default_executor
  timeout: 300
  max_duration: 3600

orchestration:
  reminder_enabled: true
  reminder_throttle: 300
  top_k_preferences: 5

ui:
  language: zh-CN
  dashboard_on_start: true

notifications:
  feishu:
    enabled: false
    webhook_url: ""
    secret: ""

integrations:
  feishu:
    enabled: false
    mode: websocket
    app_id: ""
    app_secret_env: FEISHU_APP_SECRET
    event_port: 8787
    event_path: /feishu/events
    verification_token: ""

  markdown_preview:
    enabled: true
    host: 127.0.0.1
    port: 8790
    public_base_url: ""
EOF

  log_info "已写入配置：$CONFIG_FILE"
}

install_metaclaw() {
  log_info "安装 AnyFusion 调度器依赖..."
  npm install

  log_info "构建 AnyFusion..."
  npm run build

  case "$INSTALL_MODE" in
    link)
      log_info "注册本地 AnyFusion CLI（npm link）..."
      npm link
      ;;
    none|skip)
      log_warn "跳过 CLI link。之后可用 node dist/index.js 或 ./anyfusion.sh 启动。"
      ;;
    *)
      log_error "METACLAW_INSTALL_MODE 只能是 link 或 none"
      exit 1
      ;;
  esac
}

main() {
  log_info "AnyFusion setup started"

  require_command node
  require_command npm
  require_command git

  if ! node_meets_minimum_version; then
    log_error "Node.js 版本过低：$(node --version)。AnyFusion 需要 Node.js >= 22.19.0。"
    exit 1
  fi

  cd "$SCRIPT_DIR"

  local default_executor
  if is_interactive; then
    setup_executors_interactive
  else
    setup_executors_noninteractive
  fi
  default_executor="$DEFAULT_EXECUTOR"

  if [ -z "$default_executor" ]; then
    log_error "没有可用 Executor。请安装 Codex CLI 后重试：npm install -g @openai/codex"
    exit 1
  fi

  log_info "默认 Executor：$default_executor"

  install_metaclaw
  write_config "$default_executor"

  log_info "安装完成"
  echo ""
  echo "下一步："
  echo "  anyfusion"
  echo "  npm run smoke:anyfusion"
  echo ""
  echo "或使用项目启动脚本："
  echo "  ./anyfusion.sh start"
  echo "  ./anyfusion.sh connect"
  echo ""
  echo "如果刚安装 Codex CLI，请先完成登录："
  echo "  codex"
  echo ""
  echo "Smoke gate 通过后，才表示真实任务路径可用。"
}

main "$@"
