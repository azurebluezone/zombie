# Fresh install, restart, and connecting an MCP client

This document is written from the repository, not from one particular machine, so
that a fresh clone on a default OS can be brought up and verified without
guessing. Every command and every expected result below was run against a live
instance before it was written down; the ones that were not are labelled in
[§11](#11-honest-status).

The part that is easy to get wrong is the last one: an agent's MCP client does not
connect to this runtime by default. It has to be switched on, pointed at the right
endpoint, and given the right root. [§8](#8-connect-an-agents-mcp-client) and
[§9](#9-the-restart-checklist) are the two sections that matter after a restart.

---

## 1. What you are installing

One Node process. It has two MCP roles, and they are not the same thing:

| Role | What it means | Default |
| --- | --- | --- |
| **MCP client** | the runtime connects out to external MCP servers you declare, and their tools reach your agents | on |
| **MCP server** | the runtime serves its own tools to an MCP client (a desktop agent, an IDE) over Streamable HTTP at `POST /mcp` | **off** |

The server role is opt-in on purpose. A runtime that advertises a server it has not
been asked to run is a runtime that lies about its surface — so when
`MCP_SERVER_ENABLED` is not `true`, `POST /mcp` answers `501` with
`mcp_server_not_implemented` and an explanation, instead of a bare `404`.

The runtime also speaks the OpenAI HTTP contract on the same port, which is what a
Laravel shop uses. That is a separate surface; see
`docs/LARAVEL_INTEGRATION.md`.

---

## 2. Prerequisites

| Requirement | Value | Why |
| --- | --- | --- |
| Node.js | **>= 22.5.0** | pinned in `package.json` `engines`; both installers check it and refuse to continue otherwise |
| git | any recent version | to get the code |
| npm | the one that ships with that Node | optional — `node start.js` works without it |
| A C++ toolchain | **none** | `dependencies` and `devDependencies` are empty on purpose |
| A database server | **none** | storage is a file-backed store under `data/` |
| Docker | **none** | — |
| PHP / Composer | **not needed to run the runtime** | only needed to run the PHP integration tests, which skip without it |

The zero-dependency choice is deliberate: there is no lockfile to drift, no
`node_modules` to age, and nothing to audit except Node itself.

### 2.1 Nothing to install — and the runner rule that follows from it

Do not run `npm install`, `npx vitest`, `npx jest`, or any other installer or test
runner in this directory. There is nothing to install, and the wrong runner does
real damage:

- `npx vitest` cannot run a `node:test` file. This project's tests import
  `node:test`; vitest fails on them.
- It also writes a cache into `node_modules/` — so a zero-dependency project ends
  up looking as though dependencies were added, and the next person has to work out
  whether they were.

The runner is `node --test` (`npm test`). The rule is enforced:

```bash
node scripts/check-zero-deps.mjs    # exit 0 clean, exit 1 polluted
```

`tests/phase76-zero-deps.test.js` applies the same check on every run. If the guard
fails, a stray cache appeared; it is not read by anything, so removing
`node_modules` is the whole fix.

This has happened once already. On 2026-10-16 at 22:11 a `npx vitest` was run here
(it cached vite 8.3.4 under `~/.npm/_npx`), and at 22:12 it wrote
`node_modules/.vite` and `node_modules/.vitest-cache` while failing
`tests/phase23-system-session.test.js`. `node_modules` is gitignored, so the
repository was never affected — 0 files were tracked — but the working tree was
polluted. That is why the check exists.

---

## 3. Get the code

```bash
git clone https://github.com/azurebluezone/zombie.git
cd zombie
node --version        # must print v22.5.0 or higher
```

---

## 4. Install — pick one path

### 4.1 The quick path: `scripts/bootstrap.sh`

```bash
bash scripts/bootstrap.sh
```

It looks at what already exists and installs only what is missing. It will not
overwrite an existing `.env`, will not run `git reset` or `git clean`, will not
`rm -rf` anything, will not pass `--force`, will not set
`ZOMBICODER_EXECUTION_MODE`, and will not configure a proxy. Environment overrides:

| Variable | Effect |
| --- | --- |
| `ZC_DIR` | where the checkout lives or should be cloned (default `$HOME/zombie`) |
| `ZC_REPO` | git remote (default the repository above) |
| `ZC_BRANCH` | branch to check out (default `main`) |
| `ZC_SKIP_SYSTEM=1` | never call `apt` — for a machine where you install packages yourself |
| `ZC_NO_START=1` | never offer to start the runtime at the end |

```bash
ZC_SKIP_SYSTEM=1 ZC_NO_START=1 bash scripts/bootstrap.sh
```

### 4.2 The OS path: a systemd service

```bash
sudo bash scripts/setup-os-runtime.sh
```

Linux with systemd only, root required, and it changes nothing on any other
platform — it exits with a message instead. It validates the Node version and the
port, then installs a unit built from
`scripts/systemd/zombiecoder-runtime.service.template`. The template's placeholders
(`{{USER}}`, `{{ROOT}}`, `{{PORT}}`, `{{MODE}}`, `{{NODE}}`) are documented in
`scripts/systemd/README.md`.

### 4.3 Manual

Nothing beyond the four steps in §3, §5, §6 and §7. There is nothing to build.

---

## 5. Configure `.env`

`.env` is gitignored and must never be committed. Start from the documented
example:

```bash
cp .env.example .env
```

The keys that decide whether an agent's tools work at all:

| Key | Default | What it does |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | keep it loopback. Do not expose this runtime directly |
| `PORT` | `9999` | the single HTTP port |
| `ADMIN_TOKEN` | empty | set a long random value unless you are on a machine you fully control |
| `LOOPBACK_AUTH_BYPASS` | `false` | with `true` **and** an empty `ADMIN_TOKEN`, admin routes accept loopback requests without a token |
| `ZOMBICODER_EXECUTION_MODE` | `chat-only` | **`tools-enabled` is required for any tool to run.** `chat-only` answers `503 tool_execution_not_verified` |
| `TOOL_ACCESS_MODE` | `permissioned` | `unrestricted` lets a tool touch any path. This is the path boundary; choose it deliberately |
| `DATA_DIR` | `./data` | storage, logs' sibling, and the default tool root (see §8.6) |
| `MCP_SERVER_ENABLED` | `false` | **`true` to serve MCP at `POST /mcp`** |
| `MCP_SERVER_PROJECT_ROOT` | empty | the root the MCP server's tools operate inside. Empty falls back to the runtime's own root — which is **not** your project |
| `MCP_SERVER_AUTH` | `required` | whether `POST /mcp` demands an application key |

Provider keys are looked up as `PROVIDER_KEY_<PROVIDER_ID>` with `_` normalised to
`-` (provider id `opencode-free` → `PROVIDER_KEY_OPENCODE_FREE`). A provider whose
`driver` is `ollama` may fall back to `OLLAMA_API_KEY`; an explicit
`PROVIDER_KEY_*` always wins.

---

## 6. Start, stop, restart

```bash
node start.js            # foreground
node start.js --stop     # stop the running instance
npm start                # identical to `node start.js`
```

A detached start, for a machine where you are not watching the terminal:

```bash
setsid nohup npm start > /tmp/zombiecoder.log 2>&1 < /dev/null &
```

- Structured logs: `logs/runtime.jsonl`, one JSON object per line.
  `LOG_DIR` resolves against the project root, not the current directory.
- The lock and socket live under `DATA_DIR`: `runtime-runtime-<port>.lock`,
  `runtime-runtime-<port>.sock`.
- **Restart after any change under `src/`.** Nothing reloads itself.

---

## 7. First-run verification

```bash
curl -s http://127.0.0.1:9999/health
```

Expect `version`, `phase`, `executionMode`, and a `providerMode`. Then the two
inventories that tell you what the agent will actually have:

```bash
curl -s http://127.0.0.1:9999/v1/admin/registry/tools   # {"components":[...]}
curl -s http://127.0.0.1:9999/v1/admin/routes           # the route inventory
```

A healthy build reports **28 tools, all runnable, 0 unavailable** in the registry.
A tool that is `DISABLED` is not runnable no matter what else is set — that is the
value the operator's global tool switch writes.

---

## 8. Connect an agent's MCP client

### 8.1 Turn the server on

```
MCP_SERVER_ENABLED=true
```

Restart. Without it, every request to `/mcp` gets `501`:

```json
{ "error": { "message": "mcp_server_not_implemented", "type": "server_error",
             "param": null, "code": "mcp_server_not_implemented" } }
```

That body is correct, not a bug: the runtime consumes MCP servers as a client and
does not pretend otherwise.

### 8.2 The endpoint and the verbs

| Method | Path | Meaning |
| --- | --- | --- |
| `POST` | `/mcp` | JSON-RPC 2.0. Streamable HTTP; the response may be `application/json` or `text/event-stream` |
| `DELETE` | `/mcp` | end a session; send the `mcp-session-id` header. Answers `204` |
| `GET` | `/mcp` | not supported when the server is on — answers `405` with `allow: POST, DELETE` |

When the server is **off**, every method on `/mcp` answers `501` — the path is
recognised, and the answer explains why it is not served. Nothing about it is a
`404`.

`initialize` returns two headers worth keeping:

- `mcp-session-id` — send it back on every later request in the session.
- `mcp-protocol-version` — the version the runtime prefers. The body's
  `result.protocolVersion` is the version **negotiated with you**, which may be
  older if you asked for an older one.

### 8.3 Authentication

`MCP_SERVER_AUTH=required` (the default) means `POST /mcp` needs
`Authorization: Bearer <application key>`. The policy can be overridden from the
admin console; the effective value is on `GET /v1/admin/mcp/auth`:

```bash
curl -s http://127.0.0.1:9999/v1/admin/mcp/auth
```

When the policy is `requireAuth: false`, an unauthenticated call is **still**
attributed to an auto-provisioned application, so sessions, per-application tool
permissions and the audit trail all keep an owner. A presented key always wins.

A rejected call is an RFC 6750-shaped `401` with a `www-authenticate` challenge:

```json
{ "jsonrpc": "2.0", "id": null, "error": { "code": -32001, "message": "unauthorized" } }
```

### 8.4 Prove it by hand

Run this before you touch a client's configuration — it separates "the server is
broken" from "the client is misconfigured".

```bash
# 1. initialize (keep the session id it returns)
curl -si -X POST http://127.0.0.1:9999/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'

# 2. handshake completion — expect 202 with no body
curl -si -X POST http://127.0.0.1:9999/mcp \
  -H 'content-type: application/json' -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. the tool list
curl -s -X POST http://127.0.0.1:9999/mcp \
  -H 'content-type: application/json' -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 4. call one
curl -s -X POST http://127.0.0.1:9999/mcp \
  -H 'content-type: application/json' -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_directory","arguments":{"path":"."}}}'

# 5. end the session — expect 204
curl -si -X DELETE http://127.0.0.1:9999/mcp -H 'mcp-session-id: <SESSION>'
```

What a working instance returns, as measured:

| Step | Observed |
| --- | --- |
| `initialize` | `200`, `mcp-session-id` present, `mcp-protocol-version: 2025-11-25`, `result.serverInfo = {"name":"zombiecoder-runtime","version":"0.49.0"}`, `result.protocolVersion` = the version you asked for |
| `notifications/initialized` | `202`, no body |
| `tools/list` | `200`, **28 tools**, every one with an object `inputSchema` |
| `tools/call` | `200`, `result.content[0].text` holds the output |
| unknown tool | `200` with a JSON-RPC error: `{"code":-32602,"message":"unknown_tool","data":{"tool":"…"}}` |
| `DELETE` | `204` |

### 8.5 A client configuration

The runtime is a **Streamable HTTP** server. Your client must support that
transport; the exact key names belong to the client, not to this runtime. The
shape is:

```json
{
  "mcpServers": {
    "zombiecoder": {
      "url": "http://127.0.0.1:9999/mcp",
      "headers": { "Authorization": "Bearer <application-key>" }
    }
  }
}
```

Two honest warnings:

1. **A stdio-only client will not connect to this.** It speaks JSON-RPC over a
   pipe, not HTTP. Bridging stdio to `POST /mcp` is not shipped — there is no
   bridge script in this repository. A client that supports Streamable HTTP needs
   no bridge; a client that does not, needs one written.
2. **Do not expose `/mcp` beyond loopback.** It runs tools on the machine. The
   runtime binds `127.0.0.1` for that reason, and `ADMIN_TOKEN` is a second lock,
   not a substitute for the first.

### 8.6 The tool root — the detail that bites

`MCP_SERVER_PROJECT_ROOT` is the root the MCP server's tools operate inside. It
**defaults to empty**, which falls back to the runtime's own root — `DATA_DIR`,
i.e. `./data`. A tool call is then resolved against `data/`, not against your
project:

```
tools/call read_file {"path":"README.md"}
→ "File not found: /home/<you>/zombie/data/README.md"
```

The tool did exactly what it was told; the root was simply not what the caller
assumed. Set it explicitly:

```
MCP_SERVER_PROJECT_ROOT=/home/<you>/zombie
```

Whether a tool may leave that root is a separate decision:
`TOOL_ACCESS_MODE=permissioned` (the default) keeps the boundary;
`TOOL_ACCESS_MODE=unrestricted` allows any path the process can reach. Choose it
knowingly — it is the difference between "the agent can read this project" and
"the agent can read the machine".

---

## 9. The restart checklist

Run these in order after any restart, before you conclude that anything works.
Each line is a claim you can check.

```bash
# 1. the process is up and on the right port
ss -ltnp | grep 9999

# 2. the runtime agrees about its own mode
curl -s http://127.0.0.1:9999/health | grep -o '"executionMode":"[^"]*"'
#    expect "tools-enabled" if you want tools to run

# 3. the tool inventory is complete
curl -s http://127.0.0.1:9999/v1/admin/registry/tools \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).components;const on=c.filter(t=>t.enabled!==false&&["REGISTERED","ENABLED","VERIFIED"].includes(String(t.status||"").toUpperCase())&&t.entry);console.log(c.length+" tools, "+on.length+" runnable")})'
#    expect "28 tools, 28 runnable"

# 4. the MCP server is on and advertises its tools
curl -s http://127.0.0.1:9999/api/config/mcp | head -c 400
#    expect server.implemented:true and server.tools listing the tool names

# 5. the provider you expect is the one being used
curl -s http://127.0.0.1:9999/v1/admin/routes >/dev/null && echo "admin API reachable"

# 6. the log has no error burst from this boot
tail -n 40 logs/runtime.jsonl | grep -c '"level":"error"' || true
```

If step 3 shows fewer than 28 runnable tools, one is `DISABLED` — that is the
global tool switch, and it wins over everything else.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `501 mcp_server_not_implemented` | `MCP_SERVER_ENABLED` is not `true` | set it and restart |
| `405` on `GET /mcp` | the server is on; `GET` is not a supported verb | use `POST` (and `DELETE` to end a session) |
| `401 unauthorized` on `/mcp` | `requireAuth` is true and no key was sent | send `Authorization: Bearer <application key>`, or change the policy in the admin console |
| `403`/`503 tool_execution_not_verified` | `ZOMBICODER_EXECUTION_MODE` is `chat-only` | set `tools-enabled` |
| `mcp_tool_argument_required:<name>` | the tool needs that argument | read the tool's `inputSchema` from `tools/list` |
| `File not found: <DATA_DIR>/…` | the tool root is the runtime's own root | set `MCP_SERVER_PROJECT_ROOT` |
| `tool_entry_outside_tool_root` | a tool's entry point resolves outside `TOOL_ROOT` | check `TOOL_ROOT` |
| a tool answers `mcp_tool_not_permitted` | the application is not granted that tool | grant it on `POST /v1/admin/applications/capabilities/tools` |
| port already in use, or a stale lock | another instance is running | `node start.js --stop`, then start again |
| the agent "has no tools" | the tool surface was narrowed | the runtime offers the whole surface unless `toolIds` names tools; `toolSurface:"full"` opts out |

Never work around a failure by widening `TOOL_ACCESS_MODE`, disabling auth, or
exposing the port. Each of those turns a visible misconfiguration into an
invisible one.

---

## 11. Honest status

| Claim | Status | Basis |
| --- | --- | --- |
| The MCP server serves `initialize` → `tools/list` → `tools/call` → `DELETE` | **LIVE_PROBE_PASSED** | measured on a running instance: 28 tools, all with object `inputSchema`; `DELETE` → `204` |
| The MCP server is off unless `MCP_SERVER_ENABLED=true` | **SOURCE_VERIFIED** + **LIVE_PROBE_PASSED** | `src/server.js`; a clean-env instance answers `501` (`tests/phase55`, `tests/phase58`) |
| The tool root defaults to `DATA_DIR`, not the project | **LIVE_PROBE_PASSED** | `read_file README.md` resolved to `<root>/data/README.md` |
| The OpenAI HTTP surface on the same port | **LIVE_PROBE_PASSED** | see `docs/LARAVEL_INTEGRATION.md` §12.1 |
| `scripts/bootstrap.sh` installs only what is missing and overwrites nothing | **SOURCE_VERIFIED** | `tests/phase70-bootstrap.test.js` (6 tests); the script was not run against a bare OS in this session |
| `scripts/setup-os-runtime.sh` installs a systemd unit | **NOT_TESTED** | requires Linux + systemd + root; not exercised here |
| A real desktop/IDE MCP client connects and runs a tool | **NOT_TESTED** | no such client on this machine; the JSON-RPC sequence in §8.4 is the substitute |
| A stdio→HTTP MCP bridge | **NOT_IMPLEMENTED** | no bridge script exists in this repository |
| PHP / Composer integration tests | **NOT_TESTED** | no `php` on this machine |

---

## 12. Related documents

- `README.md` §11 — quick start.
- `docs/LARAVEL_INTEGRATION.md` — the HTTP contract a shop's Laravel application uses.
- `docs/DESIGN_FLOW.md` — why the runtime is built this way, and what is honestly not done.
- `docs/OBSERVABILITY.md` — logging, diagnostics and troubleshooting.
- `scripts/systemd/README.md` — the unit template and its placeholders.
- `GET /v1/admin/routes` — the authoritative, machine-readable route inventory.
