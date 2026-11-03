#!/usr/bin/env bash
#
# ZombieCoder Runtime — end-to-end installer.
#
# It clones or updates a checkout, guarantees Node 24, writes the deployment
# environment from the Ollama URL, installs/validates Caddy with local TLS,
# builds the runtime, starts the server, and checks health plus the local
# web-search transport and external MCP registration.
#
# It never overwrites provider API keys. Existing .env values are kept; only
# missing deployment values are filled and every write leaves a backup.
#
# Usage:
#   bash install.sh
#   ZC_DIR=$HOME/zombie bash install.sh
#   ZC_OLLAMA_URL=http://127.0.0.1:11434 bash install.sh
#   bash install.sh --no-start --no-caddy
#
# Environment:
#   ZC_DIR                 checkout directory (default: $HOME/zombie)
#   ZC_REPO                git remote (default: https://github.com/azurebluezone/zombie.git)
#   ZC_BRANCH              branch (default: main)
#   ZC_OLLAMA_URL          Ollama base URL (default: http://127.0.0.1:11434)
#   ZC_OLLAMA_MODEL        model to pin (default: first tools-capable model)
#   ZC_LLAMA_CPP_URL       llama.cpp OpenAI endpoint (default: http://127.0.0.1:9933/v1)
#   ZC_WEB_SEARCH_PORT     local transport port (default: 8091)
#   ZC_RUNTIME_PORT        runtime port (default: 9999)
#   ZC_ADMIN_UI_PORT       admin UI port (default: 8088)
#   ZC_CADDY_HTTPS_PORT    runtime TLS edge (default: 9443)
#   ZC_ADMIN_HTTPS_PORT    admin UI TLS edge (default: 9444)
#   ZC_SKIP_SYSTEM=1       never call apt
#   ZC_SKIP_CADDY=1        skip Caddy install/start
#   ZC_SKIP_WEB_SEARCH_CHECK=1  skip the outbound search probe
#   ZC_NO_START=1          install/build/configure but do not start services

set -euo pipefail

ZC_DIR="${ZC_DIR:-$HOME/zombie}"
ZC_REPO="${ZC_REPO:-https://github.com/azurebluezone/zombie.git}"
ZC_BRANCH="${ZC_BRANCH:-main}"
ZC_OLLAMA_URL="${ZC_OLLAMA_URL:-${OLLAMA_URL:-http://127.0.0.1:11434}}"
ZC_OLLAMA_MODEL="${ZC_OLLAMA_MODEL:-${OLLAMA_MODEL:-}}"
ZC_LLAMA_CPP_URL="${ZC_LLAMA_CPP_URL:-http://127.0.0.1:9933/v1}"
ZC_WEB_SEARCH_PORT="${ZC_WEB_SEARCH_PORT:-8091}"
ZC_RUNTIME_PORT="${ZC_RUNTIME_PORT:-9999}"
ZC_ADMIN_UI_PORT="${ZC_ADMIN_UI_PORT:-8088}"
ZC_CADDY_HTTPS_PORT="${ZC_CADDY_HTTPS_PORT:-9443}"
ZC_ADMIN_HTTPS_PORT="${ZC_ADMIN_HTTPS_PORT:-9444}"
ZC_SKIP_SYSTEM="${ZC_SKIP_SYSTEM:-0}"
ZC_SKIP_CADDY="${ZC_SKIP_CADDY:-0}"
ZC_SKIP_WEB_SEARCH_CHECK="${ZC_SKIP_WEB_SEARCH_CHECK:-0}"
ZC_NO_START="${ZC_NO_START:-0}"
ZC_NODE_HOME="${ZC_NODE_HOME:-$HOME/.local/share/zombiecoder/node}"
ZC_NODE_MAJOR=24

NO_START=0
NO_CADDY=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --no-caddy) NO_CADDY=1 ;;
    --help|-h)
      sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
