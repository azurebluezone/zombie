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

Open the page, set **Base URL** (for example `http://127.0.0.1:9999` or
`https://runtime.example.com`) and the runtime's `ADMIN_TOKEN`, then **Connect**.

Both values are stored in this browser's `localStorage` only. Nothing is written to disk.

## Runtime side (one-time)

1. `ADMIN_TOKEN=<long random>` in the runtime `.env`; keep `LOOPBACK_AUTH_BYPASS=false`.
2. Add this page's origin to `CORS_ALLOW_ORIGINS` (comma separated, no wildcard):
   `CORS_ALLOW_ORIGINS=http://127.0.0.1:8088`
3. For remote use terminate TLS in front (nginx/Caddy) and expose only what you need.
   The runtime itself defaults to `127.0.0.1`.

## Pages

| Page | Endpoint(s) | What it proves |
| --- | --- | --- |
| Dashboard | `GET /health` | runtime identity, provider/agent counts, core module flags |
| Connection | `GET /health`, `GET /v1/admin/routes` | the URL is a runtime and the token is a real admin token |
| Providers | `GET /v1/admin/providers`, `PATCH /v1/admin/providers/{id}`, `POST /v1/admin/providers/{id}/test`, `POST …/health` | enable/disable persists server-side; the probe is one real completion |
| Models | `GET /v1/admin/models`, `POST /v1/admin/models/sync-all` | models exist only for providers whose API is on |
| Masking & Normalizer | `GET /v1/admin/masking-models`, `POST /v1/admin/normalizer/test` | each module (`response`, `stream`, `mask`) is testable alone |
| Tools | `GET /v1/admin/registry/tools` | registry status and consent flags |
| MCP | `GET /v1/admin/registry/external-mcp` | endpoint transport and reconciliation state |
| System | `GET /health`, `GET /v1/admin/routes` | declared vs live module flags, route inventory |

## Rules this UI follows

- A **green pill means live** in this session. Anything not fetched is shown as `–`, never as zero.
- Failures print the server's error code (for example `admin_unauthorized`), not "something went wrong".
- No fake catalog entries, no placeholder models, no CDN, no external images.
