#!/usr/bin/env bash
# zombie-heal.sh — keep the ZombieCoder model path alive and prove it.
#
# The path this script restores:
#
#   1. ollama            HTTP 127.0.0.1:11434 (or OLLAMA_BASE_URL)
#   2. ZombieCoder       node start.js, HTTP HOST:PORT (default 127.0.0.1:9999)
#   3. public agent      zombiecoder/<agent> -> provider/model alias -> Ollama
#   4. OpenCode          providers.zombie -> the same public agent model
#
# Every value is read from $APP_DIR/.env first; the environment overrides it, so
# there is no second copy of the configuration in this file.
#
# Usage:
#   ./scripts/zombie-heal.sh status      show the stack, change nothing
#   ./scripts/zombie-heal.sh once        check, repair if needed, verify, exit
#   ./scripts/zombie-heal.sh start       same as `once`, but always repair
#   ./scripts/zombie-heal.sh watch       check every CHECK_INTERVAL seconds
#   ./scripts/zombie-heal.sh stop        stop a running watchdog
#   ./scripts/zombie-heal.sh install     install + start a systemd --user watchdog
#   ./scripts/zombie-heal.sh uninstall   remove that unit
#   ./scripts/zombie-heal.sh verify      real Ollama binding verifier + live probe
#   ./scripts/zombie-heal.sh opencode    install the OpenCode provider
#   ./scripts/zombie-heal.sh --help      this text
#
# Flags:
#   --dry-run       report what would change, start/stop nothing
#   --verbose       print the probes that passed, not only the failures
#   --deep          status: run a real generation probe
#   --no-default    opencode: keep the existing OpenCode default model
set -u

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

# ---------------------------------------------------------------- env load ---
# Read KEY=VALUE only. No eval, no command substitution: a token with `$()` in
# it must stay a token. An explicitly exported value always wins over the file.
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      [A-Za-z_][A-Za-z0-9_]*) ;;
      *) continue ;;
    esac
    value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"
    value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [ -n "$value" ] || continue
    [ -n "${!key:-}" ] && continue
    export "$key=$value"
  done <"$ENV_FILE"
}
load_env

RUNTIME_HOST="${HOST:-127.0.0.1}"
case "$RUNTIME_HOST" in 0.0.0.0|::|"[::]") RUNTIME_HOST=127.0.0.1 ;; esac
RUNTIME_PORT="${PORT:-9999}"
RUNTIME_URL="http://${RUNTIME_HOST}:${RUNTIME_PORT}"

OLLAMA_BASE="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
OLLAMA_URL="${OLLAMA_BASE%/v1}"; OLLAMA_URL="${OLLAMA_URL%/}"