did()  { printf '  [done] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*" >&2; }
die()  { printf '  [fail] %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zc-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

# ---------------------------------------------------------------------------------------
# 1. base tools and checkout
# ---------------------------------------------------------------------------------------

step '1. machine and checkout'

OS_ID='unknown'
OS_LIKE=''
if [[ -r /etc/os-release ]]; then
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
  OS_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
fi
ARCH_RAW="$(uname -m)"
say "  os=${OS_ID} (like: ${OS_LIKE:-none}) arch=${ARCH_RAW}"

CAN_SUDO=0
if [[ $EUID -eq 0 ]]; then CAN_SUDO=1
elif have sudo && sudo -n true 2>/dev/null; then CAN_SUDO=1
elif have sudo; then CAN_SUDO=1
fi

apt_install() {
  [[ "$ZC_SKIP_SYSTEM" == '1' ]] && { warn "ZC_SKIP_SYSTEM=1: not installing $*"; return 1; }
  [[ $CAN_SUDO -eq 1 ]] || { warn "no sudo: cannot install $*"; return 1; }
  case "$OS_ID $OS_LIKE" in
    *ubuntu*|*debian*) : ;;
    *) warn "unsupported distribution for apt_install ($*)"; return 1 ;;
  esac
  local runner=()
  [[ $EUID -ne 0 ]] && runner=(sudo)
  "${runner[@]}" apt-get update -qq
  DEBIAN_FRONTEND=noninteractive "${runner[@]}" apt-get install -y -qq "$@"
}

for tool in git curl; do
  if have "$tool"; then ok "$tool present"
  else
    apt_install "$tool" || warn "$tool is missing; continuing only if the checkout already exists"
  fi
done

is_checkout() { [[ -f "$1/package.json" && -f "$1/src/server.js" ]]; }

ROOT=''
if is_checkout "$PWD"; then
  ROOT="$PWD"
  ok "inside checkout: $ROOT"
elif is_checkout "$ZC_DIR"; then
  ROOT="$ZC_DIR"
  ok "existing checkout: $ROOT"
else
  have git || die 'git is required to clone the checkout'
  say "  cloning $ZC_REPO ($ZC_BRANCH) into $ZC_DIR"
  mkdir -p "$(dirname "$ZC_DIR")"
  git clone --branch "$ZC_BRANCH" "$ZC_REPO" "$ZC_DIR"
  ROOT="$ZC_DIR"
  did "cloned into $ROOT"
fi
cd "$ROOT"

GIT_OK=0
if have git && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_OK=1
  say "  current: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') on $(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
    warn 'working tree has local changes: fetch ran, merge skipped (nothing was discarded)'
    git -C "$ROOT" fetch --prune origin "$ZC_BRANCH" || warn 'git fetch failed; keeping the current checkout'
  else
    if git -C "$ROOT" fetch --prune origin "$ZC_BRANCH"; then
      if git -C "$ROOT" merge --ff-only "origin/$ZC_BRANCH"; then
        did "updated to $(git -C "$ROOT" rev-parse --short HEAD)"
      else
        warn "cannot fast-forward to origin/$ZC_BRANCH; keeping the current checkout"
      fi
    else
      warn 'git fetch failed; keeping the current checkout'
    fi
  fi
else
  warn 'not a git checkout; update step skipped'
fi

# ---------------------------------------------------------------------------------------
# 2. Node 24
# ---------------------------------------------------------------------------------------

step "2. Node.js ${ZC_NODE_MAJOR}"
node_major() { have node && node -p "process.versions.node.split('.')[0]" 2>/dev/null || true; }

if [[ "$(node_major)" == "$ZC_NODE_MAJOR" ]] || [[ -n "$(node_major)" && "$(node_major)" -gt "$ZC_NODE_MAJOR" ]]; then
  NODE_BIN="$(command -v node)"
  NODE_SOURCE=system
  ok "node $(node --version) at $NODE_BIN"
