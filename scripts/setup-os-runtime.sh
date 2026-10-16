#!/usr/bin/env bash
set -euo pipefail

# OS-level setup helper: no npm packages are installed. Node.js itself is required.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux* ]] || ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer currently supports Linux with systemd only. No changes made." >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then echo "Run with sudo to install a system service. No changes made." >&2; exit 2; fi
if [[ ! -f "$ROOT/src/server.js" || ! -f "$ROOT/package.json" ]]; then echo "Runtime source not found at $ROOT" >&2; exit 2; fi
node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
}
if ! node_version_ok; then
  echo "Node.js >=22.5.0 is required. Current: $(node --version 2>/dev/null || echo missing)." >&2
  echo "Install a supported Node.js release from the official Node.js distribution, then rerun. No runtime changes made." >&2
  exit 2
fi
read -r -p 'Runtime port [9999]: ' selected_port
selected_port="${selected_port:-9999}"
[[ "$selected_port" =~ ^[0-9]+$ ]] && (( selected_port >= 1 && selected_port <= 65535 )) || { echo "Invalid port; no changes made." >&2; exit 2; }
echo "Node.js $(node --version) validated; selected port=$selected_port"

cat <<'MENU'
ZombieCoder OS Runtime Setup
1) Chat-only: bind runtime to loopback; no reverse proxy setup
2) Prepare HTTPS reverse proxy with Nginx (tool execution remains disabled)
0) Cancel
MENU
read -r -p 'Choose [0/1/2]: ' choice
case "$choice" in
  0) echo "Cancelled; no changes made."; exit 0 ;;
  1) mode=chat-only; proxy_configured=false ;;
  2) mode=chat-only
     proxy_configured=true
     if ! command -v nginx >/dev/null 2>&1; then
       if command -v apt-get >/dev/null 2>&1; then
         read -r -p 'Nginx is missing. Install OS package nginx now? [y/N]: ' install_nginx
         if [[ "$install_nginx" =~ ^[Yy]$ ]]; then apt-get update && apt-get install -y nginx; else echo "Nginx not installed; no proxy config written."; exit 2; fi
       else echo "Install Nginx using your OS package manager, then rerun. No changes made." >&2; exit 2; fi
     fi
     read -r -p 'Public DNS hostname already pointing here: ' domain
     [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid hostname; no changes made." >&2; exit 2; }
     read -r -p 'Existing trusted TLS certificate full path: ' cert
     read -r -p 'Existing TLS private key full path: ' key
     [[ -r "$cert" && -r "$key" && "$cert" != *$'\n'* && "$key" != *$'\n'* && "$cert" != *\;* && "$key" != *\;* ]] || { echo "Readable certificate and key are required; no changes made." >&2; exit 2; }
     openssl x509 -in "$cert" -noout -checkhost "$domain" >/dev/null || { echo "Certificate hostname verification failed; no changes made." >&2; exit 2; }
     mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
     cat > "/etc/nginx/sites-available/zombiecoder.conf" <<NGINX
server {
  listen 443 ssl;
  server_name $domain;
  ssl_certificate $cert;
  ssl_certificate_key $key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 4m;
  location / {
    proxy_pass http://127.0.0.1:$selected_port;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
NGINX
     ln -sfn /etc/nginx/sites-available/zombiecoder.conf /etc/nginx/sites-enabled/zombiecoder.conf
     nginx -t
     systemctl reload nginx || systemctl restart nginx
     ;;
  *) echo "Invalid choice; no changes made." >&2; exit 2 ;;
esac

user_name="${SUDO_USER:-root}"
user_home="$(getent passwd "$user_name" | cut -d: -f6)"
[[ -n "$user_home" ]] || user_home=/root
service_file=/etc/systemd/system/zombiecoder-runtime.service
mkdir -p "$ROOT/data" "$ROOT/logs"
chown -R "$user_name" "$ROOT/data" "$ROOT/logs"
service_template="$ROOT/scripts/systemd/zombiecoder-runtime.service.template"
[[ -r "$service_template" ]] || { echo "Unit template not readable: $service_template. No changes made." >&2; exit 2; }
node_bin="$(command -v node)"
sed -e "s|{{USER}}|$user_name|g" \
    -e "s|{{ROOT}}|$ROOT|g" \
    -e "s|{{PORT}}|$selected_port|g" \
    -e "s|{{MODE}}|$mode|g" \
    -e "s|{{NODE}}|$node_bin|g" \
    "$service_template" > "$service_file"
# Fail closed instead of installing a unit with unresolved placeholders.
if grep -q '{{[A-Z_][A-Z_]*}}' "$service_file"; then
  echo "Unit rendering left unresolved placeholders; removing $service_file and aborting." >&2
  rm -f "$service_file"
  exit 2
fi
systemctl daemon-reload
systemctl enable --now zombiecoder-runtime.service
systemctl --no-pager --full status zombiecoder-runtime.service || true
cat <<EOF2

Installed service: zombiecoder-runtime.service
Configured mode: $mode (safe default; tool execution stays disabled)
Proxy configured: ${proxy_configured:-false}
Verification report command:
  cd "$ROOT" && ZC_VERIFY_URL=http://127.0.0.1:$selected_port node scripts/verify-deployment.mjs
EOF2
echo "Tool execution remains disabled. After TLS, authentication, chat, streaming, and a dedicated harmless tool-call test pass, edit $service_file: change ZOMBIECODER_EXECUTION_MODE=chat-only to tools-enabled; then run systemctl daemon-reload && systemctl restart zombiecoder-runtime."
