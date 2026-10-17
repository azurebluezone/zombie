#!/usr/bin/env bash
#
# ZombieCoder Runtime — fresh-machine bootstrap.
#
# The point of this script is a reinstalled OS. After a fresh Ubuntu install there is no
# Node, no checkout, no .env and no service — and doing those four things by hand is the
# part people get wrong. This finds what already exists, installs only what is missing,
# and never overwrites anything it did not create.
#
# Usage
# -----
#   From inside a checkout:      bash scripts/bootstrap.sh
#   From a bare machine:         curl -fsSL <raw-url>/scripts/bootstrap.sh | bash
#   Into a chosen directory:     ZC_DIR=$HOME/zombie bash scripts/bootstrap.sh
#   Non-interactive (no sudo):   ZC_SKIP_SYSTEM=1 bash scripts/bootstrap.sh
#
# Environment
# -----------
#   ZC_DIR          where the checkout lives / should be cloned (default: $HOME/zombie)
#   ZC_REPO         git remote (default: https://github.com/azurebluezone/zombie.git)
#   ZC_BRANCH       branch to check out (default: main)
#   ZC_SKIP_SYSTEM  1 = never call apt (for machines where you install packages yourself)
#   ZC_NO_START     1 = do not offer to start the runtime at the end
#
# What it will not do
# -------------------
#   - It will not edit an existing .env. It creates one only if none exists.
#   - It will not run git reset/clean or discard local work.
#   - It will not open the runtime to the network: it binds loopback and leaves
#     ZOMBIECODER_EXECUTION_MODE alone.
#   - It will not install a systemd unit. That is scripts/setup-os-runtime.sh, which is
#     deliberate about being root-only and explicit about what it changes.

set -euo pipefail

ZC_DIR="${ZC_DIR:-$HOME/zombie}"
ZC_REPO="${ZC_REPO:-https://github.com/azurebluezone/zombie.git}"
ZC_BRANCH="${ZC_BRANCH:-main}"
ZC_SKIP_SYSTEM="${ZC_SKIP_SYSTEM:-0}"
ZC_NO_START="${ZC_NO_START:-0}"
REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=5

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
did()  { printf '  [done] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*" >&2; }
die()  { printf '  [fail] %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------------------
# 1. what kind of machine is this
# ---------------------------------------------------------------------------------------

step '1. inspecting the machine'

OS_ID='unknown'
OS_LIKE=''
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
  OS_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
fi
ARCH="$(uname -m)"
say "  os=${OS_ID} (like: ${OS_LIKE:-none}) arch=${ARCH} kernel=$(uname -s)"
case "$OS_ID $OS_LIKE" in
  *ubuntu*|*debian*) ok 'a Debian-family system: apt is available for system packages' ;;
  *) warn "not a Debian-family system; system packages will not be installed automatically" ;;
esac

CAN_SUDO=0
if [[ $EUID -eq 0 ]]; then CAN_SUDO=1
elif have sudo && sudo -n true 2>/dev/null; then CAN_SUDO=1
elif have sudo; then CAN_SUDO=1   # password will be asked only if apt is actually needed
fi
say "  running as: $(id -un) · sudo available: $([[ $CAN_SUDO -eq 1 ]] && echo yes || echo no) · skip-system=${ZC_SKIP_SYSTEM}"

apt_install() {
  # Install system packages only when they are actually missing.
  [[ "$ZC_SKIP_SYSTEM" == '1' ]] && { warn "ZC_SKIP_SYSTEM=1: not installing $*"; return 1; }
  [[ $CAN_SUDO -eq 1 ]] || { warn "no sudo: cannot install $*"; return 1; }
  case "$OS_ID $OS_LIKE" in
    *ubuntu*|*debian*) : ;;
    *) warn "unsupported distribution for apt_install ($*)"; return 1 ;;
  esac
  local runner=()
  [[ $EUID -ne 0 ]] && runner=(sudo)
  say "  installing system packages: $*"
  "${runner[@]}" apt-get update -qq
  DEBIAN_FRONTEND=noninteractive "${runner[@]}" apt-get install -y -qq "$@"
}

# ---------------------------------------------------------------------------------------
# 2. git and curl
# ---------------------------------------------------------------------------------------

step '2. git and curl'
for tool in git curl; do
  if have "$tool"; then ok "$tool $( "$tool" --version 2>/dev/null | head -1 )"
  else
    apt_install "$tool" || die "$tool is required and could not be installed"
    have "$tool" && did "$tool installed"
  fi
done

# ---------------------------------------------------------------------------------------
# 3. Node.js >= 22.5
# ---------------------------------------------------------------------------------------

node_is_ok() {
  have node || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>${REQUIRED_NODE_MAJOR}||(a===${REQUIRED_NODE_MAJOR}&&b>=${REQUIRED_NODE_MINOR})?0:1)" 2>/dev/null
}

step "3. Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}"
if node_is_ok; then
  ok "node $(node --version) at $(command -v node)"