else
  warn "node $(node --version 2>/dev/null || echo 'not found') is older than ${ZC_NODE_MAJOR}; installing a user-level Node ${ZC_NODE_MAJOR}"
  case "$ARCH_RAW" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    armv7l) NODE_ARCH=armv7l ;;
    *) die "unsupported architecture for Node download: $ARCH_RAW" ;;
  esac
  NODE_BASE="https://nodejs.org/dist/latest-v${ZC_NODE_MAJOR}.x"
  if have xz; then NODE_EXT=tar.xz; else NODE_EXT=tar.gz; fi
  NODE_SUMS="$TMP_DIR/SHASUMS256.txt"
  curl -fsSL "$NODE_BASE/SHASUMS256.txt" -o "$NODE_SUMS" || die "cannot download Node checksums from $NODE_BASE"
  NODE_ARCHIVE="$(awk -v suffix="linux-${NODE_ARCH}.${NODE_EXT}" '$2 ~ suffix {print $2; exit}' "$NODE_SUMS")"
  [[ -n "$NODE_ARCHIVE" ]] || die "no Node ${ZC_NODE_MAJOR} archive for linux-${NODE_ARCH}"
  NODE_SUM="$(awk -v file="$NODE_ARCHIVE" '$2 == file {print $1; exit}' "$NODE_SUMS")"
  [[ -n "$NODE_SUM" ]] || die "checksum missing for $NODE_ARCHIVE"
  curl -fsSL "$NODE_BASE/$NODE_ARCHIVE" -o "$TMP_DIR/$NODE_ARCHIVE" || die "cannot download $NODE_ARCHIVE"
  (cd "$TMP_DIR" && printf '%s  %s\n' "$NODE_SUM" "$NODE_ARCHIVE" | sha256sum -c -) || die "Node checksum mismatch for $NODE_ARCHIVE"
  mkdir -p "$ZC_NODE_HOME"
  tar -xf "$TMP_DIR/$NODE_ARCHIVE" -C "$ZC_NODE_HOME"
  NODE_DIR="$ZC_NODE_HOME/${NODE_ARCHIVE%.tar.*}"
  ln -sfn "$NODE_DIR" "$ZC_NODE_HOME/current"
  export PATH="$ZC_NODE_HOME/current/bin:$PATH"
  NODE_BIN="$ZC_NODE_HOME/current/bin/node"
  NODE_SOURCE=downloaded
  did "node $("$NODE_BIN" --version) at $NODE_BIN"
fi
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<24) process.exit(1)' || die "Node 24 is required"
export PATH="$(dirname "$NODE_BIN"):$PATH"

# ---------------------------------------------------------------------------------------
# 3. Ollama model and llama.cpp probe
# ---------------------------------------------------------------------------------------

step '3. model endpoints'
OLLAMA_URL="${ZC_OLLAMA_URL%/}"
OLLAMA_MODEL="$ZC_OLLAMA_MODEL"
if [[ -z "$OLLAMA_MODEL" ]] && curl -fsS -m 5 "$OLLAMA_URL/api/tags" -o "$TMP_DIR/ollama-tags.json" 2>/dev/null; then
  OLLAMA_MODEL="$("$NODE_BIN" -e '
    const fs=require("fs");
    const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const models=Array.isArray(data.models)?data.models:[];
    const chosen=models.find(item=>(item.capabilities||[]).includes("tools"))||models[0];
    process.stdout.write(chosen?.name??"");
  ' "$TMP_DIR/ollama-tags.json")"
fi
if [[ -n "$OLLAMA_MODEL" ]]; then ok "ollama ${OLLAMA_URL} model=${OLLAMA_MODEL}"; else warn "ollama ${OLLAMA_URL} reachable but no model detected"; fi

