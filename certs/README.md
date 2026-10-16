# certs

Local TLS material for the runtime HTTPS transport. **No npm packages are
used** — certificates are produced with `openssl` only.

`server.key` and `server.crt` are git-ignored on purpose. Never commit a
private key.

## Generate a local development certificate

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/server.key -out certs/server.crt -days 825 \
  -subj "/C=BD/O=ZombieCoder Dev/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:$(hostname),IP:127.0.0.1,IP:::1" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 certs/server.key
chmod 644 certs/server.crt
```

## Enable in `.env`

```ini
HTTPS_ENABLED=true
HTTPS_HOST=127.0.0.1
HTTPS_PORT=10443
HTTPS_KEY=./certs/server.key
HTTPS_CERT=./certs/server.crt
```

## Verify

```bash
# private key and certificate must share one modulus
openssl x509 -noout -modulus -in certs/server.crt | openssl md5
openssl rsa  -noout -modulus -in certs/server.key | openssl md5

# probe the live listener (self-signed, so -k is expected locally)
curl -sk https://127.0.0.1:10443/health
```

A self-signed certificate is for loopback development only. Public clients
must go through a trusted TLS certificate (see
`scripts/nginx/zombiecoder.conf.template`).
