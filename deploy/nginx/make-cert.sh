#!/usr/bin/env bash
# Self-signed TLS for the admin front door, with the LAN IP in subjectAltName so
# a client can pin the certificate and still verify the address it dialled.
# Usage: sudo ./make-cert.sh [host-or-ip] [out-dir]
set -euo pipefail
HOST="${1:-$(hostname -I | awk '{print $1}')}"
OUT="${2:-/etc/nginx/certs}"
mkdir -p "$OUT"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
  -keyout "$OUT/zombiecoder.key" -out "$OUT/zombiecoder.crt" \
  -subj "/CN=${HOST}/O=ZombieCoder" \
  -addext "subjectAltName=IP:${HOST},IP:127.0.0.1,DNS:localhost"
chown root:www-data "$OUT/zombiecoder.key" "$OUT/zombiecoder.crt"
chmod 640 "$OUT/zombiecoder.key"
chmod 644 "$OUT/zombiecoder.crt"
openssl x509 -in "$OUT/zombiecoder.crt" -noout -subject -ext subjectAltName -enddate