LLAMA_CPP_OK=0
if curl -fsS -m 3 "$ZC_LLAMA_CPP_URL/models" -o "$TMP_DIR/llama-models.json" 2>/dev/null; then
  LLAMA_CPP_OK=1
  ok "llama.cpp ${ZC_LLAMA_CPP_URL} reachable"
else
  warn "llama.cpp ${ZC_LLAMA_CPP_URL} unreachable; Ollama becomes the active provider"
fi

# ---------------------------------------------------------------------------------------
# 4. environment
# ---------------------------------------------------------------------------------------

step '4. environment'
ENV_RESULT="$("$NODE_BIN" scripts/install-env.mjs \
  --root "$ROOT" \
  --ollama-url "$OLLAMA_URL" \
  --ollama-model "$OLLAMA_MODEL" \
  --llama-cpp-ok "$LLAMA_CPP_OK" \
  --runtime-port "$ZC_RUNTIME_PORT" \
  --web-search-port "$ZC_WEB_SEARCH_PORT" \
  --admin-ui-port "$ZC_ADMIN_UI_PORT" \
  --caddy-https-port "$ZC_CADDY_HTTPS_PORT" \
  --admin-https-port "$ZC_ADMIN_HTTPS_PORT")"
say "$ENV_RESULT"
ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$ROOT/.env" | head -n1)"
[[ -n "$ADMIN_TOKEN" ]] || die 'ADMIN_TOKEN was not written to .env'
ok ".env ready (provider keys untouched)"

# ---------------------------------------------------------------------------------------
# 5. Caddy and TLS
# ---------------------------------------------------------------------------------------

step '5. Caddy and TLS'
CADDY_BIN="${CADDY_BIN:-$(command -v caddy 2>/dev/null || true)}"
if [[ -z "$CADDY_BIN" && -x "$HOME/.local/bin/caddy" ]]; then CADDY_BIN="$HOME/.local/bin/caddy"; fi
if [[ "$ZC_SKIP_CADDY" == '1' || "$NO_CADDY" == '1' ]]; then
  warn 'Caddy step skipped by request'
elif [[ -n "$CADDY_BIN" ]]; then
  ok "caddy $("$CADDY_BIN" version | head -n1)"
else
  case "$ARCH_RAW" in
    x86_64|amd64) CADDY_ARCH=amd64 ;;
    aarch64|arm64) CADDY_ARCH=arm64 ;;
    *) die "unsupported architecture for Caddy: $ARCH_RAW" ;;
  esac
  mkdir -p "$HOME/.local/bin"
  say "  downloading Caddy for linux-${CADDY_ARCH}"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}" -o "$HOME/.local/bin/caddy" || die 'Caddy download failed'
  chmod +x "$HOME/.local/bin/caddy"
  CADDY_BIN="$HOME/.local/bin/caddy"
  "$CADDY_BIN" version >/dev/null || die 'downloaded Caddy is not executable'
  did "caddy $("$CADDY_BIN" version | head -n1)"
fi

export ZC_RUNTIME_PORT ZC_ADMIN_UI_PORT ZC_CADDY_HTTPS_PORT ZC_ADMIN_HTTPS_PORT
export ADMIN_UI_PORT="$ZC_ADMIN_UI_PORT"
export ADMIN_UI_HOST=127.0.0.1
export WEB_SEARCH_TRANSPORT_HOST=127.0.0.1
export WEB_SEARCH_TRANSPORT_PORT="$ZC_WEB_SEARCH_PORT"
if [[ -n "$CADDY_BIN" && "$ZC_SKIP_CADDY" != '1' && "$NO_CADDY" != '1' ]]; then
  "$CADDY_BIN" validate --config deploy/caddy/Caddyfile.runtime --adapter caddyfile >/dev/null || die 'Caddyfile validation failed'
  ok 'Caddyfile validates'
fi

# ---------------------------------------------------------------------------------------
# 6. stop old processes, purge build logs, build
# ---------------------------------------------------------------------------------------