else
  warn "node $(node --version 2>/dev/null || echo 'not found') is not new enough"
  if have nvm || [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    say '  an existing nvm was found: installing the current LTS through it'
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install --lts >/dev/null
    nvm use --lts >/dev/null
  else
    say '  installing nvm (user-level, no sudo, no system-wide change)'
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install --lts >/dev/null
    nvm use --lts >/dev/null
  fi
  node_is_ok || die "node is still not >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} after installing nvm's LTS"
  did "node $(node --version) via nvm ($NVM_DIR)"
  warn "nvm lives in your shell profile; open a new terminal (or 'source \$NVM_DIR/nvm.sh') before running npm by hand"
fi
NODE_BIN="$(command -v node)"
say "  npm $(npm --version 2>/dev/null || echo 'not found')"

# ---------------------------------------------------------------------------------------
# 4. the checkout
# ---------------------------------------------------------------------------------------

step '4. the checkout'

is_checkout() { [[ -f "$1/package.json" && -f "$1/src/server.js" ]]; }

ROOT=''
if is_checkout "$PWD"; then
  ROOT="$PWD"
  ok "already inside a checkout: $ROOT"
elif is_checkout "$ZC_DIR"; then
  ROOT="$ZC_DIR"
  ok "found an existing checkout at $ROOT"
else
  say "  no checkout found; cloning $ZC_REPO ($ZC_BRANCH) into $ZC_DIR"
  mkdir -p "$(dirname "$ZC_DIR")"
  git clone --branch "$ZC_BRANCH" --depth 1 "$ZC_REPO" "$ZC_DIR"
  ROOT="$ZC_DIR"
  did "cloned into $ROOT"
fi
cd "$ROOT"
say "  version: $(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo '?')"
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  say "  commit: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') on $(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
fi

# ---------------------------------------------------------------------------------------
# 5. directories and .env
# ---------------------------------------------------------------------------------------

step '5. runtime directories and configuration'
for dir in data logs certs; do
  if [[ -d "$ROOT/$dir" ]]; then ok "$dir/ exists"
  else mkdir -p "$ROOT/$dir"; did "$dir/ created"
  fi
done

if [[ -f "$ROOT/.env" ]]; then
  ok '.env exists — left untouched (this script never rewrites your configuration)'
else
  if [[ -f "$ROOT/.env.example" ]]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    did '.env created from .env.example'
    warn 'no provider API key is set yet: put one in .env (see the "Providers" section) or the runtime will start with no route'
  else
    warn '.env.example is missing; skipping .env creation'
  fi
fi

# ---------------------------------------------------------------------------------------
# 6. dependencies
# ---------------------------------------------------------------------------------------

step '6. dependencies'
if node -e "const p=require('./package.json');process.exit((Object.keys(p.dependencies||{}).length+Object.keys(p.optionalDependencies||{}).length)>0?0:1)"; then
  say '  package.json declares dependencies: running npm install'
  npm install --no-audit --no-fund
  did 'npm install finished'
else
  ok 'package.json declares no runtime dependencies — the runtime is dependency-free, nothing to install'
fi

# ---------------------------------------------------------------------------------------
# 7. verification (before claiming success)
# ---------------------------------------------------------------------------------------

step '7. verification'
node --check src/server.js && ok 'src/server.js parses'
node --check start.js && ok 'start.js parses'
node -e "
const [a,b]=process.versions.node.split('.').map(Number);
if(!(a>${REQUIRED_NODE_MAJOR}||(a===${REQUIRED_NODE_MAJOR}&&b>=${REQUIRED_NODE_MINOR}))){console.error('node too old');process.exit(1)}
" && ok "node $(node --version) satisfies engines >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}"

# The browser is optional, but discovering it now saves a confusing failure later.
if node -e "
import('./src/browser/cdp-pipe.js').then(m=>{const c=m.discoverChrome();console.log('  [ok]   browser found: '+c.path+' (source: '+c.source+')')})
  .catch(e=>{console.log('  [warn] no Chromium browser found for the optional CDP pipe: '+String(e.message).slice(0,90));process.exit(0)})
" 2>/dev/null; then :; else warn 'browser check skipped'; fi

say ''
say '  running the test suite is a good next step, but it takes a minute:'
say "    cd $ROOT && npm test"

# ---------------------------------------------------------------------------------------
# 8. what to do next
# ---------------------------------------------------------------------------------------

step '8. next steps'
cat <<EOF

  Everything below is yours to run — this script does not start a background service.

  1) put a provider key in .env, for example:
       OLLAMA_API_KEY=...        # fallback for providers whose driver is ollama
       PROVIDER_KEY_GROQ=...     # an explicit per-provider key always wins
  2) start it:
       cd $ROOT && npm start
  3) check it:
       curl -s http://127.0.0.1:9999/health
  4) open the console:  http://127.0.0.1:9999/admin/
     and the normal-person chat page:  http://127.0.0.1:9999/chat

  Optional, and deliberate about being root-only:
       sudo bash scripts/setup-os-runtime.sh    # install as a systemd service

  The runtime binds 127.0.0.1 only. Do not put it behind a public reverse proxy:
  the admin API trusts loopback callers without a token.

EOF

if [[ "$ZC_NO_START" != '1' ]] && [[ -t 0 ]]; then
  read -r -p 'Start the runtime now? [y/N] ' start_now || true
  if [[ "${start_now:-}" =~ ^[Yy]$ ]]; then
    say '  starting; Ctrl-C stops it'
    exec "$NODE_BIN" start.js
  fi
fi

ok "bootstrap finished for $ROOT"
