# ZombieCoder Runtime — Evidence-First Foundation

**Important: this repository and its documentation do not claim 100% correctness or complete compatibility with every provider/client.** The architecture is intended to provide a provider-neutral OpenAI-compatible interface and a truthful execution lifecycle. Some capabilities may be implemented or locally tested without being live-verified against real third-party providers and clients.

Before deployment, inspect the exact build, `.env.example`, provider adapters, database schema, and verification report. Never treat a planning document, fixture test, model-list entry, or successful `/health` response as proof that authentication, inference, streaming, tool calling, TLS, and end-to-end client integration all work.

## Native tools (Phase 47)

Native workspace tools are registered in `src/tools/common-defaults.js` and implemented under `tools/common/`. Tool calling is permissioned by application, task policy, execution consent, and project-root boundaries. Models without advertised native function calling may return one strict JSON tool-request envelope; this is a request only, never permission. Web search, external page fetch, and sub-agent delegation are intentionally marked `NOT_IMPLEMENTED`. See [Add New Tool Contract](docs/ADD-NEW-TOOL.md).

## Documentation

The documentation tree contains [runtime logging and diagnostics](docs/OBSERVABILITY.md). The planning and verification documents that earlier revisions referenced — the documentation index, execution planning, local agent planning, compatibility records, architecture decisions, the "Add New Tool Contract" note, and the Phase 31/46/48/49 gate notes — are **not present** in this tree, and `IMPLEMENTATION_MANIFEST.md` refers to some of them too. Do not cite a document that is not in the archive. Documentation is not a runtime dependency; for the exact behaviour of this build, read the source, `.env.example`, `IMPLEMENTATION_MANIFEST.md` and the test suite under `tests/`.

## Verification vocabulary

- **Intended** — design goal only.
- **Implemented** — code exists in a named build; correctness is not implied.
- **Locally tested** — a local test passed; live compatibility is not implied.
- **Live verified** — an identified real endpoint/client passed a recorded test.
- **Not verified** — evidence is missing or incomplete.

## Run local tests

```bash
cp .env.example .env
npm test
npm start
```

Do not commit `.env`, API keys, tunnel tokens, private keys, or other credentials. Keep runtime credentials out of documentation and version control.

## Runtime logging

The runtime writes structured JSONL logs with request/trace correlation, severity levels, rotation, and sensitive-data filtering. See [Runtime logs and diagnostics](docs/OBSERVABILITY.md) for configuration, privacy guidance, and troubleshooting commands.

## Build a package and run several instances side by side

The build is zero-dependency and self-contained. It copies runtime sources only, excludes `.env`, `data/`, `logs/`, `tests/` and secrets, and refuses to replace an output directory it does not manage — or one that is currently running an instance.

```bash
npm run build                                            # ./dist/zombiecoder-runtime
node scripts/build-runtime.mjs --output dist/zc-10001    # an independent second instance
```

Every output directory is a complete runtime. Run one build per instance and keep that instance's configuration, certificates, database and logs **outside** the build output, so rebuilding or replacing the code cannot erase them:

```bash
# 1. one build per instance — the output is disposable code
node scripts/build-runtime.mjs --output dist/zc-10001

# 2. instance state, outside the build output
mkdir -p instances/zc-10001/certs instances/zc-10001/data instances/zc-10001/logs
cp .env.example instances/zc-10001/.env
#   in instances/zc-10001/.env set, for example:
#     PORT=10001                            HTTPS_PORT=10444
#     DATA_DIR=/home/me/zombiecoder/instances/zc-10001/data
#     SQLITE_PATH=/home/me/zombiecoder/instances/zc-10001/data/runtime.sqlite
#     LOG_DIR=/home/me/zombiecoder/instances/zc-10001/logs
#     UDS_PATH=/home/me/zombiecoder/instances/zc-10001/data/runtime.sock
#     HTTPS_KEY=/home/me/zombiecoder/instances/zc-10001/certs/server.key
#     HTTPS_CERT=/home/me/zombiecoder/instances/zc-10001/certs/server.crt
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout instances/zc-10001/certs/server.key -out instances/zc-10001/certs/server.crt \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

# 3. start it — the launcher and the server read the same file
cd dist/zc-10001
ENV_FILE=/home/me/zombiecoder/instances/zc-10001/.env node start.js   # stop: node start.js --stop
```

`ENV_FILE` must point at the same file in both roles: `start.js` and `src/server.js` resolve it identically, so the port the launcher binds is the port the server uses. With the configuration left inside the build output instead, plain relative paths (`./data`, `./certs/server.key`) work too — they always resolve against the runtime's own directory and never against the shell's working directory — but then a rebuild replaces `.env`, `certs/`, `data/` and `logs/` along with the code.

Two instances therefore never share a port, a socket, a database, a log file or a PID file, and a process manager can start either one from any working directory. `EXTERNAL_MCP_DISCOVER_ON_START=true` discovers declared MCP endpoint tools during startup (bounded per endpoint, best-effort); without it a fresh install registers endpoints but reports no tools until discovery is triggered by hand. The handover package itself stays clean: running an instance never writes into `src/`, and `dist/zombiecoder-runtime` contains no `.env`, database, log or key material.

## Version note

The release package `package.json` identifies this build as `0.49.0`. For a deployment-specific claim, still confirm `package.json` and startup health output from the exact build being run. See [Phase 46 OS runtime verification gate](docs/75-phase-46-os-runtime-verification-gate.md).

## OS service and deployment verification (Linux/systemd)

The setup helper uses OS-level service management and adds no npm packages. It currently supports Linux/systemd only. Review it before running with `sudo`: `bash scripts/setup-os-runtime.sh`. The helper defaults to chat-only; the optional Nginx path requires explicit package-install consent and an existing trusted TLS certificate.

For a local health/model/TLS report: `node scripts/verify-deployment.mjs`. For real authenticated chat/stream checks, set `ZC_VERIFY_API_KEY` and `ZC_VERIFY_MODEL`, then run with `--chat --stream`. Tool calling requires a separate harmless end-to-end test; the script does not certify it.

## Scope

This README and the planning documents describe intent, constraints, and verification criteria. They do not create a tunnel, configure DNS/TLS, add credentials, change routes, or enable new runtime capabilities.

## Admin control plane (Phase 48)

Open `/admin` on the runtime host. The page reads provider/model/agent data from the actual runtime API. Admin token authentication is the default. `LOCAL_AUTH_BYPASS=true` is only for loopback-only local testing when `ADMIN_TOKEN` is empty; never use it behind a reverse proxy. See [Phase 48 runtime/admin control plane](docs/77-phase-48-runtime-and-admin-control-plane.md).

## External MCP Streamable HTTP lifecycle (Phase 49)

The external MCP client implements the POST initialization/notification/tool-list/tool-call sequence, negotiated session/version headers, JSON or SSE JSON-RPC responses, response ID validation, optional GET SSE events, and sanitized discovery error state. See [Phase 49 MCP lifecycle](docs/78-phase-49-mcp-streamable-http-parity.md). Local fixtures do not certify the user's legacy MCP endpoints.