step '6. build'

stop_pidfile() {
  local file="$1" expected="$2" label="$3"
  [[ -f "$file" ]] || return 0
  local pid
  pid="$(tr -dc '0-9' < "$file" | head -c 12)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"
    return 0
  fi
  local cmd
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [[ "$cmd" != *"$expected"* ]]; then
    warn "$label pid $pid does not look like $expected; removing the stale pid file only"
    rm -f "$file"
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then warn "$label pid $pid did not stop"; else rm -f "$file"; fi
}

stop_pidfile "$ROOT/.zombiecoder-runtime.pid" 'src/server.js' 'runtime'
stop_pidfile "$ROOT/data/caddy.pid" 'caddy' 'caddy'
stop_pidfile "$ROOT/data/admin-ui.pid" 'serve.mjs' 'admin-ui'
stop_pidfile "$ROOT/data/web-search-mcp.pid" 'web-search-mcp-server.mjs' 'web-search'

if [[ -f "$ROOT/.zombiecoder-runtime.pid" ]]; then
  die 'runtime PID file still exists after stop; inspect it before building'
fi

find "$ROOT/logs" -maxdepth 1 -type f \( -name 'build-*.log' -o -name 'build.log' \) -delete 2>/dev/null || true
find "$ROOT/data" -maxdepth 1 -type f -name 'build-*.json' -delete 2>/dev/null || true
find "$ROOT/dist" -maxdepth 1 -type f -name '*.log' -delete 2>/dev/null || true
ok 'old build logs purged (runtime audit logs kept)'

"$NODE_BIN" scripts/build-runtime.mjs --output dist/zombiecoder-runtime > "$TMP_DIR/build.json" || die 'build failed'
"$NODE_BIN" -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(value.verified!==true||!value.files) process.exit(1);
  process.stdout.write(`verified files=${value.files} syntax=${value.syntaxChecks}\n`);
' "$TMP_DIR/build.json" || die 'build output did not verify'
ok "fresh build: dist/zombiecoder-runtime"

# ---------------------------------------------------------------------------------------
# 7. start services and verify
# ---------------------------------------------------------------------------------------

step '7. start and verify'
mkdir -p "$ROOT/logs" "$ROOT/data"

