# ZombieCoder Admin (third-party UI)

A standalone console for a ZombieCoder runtime, shipped as `admin-ui/` so it survives with the
repository. It is **not** part of the runtime:

- no build step inside the runtime, no shared modules, no server-side include
- the runtime never reads this folder; deleting it changes nothing server-side
- the build script does not copy it into `dist/`; `tests/phase61-api-only-ui-contract.test.js` pins that
- every value on screen comes from an HTTP response, entered through **Base URL + admin token**

## Run

```bash
node serve.mjs            # http://127.0.0.1:8088
ADMIN_UI_PORT=9000 node serve.mjs
```

Keep it running across reboots with the reference unit:

```bash
sudo cp zombiecoder-admin-ui.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now zombiecoder-admin-ui
```

Open the page, set **Base URL** (for example `http://127.0.0.1:9999` or
`https://runtime.example.com`) and the runtime's `ADMIN_TOKEN`, then **Connect**.

Both values are stored in this browser's `localStorage` only. Nothing is written to disk.

## Runtime side (one-time)

1. `ADMIN_TOKEN=<long random>` in the runtime `.env`; keep `LOOPBACK_AUTH_BYPASS=false`.
2. Add this page's origin to `CORS_ALLOW_ORIGINS` (comma separated, no wildcard):
   `CORS_ALLOW_ORIGINS=http://127.0.0.1:8088`
3. For remote use terminate TLS in front (nginx/Caddy) and expose only what you need.
   The runtime itself defaults to `127.0.0.1`.

## Remote access (shipped nginx config)

`deploy/nginx/zombiecoder-admin.conf` is the exact edge this project runs: TLS on
`8443`, HTTP on `8080` redirecting to it, `/admin-ui/` proxied to the loopback
static server, and `/v1/admin/` capped at 10 r/s per address (burst 30, `429`).
It never reads files from the home directory and never writes its own CORS header.

```bash
sudo ./deploy/nginx/make-cert.sh 192.168.1.144
sudo cp deploy/nginx/zombiecoder-admin.conf /etc/nginx/sites-available/zombiecoder-admin
sudo ln -sf /etc/nginx/sites-available/zombiecoder-admin /etc/nginx/sites-enabled/zombiecoder-admin
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Then add the real origin to the runtime allowlist and restart it:

```bash
CORS_ALLOW_ORIGINS=https://192.168.1.144:8443,http://127.0.0.1:8088
```

Open `https://192.168.1.144:8443/admin-ui/`, set Base URL to the same origin
(`https://192.168.1.144:8443`) and paste `ADMIN_TOKEN`. The certificate is
self-signed, so pin it once (`curl --cacert`) or accept the browser warning.

Boundary evidence: `ss -lntp` shows the runtime on `127.0.0.1:9999`/`10443` only,
nginx on `8080`/`8443`; `tests/phase62-remote-admin-edge.test.js` pins TLS,
loopback upstream, the rate limit and the absence of an edge-level CORS header.

## Pages

| Page | Endpoint(s) | What it proves |
| --- | --- | --- |
| Dashboard | `GET /health` | runtime identity, provider/agent counts, core module flags |
| Connection | `GET /health`, `GET /v1/admin/routes` | the URL is a runtime and the token is a real admin token |
| Providers | `GET /v1/admin/providers`, `POST/PATCH /v1/admin/providers…`, `POST /v1/admin/providers/{id}/test`, `POST …/health` | key presence as `env · fingerprint` (never the key), add/edit persists server-side, the probe is one real completion |
| Models | `GET /v1/admin/models`, `GET /v1/admin/model-tests`, `POST /v1/admin/models/sync-all` | models exist only for providers whose API is on; every probe's latency is persisted and survives a restart |
| Masking & Normalizer | `GET /v1/admin/masking-models`, `POST /v1/admin/normalizer/test` | each module (`response`, `stream`, `mask`) is testable alone |
| Agents & Personas | `GET /v1/admin/agents`, `GET/POST/PATCH/DELETE /v1/admin/personas…`, `PUT/DELETE /v1/admin/agent-model-mappings/{id}` | the registry/persona/mapping join, and which model actually serves an agent |
| Tools | `GET /v1/admin/registry/tools` | registry status and consent flags |
| MCP | `GET /v1/admin/registry/external-mcp` | endpoint transport and reconciliation state |
| System | `GET /health`, `GET /v1/admin/routes` | declared vs live module flags, route inventory |

## Rules this UI follows

- A **green pill means live** in this session. Anything not fetched is shown as `–`, never as zero.
- Failures print the server's error code (for example `admin_unauthorized`), not "something went wrong".
- No fake catalog entries, no placeholder models, no CDN, no external images.