LOG_DIR_RAW="${LOG_DIR:-./logs}"
case "$LOG_DIR_RAW" in
  /*) RUNTIME_LOG_DIR="$LOG_DIR_RAW" ;;
  *) RUNTIME_LOG_DIR="$APP_DIR/${LOG_DIR_RAW#./}" ;;
esac
RUNTIME_LOG="$RUNTIME_LOG_DIR/runtime.out"
RUNTIME_JSONL="$RUNTIME_LOG_DIR/${LOG_FILE:-runtime.jsonl}"
PID_FILE="$APP_DIR/.zombiecoder-runtime.pid"

OPENCODE_PROVIDER="${OPENCODE_PROVIDER:-zombie}"
KEY_FILE="${OPENCODE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/zombie.key}"
OPENCODE_CONFIG="${OPENCODE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json}"

# The first configured public agent model is the one this stack proves. The
# default keeps the script useful before .env has been edited.
if [ -z "${PUBLIC_MODEL:-}" ] && [ -n "${AGENT_MODEL_BINDINGS:-}" ]; then
  PUBLIC_MODEL="$(node -e 'try{const b=JSON.parse(process.argv[1]||"{}");process.stdout.write(Object.keys(b)[0]||"")}catch{}' "$AGENT_MODEL_BINDINGS" 2>/dev/null || true)"
fi
PUBLIC_MODEL="${PUBLIC_MODEL:-zombiecoder/code-guru}"

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/zombie-heal"
LOCK_FILE="$STATE_DIR/watch.lock"
WATCH_PID_FILE="$STATE_DIR/watch.pid"

START_TIMEOUT="${START_TIMEOUT:-40}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-3}"
GEN_TIMEOUT="${GEN_TIMEOUT:-120}"
HEAL_ATTEMPTS="${HEAL_ATTEMPTS:-2}"

DRY_RUN=0
VERBOSE=0
DEEP=0
ACTION=""
EXTRA_ARGS=()

usage() {
  sed -n '2,30p' "$0" | sed -E 's/^# ?//'
}

log() {
  local level="$1"; shift
  printf '%s %-5s %s\n' "$(date +%H:%M:%S)" "$level" "$*"
}

# ------------------------------------------------------------------ probes ---
http_ok() { curl -fsS -o /dev/null --max-time "${2:-$PROBE_TIMEOUT}" "$1" 2>/dev/null; }

ollama_ok() { http_ok "$OLLAMA_URL/api/version"; }

runtime_health() {
  curl -fsS --max-time "$PROBE_TIMEOUT" "$RUNTIME_URL/health" 2>/dev/null \
    | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

public_model_listed() {
  curl -fsS --max-time "$PROBE_TIMEOUT" "$RUNTIME_URL/v1/models" 2>/dev/null \
    | grep -qF "\"$PUBLIC_MODEL\""
}

key_present() { [ -s "$KEY_FILE" ]; }
key_mode_ok() { [ "$(stat -c '%a' "$KEY_FILE" 2>/dev/null || true)" = "600" ]; }

binding_ok() {
  [ -n "${AGENT_MODEL_BINDINGS:-}" ] || return 1
  node -e 'try{const b=JSON.parse(process.argv[1]||"{}");process.exit(Object.prototype.hasOwnProperty.call(b,process.argv[2])?0:1)}catch{process.exit(1)}' "$AGENT_MODEL_BINDINGS" "$PUBLIC_MODEL" 2>/dev/null
}

opencode_config_ok() {
  [ -f "$OPENCODE_CONFIG" ] || return 1
  node -e 'try{const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers&&c.providers[process.argv[2]];process.exit(p&&p.settings&&p.settings.baseURL&&p.models&&p.models[process.argv[3]]?0:1)}catch{process.exit(1)}' "$OPENCODE_CONFIG" "$OPENCODE_PROVIDER" "$PUBLIC_MODEL" 2>/dev/null
}

runtime_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF "$APP_DIR/src/server.js" || return 1
  printf '%s' "$pid"
}

port_pid() {
  ss -ltnpH 2>/dev/null | grep -E ":${RUNTIME_PORT}\b" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

# A 200 from /health only proves a listener exists. This asks the public model
# for four tokens and checks both halves of the identity: the body echoes
# `zombiecoder/<agent>` and `ZombieCoder`, and no upstream name leaks.
generation_ok() {
  key_present || return 2
  local key body
  key="$(tr -d '\r\n' <"$KEY_FILE")"
  body="$(curl -fsS --max-time "$GEN_TIMEOUT" "$RUNTIME_URL/v1/chat/completions" \
    -H "authorization: Bearer $key" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$PUBLIC_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"max_tokens\":4,\"temperature\":0,\"stream\":false}" \
    2>/dev/null)" || return 1
  printf '%s' "$body" | grep -qF "\"model\":\"$PUBLIC_MODEL\"" || return 1
  printf '%s' "$body" | grep -qF '"provider":"ZombieCoder"' || return 1
  if printf '%s' "$body" | grep -qiE 'qwen|ollama-selfhosted|ollama-cloud|gpt-oss|gemini-'; then return 1; fi
  return 0
}

watch_state() {
  if systemctl --user is-active --quiet zombie-heal.service 2>/dev/null; then printf 'UNIT'; return 0; fi
  if [ -f "$WATCH_PID_FILE" ]; then
    local pid
    pid="$(tr -d '[:space:]' <"$WATCH_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf 'PID %s' "$pid"; return 0; fi
  fi
  printf 'STOPPED'
  return 1
}

# Wait for a condition (function name + optional arg) up to $2 seconds.
wait_for() {
  local fn="$1" seconds="${2:-$START_TIMEOUT}" i=0
  while [ "$i" -lt "$((seconds * 2))" ]; do
    if "$fn" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# ------------------------------------------------------------------ repair ---
stop_pid() {
  local pid="$1" i=0
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  while [ "$i" -lt 30 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
    i=$((i + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
}

stop_runtime() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: would stop the runtime with node start.js --stop"
    return 0
  fi
  ( cd "$APP_DIR" && node start.js --stop ) >>"$RUNTIME_LOG" 2>&1 || true
  rm -f "$PID_FILE" 2>/dev/null || true
}

start_runtime() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: would start node start.js"
    return 0
  fi
  mkdir -p "$RUNTIME_LOG_DIR" "$STATE_DIR"
  ( cd "$APP_DIR" && nohup setsid --fork node start.js >>"$RUNTIME_LOG" 2>&1 < /dev/null )
  log INFO "started node start.js log=$RUNTIME_LOG"
}

ensure_ollama() {
  if ollama_ok; then
    [ "$VERBOSE" -eq 1 ] && log INFO "ollama OK"
    return 0
  fi
  log WARN "ollama is not answering on $OLLAMA_URL"
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: would start/restart ollama"
    return 1
  fi
  if systemctl cat ollama.service >/dev/null 2>&1; then
    if sudo -n systemctl restart ollama.service 2>/dev/null; then
      log INFO "restarted ollama.service"
    else
      log ERROR "cannot restart ollama.service without a password; run as root or fix the unit"
    fi
  elif command -v ollama >/dev/null 2>&1; then
    mkdir -p "$STATE_DIR"
    nohup ollama serve >>"$STATE_DIR/ollama.log" 2>&1 &
    log INFO "started ollama serve pid=$!"
  else
    log ERROR "ollama binary not found; install Ollama or set OLLAMA_BASE_URL"
  fi
  if wait_for ollama_ok "$START_TIMEOUT"; then
    log INFO "ollama answered after repair"
    return 0
  fi
  log ERROR "ollama still not answering after repair"
  return 1
}

ensure_binding() {
  if binding_ok; then
    [ "$VERBOSE" -eq 1 ] && log INFO "binding OK: $PUBLIC_MODEL"
    return 0
  fi
  log ERROR "AGENT_MODEL_BINDINGS in $ENV_FILE does not contain $PUBLIC_MODEL"
  log ERROR "add: AGENT_MODEL_BINDINGS={\"$PUBLIC_MODEL\":{\"agent\":\"code-guru\",\"provider\":\"ollama-selfhosted\",\"model\":\"zombie-classic\"}}"
  return 1
}

ensure_runtime() {
  if runtime_health && public_model_listed; then
    [ "$VERBOSE" -eq 1 ] && log INFO "runtime OK pid=$(runtime_pid || echo unknown)"
    return 0
  fi

  local holder own
  holder="$(port_pid || true)"
  own="$(runtime_pid || true)"
  if [ -n "$holder" ] && [ "$holder" != "$own" ]; then
    log ERROR "port $RUNTIME_PORT is held by foreign pid $holder ($(tr '\0' ' ' <"/proc/$holder/cmdline" 2>/dev/null)); refusing to kill it"
    return 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: would restart node start.js"
    return 1
  fi

  log WARN "runtime is not healthy (health=$(runtime_health && echo yes || echo no), model=$(public_model_listed && echo yes || echo no))"
  stop_runtime
  start_runtime
  if ! wait_for runtime_health "$START_TIMEOUT"; then
    log ERROR "runtime /health did not answer within ${START_TIMEOUT}s (see $RUNTIME_LOG)"
    return 1
  fi
  log INFO "runtime /health answered"
  if ! wait_for public_model_listed "$START_TIMEOUT"; then
    log ERROR "/v1/models does not list $PUBLIC_MODEL; check AGENT_MODEL_BINDINGS in $ENV_FILE"
    return 1
  fi
  log INFO "public model $PUBLIC_MODEL is listed"
  return 0
}

check_generation() {
  generation_ok
  local rc=$?
  if [ "$rc" -eq 2 ]; then
    log WARN "generation probe skipped: no key file at $KEY_FILE (run: $0 opencode)"
    return 0
  fi
  if [ "$rc" -ne 0 ]; then
    log ERROR "generation probe failed for $PUBLIC_MODEL (see $RUNTIME_LOG)"
    return 1
  fi
  [ "$VERBOSE" -eq 1 ] && log INFO "generation probe OK: $PUBLIC_MODEL answered as ZombieCoder"
  return 0
}

check_all() {
  local failures=0
  ollama_ok || { log WARN "check: ollama unanswered at $OLLAMA_URL"; failures=$((failures + 1)); }
  runtime_health || { log WARN "check: runtime /health unanswered at $RUNTIME_URL"; failures=$((failures + 1)); }
  public_model_listed || { log WARN "check: /v1/models is missing $PUBLIC_MODEL"; failures=$((failures + 1)); }
  binding_ok || { log WARN "check: AGENT_MODEL_BINDINGS is missing $PUBLIC_MODEL"; failures=$((failures + 1)); }
  key_present || log WARN "check: no OpenCode key at $KEY_FILE (run: $0 opencode)"
  if [ "$DEEP" -eq 1 ]; then
    check_generation || failures=$((failures + 1))
  fi
  [ "$failures" -eq 0 ]
}

heal() {
  local attempt=0 ok=0
  # Repair is only finished when the public model answers for real. If there is
  # no OpenCode key yet, check_generation skips instead of pretending to pass.
  local DEEP=1
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: one repair pass, nothing is started or stopped"
    ensure_ollama || true
    ensure_binding || true
    ensure_runtime || true
    log WARN "dry-run finished; rerun without --dry-run to apply"
    return 1
  fi
  while [ "$attempt" -lt "$HEAL_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    log INFO "repair attempt $attempt/$HEAL_ATTEMPTS"
    ok=1
    ensure_ollama || ok=0
    ensure_binding || ok=0
    ensure_runtime || ok=0
    if [ "$ok" -eq 1 ] && check_all; then
      log INFO "repair complete: stack is healthy"
      return 0
    fi
    sleep 3
  done
  log ERROR "repair failed after $HEAL_ATTEMPTS attempts; see $RUNTIME_LOG"
  return 1
}

# ---------------------------------------------------------------- reporting ---
status_rows() {
  local verdict=0 ollama_state runtime_state model_state binding_state key_state config_state gen_state watchdog gen_rc
  if ollama_ok; then ollama_state="UP"; else ollama_state="DOWN"; verdict=1; fi
  if runtime_health; then runtime_state="UP"; else runtime_state="DOWN"; verdict=1; fi
  if public_model_listed; then model_state="OK"; else model_state="MISSING"; verdict=1; fi
  if binding_ok; then binding_state="OK"; else binding_state="MISSING"; verdict=1; fi
  if key_present && key_mode_ok; then key_state="OK"
  elif key_present; then key_state="WARN"
  else key_state="MISSING"
  fi
  if opencode_config_ok; then config_state="OK"; else config_state="MISSING"; fi
  if [ "$DEEP" -eq 1 ]; then
    generation_ok
    gen_rc=$?
    case "$gen_rc" in
      0) gen_state="OK" ;;
      2) gen_state="SKIP" ;;
      *) gen_state="FAIL"; verdict=1 ;;
    esac
  else
    gen_state="SKIP"
  fi
  watchdog="$(watch_state)"

  printf '%-20s %-8s %s\n' "component" "state" "detail"
  printf '%-20s %-8s %s\n' "ollama" "$ollama_state" "$OLLAMA_URL"
  printf '%-20s %-8s %s\n' "runtime" "$runtime_state" "$RUNTIME_URL pid=$(runtime_pid || echo none)"
  printf '%-20s %-8s %s\n' "public model" "$model_state" "$PUBLIC_MODEL"
  printf '%-20s %-8s %s\n' "binding" "$binding_state" "AGENT_MODEL_BINDINGS in $ENV_FILE"
  printf '%-20s %-8s %s\n' "opencode key" "$key_state" "$KEY_FILE mode=$(stat -c '%a' "$KEY_FILE" 2>/dev/null || echo none)"
  printf '%-20s %-8s %s\n' "opencode config" "$config_state" "$OPENCODE_CONFIG ($OPENCODE_PROVIDER/$PUBLIC_MODEL)"
  printf '%-20s %-8s %s\n' "generation" "$gen_state" "$([ "$DEEP" -eq 1 ] && echo 'real chat probe' || echo 'run with --deep')"
  printf '%-20s %-8s %s\n' "watchdog" "$watchdog" "unit zombie-heal.service"
  return "$verdict"
}

# ------------------------------------------------------------------ actions ---
acquire_lock() {
  mkdir -p "$STATE_DIR"
  exec 9>"$LOCK_FILE" || { log ERROR "cannot open $LOCK_FILE"; return 1; }
  if ! flock -n 9; then
    log ERROR "another zombie-heal watch is running (lock $LOCK_FILE)"
    return 1
  fi
  return 0
}

release_lock() {
  rm -f "$WATCH_PID_FILE" 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
}

watch_loop() {
  acquire_lock || exit 1
  printf '%s\n' "$$" >"$WATCH_PID_FILE" 2>/dev/null || true
  SLEEP_PID=""
  on_signal() {
    log INFO "watchdog stopped (signal)"
    [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
    release_lock
    exit 0
  }
  trap on_signal INT TERM
  trap 'release_lock' EXIT
  log INFO "watchdog started pid=$$ interval=${CHECK_INTERVAL}s app=$APP_DIR"
  while :; do
    if ! check_all; then
      log WARN "check failed, repairing"
      heal || log ERROR "stack still broken; will retry in ${CHECK_INTERVAL}s"
    else
      log INFO "check: healthy"
    fi
    sleep "$CHECK_INTERVAL" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null
    SLEEP_PID=""
  done
}

install_unit() {
  local unit_dir unit_file node_dir
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  unit_file="$unit_dir/zombie-heal.service"
  node_dir="$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: would write $unit_file"
    return 0
  fi
  mkdir -p "$unit_dir" "$STATE_DIR"
  cat >"$unit_file" <<UNIT
[Unit]
Description=ZombieCoder runtime + Ollama + OpenCode provider watchdog
After=network-online.target

[Service]
Type=simple
Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin
Environment=APP_DIR=$APP_DIR
ExecStart=/usr/bin/env bash $APP_DIR/scripts/zombie-heal.sh watch
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now zombie-heal.service
  log INFO "installed $unit_file"
  log INFO "survives logout only after: loginctl enable-linger $USER (one-time, needs a session bus)"
  systemctl --user --no-pager status zombie-heal.service 2>/dev/null | head -12 || true
}

uninstall_unit() {
  local unit_file
  unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/zombie-heal.service"
  if [ "$DRY_RUN" -eq 1 ]; then
    log WARN "dry-run: would disable $unit_file"
    return 0
  fi
  systemctl --user disable --now zombie-heal.service 2>/dev/null || true
  rm -f "$unit_file"
  systemctl --user daemon-reload 2>/dev/null || true
  log INFO "removed $unit_file"
}

stop_watch() {
  local unit_file pid
  unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/zombie-heal.service"
  if [ -f "$unit_file" ]; then
    systemctl --user disable --now zombie-heal.service 2>/dev/null || true
    log INFO "stopped systemd unit; stack left running"
    return 0
  fi
  if [ -f "$WATCH_PID_FILE" ]; then
    pid="$(tr -d '[:space:]' <"$WATCH_PID_FILE" 2>/dev/null || true)"
    stop_pid "${pid:-}"
    rm -f "$WATCH_PID_FILE"
    log INFO "stopped watchdog${pid:+ pid=$pid}; stack left running"
    return 0
  fi
  log WARN "no watchdog pid file and no unit; nothing to stop"
}

verify_action() {
  local rc=0
  log INFO "running the disposable-runtime binding verifier against real local Ollama"
  ( cd "$APP_DIR" && node scripts/verify-agent-binding.mjs ) || rc=1
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
  runtime_health || { log ERROR "live runtime /health is down; run: $0 start"; rc=1; }
  public_model_listed || { log ERROR "live /v1/models is missing $PUBLIC_MODEL"; rc=1; }
  if [ "$rc" -eq 0 ]; then
    DEEP=1
    check_generation || rc=1
  fi
  if [ "$rc" -eq 0 ]; then
    log INFO "verify complete: disposable and live paths both answer as $PUBLIC_MODEL"
  fi
  return "$rc"
}

opencode_action() {
  local rc=0 models
  ( cd "$APP_DIR" && node scripts/install-opencode-provider.mjs "$@" ) || rc=1
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
  # The background server caches configuration. Restarting it is harmless when
  # it is not running; the next `opencode` command starts it again.
  opencode service restart >/dev/null 2>&1 || true
  models="$(opencode models 2>/dev/null || true)"
  if printf '%s\n' "$models" | grep -qF "$OPENCODE_PROVIDER/$PUBLIC_MODEL"; then
    log INFO "OpenCode lists $OPENCODE_PROVIDER/$PUBLIC_MODEL"
  else
    log ERROR "OpenCode does not list $OPENCODE_PROVIDER/$PUBLIC_MODEL; run: opencode models"
    rc=1
  fi
  return "$rc"
}

# ------------------------------------------------------------------- parse ---
while [ $# -gt 0 ]; do
  case "$1" in
    status|once|start|watch|stop|install|uninstall|verify|opencode)
      ACTION="$1"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --deep) DEEP=1; shift ;;
    --no-default) EXTRA_ARGS+=("--no-default"); shift ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    *)
      if [ -z "$ACTION" ]; then
        printf 'unknown action: %s\n\n' "$1" >&2
        usage >&2
        exit 2
      fi
      EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if [ -z "$ACTION" ]; then
  usage >&2
  exit 2
fi

case "$ACTION" in
  status)
    status_rows
    exit $?
    ;;
  once)
    DEEP=1
    if check_all; then
      log INFO "stack healthy; no repair needed"
      exit 0
    fi
    heal
    exit $?
    ;;
  start)
    DEEP=1
    heal
    exit $?
    ;;
  watch)
    watch_loop
    ;;
  install)
    install_unit
    ;;
  uninstall)
    uninstall_unit
    ;;
  stop)
    stop_watch
    ;;
  verify)
    verify_action
    exit $?
    ;;
  opencode)
    opencode_action "${EXTRA_ARGS[@]}"
    exit $?
    ;;
esac