# nohup alone survives a terminal hang-up, not a process-group kill. The
# installer is often run from a CI shell or an agent runner that kills its
# group, so give every service its own session. `setsid` may fork, so the PID is
# written from inside the new session; `$!` would point at a dead wrapper.
start_detached() {
  local pidfile="$1" logfile="$2" cwd="$3"; shift 3
  if have setsid; then
    ( cd "$cwd" && setsid sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$pidfile" "$@" > "$logfile" 2>&1 < /dev/null & )
  else
    ( cd "$cwd" && nohup "$@" > "$logfile" 2>&1 < /dev/null & echo $! > "$pidfile" )
  fi
}

start_web_search() {
  if curl -fsS -m 2 "http://127.0.0.1:$ZC_WEB_SEARCH_PORT/health" >/dev/null 2>&1; then
    ok "web-search transport already on 127.0.0.1:$ZC_WEB_SEARCH_PORT"
    return 0
  fi
  start_detached "$ROOT/data/web-search-mcp.pid" "$ROOT/logs/web-search-mcp.log" "$ROOT" "$NODE_BIN" scripts/web-search-mcp-server.mjs
  for _ in $(seq 1 50); do
    if curl -fsS -m 2 "http://127.0.0.1:$ZC_WEB_SEARCH_PORT/health" >/dev/null 2>&1; then
      ok "web-search transport on 127.0.0.1:$ZC_WEB_SEARCH_PORT"
      return 0
    fi
    sleep 0.2
  done
  tail -n 20 "$ROOT/logs/web-search-mcp.log" >&2 || true
  die 'web-search transport did not become healthy'
}

start_admin_ui() {
  if curl -fsS -m 2 "http://127.0.0.1:$ZC_ADMIN_UI_PORT/" >/dev/null 2>&1; then
    ok "admin UI already on 127.0.0.1:$ZC_ADMIN_UI_PORT"
    return 0
  fi
  start_detached "$ROOT/data/admin-ui.pid" "$ROOT/logs/admin-ui.log" "$ROOT/admin-ui" "$NODE_BIN" serve.mjs
  for _ in $(seq 1 50); do
    if curl -fsS -m 2 "http://127.0.0.1:$ZC_ADMIN_UI_PORT/" >/dev/null 2>&1; then
      ok "admin UI on 127.0.0.1:$ZC_ADMIN_UI_PORT"
      return 0
    fi
    sleep 0.2
  done
  tail -n 20 "$ROOT/logs/admin-ui.log" >&2 || true
  die 'admin UI did not become healthy'
}

start_runtime() {
  if curl -fsS -m 2 "http://127.0.0.1:$ZC_RUNTIME_PORT/health" >/dev/null 2>&1; then
    ok "runtime already on 127.0.0.1:$ZC_RUNTIME_PORT"
    return 0
  fi
  start_detached "$ROOT/data/runtime-launch.pid" "$ROOT/logs/runtime.out" "$ROOT" "$NODE_BIN" start.js
  for _ in $(seq 1 100); do
    if curl -fsS -m 2 "http://127.0.0.1:$ZC_RUNTIME_PORT/health" >/dev/null 2>&1; then
      ok "runtime on 127.0.0.1:$ZC_RUNTIME_PORT"
      return 0
    fi
    sleep 0.2
  done
  tail -n 40 "$ROOT/logs/runtime.out" >&2 || true
  die 'runtime did not become healthy'
}

caddy_ca() {
  local candidates=(
    "${XDG_DATA_HOME:-$HOME/.local/share}/caddy/pki/authorities/local/root.crt"
    "$HOME/.local/share/caddy/pki/authorities/local/root.crt"
  )
  local file
  for file in "${candidates[@]}"; do
    if [[ -s "$file" ]]; then printf '%s\n' "$file"; return 0; fi
  done
  return 1
}

start_caddy() {
  if [[ -z "$CADDY_BIN" || "$ZC_SKIP_CADDY" == '1' || "$NO_CADDY" == '1' ]]; then return 0; fi
  if curl -fsS --cacert "$(caddy_ca 2>/dev/null || true)" -m 3 "https://localhost:$ZC_CADDY_HTTPS_PORT/health" >/dev/null 2>&1; then
    ok "Caddy TLS already on https://localhost:$ZC_CADDY_HTTPS_PORT"
    return 0
  fi
  start_detached "$ROOT/data/caddy.pid" "$ROOT/logs/caddy.log" "$ROOT" "$CADDY_BIN" run --config "$ROOT/deploy/caddy/Caddyfile.runtime" --adapter caddyfile
  local ca=''
  for _ in $(seq 1 100); do
    ca="$(caddy_ca 2>/dev/null || true)"
    if [[ -n "$ca" ]] && curl -fsS --cacert "$ca" -m 3 "https://localhost:$ZC_CADDY_HTTPS_PORT/health" >/dev/null 2>&1; then
      ok "Caddy TLS verified with the internal CA: https://localhost:$ZC_CADDY_HTTPS_PORT"
      return 0
    fi
    sleep 0.2
  done
  tail -n 30 "$ROOT/logs/caddy.log" >&2 || true
  die 'Caddy TLS did not become healthy'
}

start_web_search
start_admin_ui
start_runtime
start_caddy

if [[ "$ZC_NO_START" != '1' && "$NO_START" != '1' ]]; then
  HEALTH="$("$NODE_BIN" -e '
    const url=process.argv[1];
    const response=await fetch(url);
    const body=await response.json();
    if(response.status!==200||body.ok!==true) process.exit(1);
    const web=body.webSearch||{};
    process.stdout.write(`ok externalMcp=${body.externalMcp?.registered??0} webSearch=${web.configured===true?"configured":"missing"}`);
  ' "http://127.0.0.1:$ZC_RUNTIME_PORT/health")" || die 'health check failed'
  ok "health: $HEALTH"

  curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" "http://127.0.0.1:$ZC_RUNTIME_PORT/v1/admin/registry/external-mcp/sync" -X POST -H 'content-type: application/json' -d '{}' > "$TMP_DIR/mcp-sync.json" || warn 'external MCP sync request failed'
  "$NODE_BIN" -e '
    const fs=require("fs");
    const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const endpoints=Array.isArray(data.endpoints)?data.endpoints:[];
    const server=(data.servers||[]).find(item=>item.id==="web-search");
    const endpoint=endpoints.find(item=>item.id==="web-search");
    if(!server||!endpoint||endpoint.status!=="discovered") {
      console.error(JSON.stringify({server:server??null,endpoint:endpoint??null},null,2));
      process.exit(1);
    }
    process.stdout.write(`external_mcp=web-search tools=${(endpoint.tools||[]).length} protocol=${endpoint.protocolVersion??"?"}`);
  ' "$TMP_DIR/mcp-sync.json" > "$TMP_DIR/mcp-check.txt" || die 'web-search external MCP endpoint was not discovered'
  ok "$(cat "$TMP_DIR/mcp-check.txt")"

  if [[ "$ZC_SKIP_WEB_SEARCH_CHECK" != '1' ]]; then
    curl -fsS -m 20 "http://127.0.0.1:$ZC_WEB_SEARCH_PORT/search?q=Node.js&limit=3" -o "$TMP_DIR/search.json" || die 'web-search transport returned an error'
    "$NODE_BIN" -e '
      const fs=require("fs");
      const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if(!Array.isArray(data.results)||data.results.length<1) process.exit(1);
      process.stdout.write(`web_search=ok results=${data.results.length} first=${data.results[0].url}`);
    ' "$TMP_DIR/search.json" || die 'web-search returned no results'
    ok "$(cat "$TMP_DIR/search.json" >/dev/null; "$NODE_BIN" -e 'const d=require(process.argv[1]);process.stdout.write(`web_search=ok results=${d.results.length} first=${d.results[0].url}`)' "$TMP_DIR/search.json")"
  fi

  if [[ -n "$CADDY_BIN" && "$ZC_SKIP_CADDY" != '1' && "$NO_CADDY" != '1' ]]; then
    CA="$(caddy_ca 2>/dev/null || true)"
    [[ -n "$CA" ]] || die 'Caddy internal CA root not found'
    curl -fsS --cacert "$CA" "https://localhost:$ZC_CADDY_HTTPS_PORT/health" >/dev/null || die 'runtime TLS edge failed'
    curl -fsS --cacert "$CA" "https://localhost:$ZC_ADMIN_HTTPS_PORT/" >/dev/null || die 'admin UI TLS edge failed'
    ok "TLS edges verified: runtime 9443, admin 9444"
  fi
fi

step '8. summary'
say "  checkout:  $ROOT"
say "  node:      $("$NODE_BIN" --version) ($NODE_SOURCE)"
say "  model:     ${OLLAMA_MODEL:-not detected}"
say "  runtime:   http://127.0.0.1:$ZC_RUNTIME_PORT"
say "  admin UI:  http://127.0.0.1:$ZC_ADMIN_UI_PORT"
say "  web search: http://127.0.0.1:$ZC_WEB_SEARCH_PORT/search"
say "  MCP:       http://127.0.0.1:$ZC_WEB_SEARCH_PORT/mcp"
say "  build:     dist/zombiecoder-runtime"
say ''
ok 'INSTALL_OK'
