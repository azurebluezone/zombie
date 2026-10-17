# ZombieCoder Runtime

**An evidence-first, provider-neutral runtime for AI agents.**

`v0.49.0` · Node.js `>= 22.5.0` · **zero runtime dependencies** · single process, loopback-first

ZombieCoder Runtime sits between your client (desktop app, CLI, browser, or MCP client) and
whichever model provider you point it at. It normalises every provider into one
OpenAI-compatible surface, gives you a catalog of real agents with real personas, exposes
a permissioned tool layer that can read and write files and run commands, speaks MCP in
both directions, and refuses to call anything "verified" unless it has evidence.

---

## এক নজরে (বাংলায় সারসংক্ষেপ)

ZombieCoder Runtime হলো একটি **provider-neutral AI runtime** — অর্থাৎ আপনি যেই মডেল
প্রোভাইডার ব্যবহার করুন (Ollama Cloud, Gemini, Groq, বা নিজের endpoint), ক্লায়েন্টের কাছে
সব একই রকম OpenAI-compatible API হিসেবে দেখা যায়।

- **১২টি এজেন্ট** — প্রত্যেকের আলাদা persona, call sign, mission ও decision rule, ডাটাবেজে
  সংরক্ষিত (ফাইল ফলব্যাক সহ)।
- **৩২টি টুল** — এর মধ্যে ২৫টি চালু; ফাইল পড়া/লেখা, ফোল্ডার দেখা, কোড সার্চ, টার্মিনাল কমান্ড,
  git, todo/task planner ইত্যাদি। প্রতিটি কল permission, consent এবং path boundary দিয়ে যাচাই হয়।
- **৯১টি HTTP রুট** — OpenAI-compatible chat, streaming, execution, admin API, MCP।
- **MCP দুই দিকেই** — বাইরের MCP server ব্যবহার করে (client) এবং নিজেও MCP server হিসেবে কাজ করে।
- **Evidence Gate** — যাচাই ছাড়া কোনো কিছু "সফল" বলা হয় না; প্রতিটি ফলাফল
  `observed` / `verified` / `unverified` হিসেবে চিহ্নিত থাকে।
- **Admin console** — `http://127.0.0.1:9999/admin` — Providers, Models, Masking, Agents,
  Tools, MCP, Requests, Logs, Metrics, Tester, Runtime, Settings।
- **Chat UI** — `http://127.0.0.1:9999/` — ব্রাউজার থেকে সরাসরি চ্যাট।

শুরু করতে নিচের [Quick start](#11-quick-start) দেখুন। নিরাপত্তার জন্য এটি শুধু
`127.0.0.1`-এ চলে; কখনো সরাসরি ইন্টারনেটে বা reverse proxy-র পিছনে খুলবেন না।

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [What's in the box](#2-whats-in-the-box)
3. [How a request works](#3-how-a-request-works)
4. [Agents and personas](#4-agents-and-personas)
5. [Tools](#5-tools)
6. [Providers and model masking](#6-providers-and-model-masking)
7. [MCP — client and server](#7-mcp--client-and-server)
8. [Sessions, memory, SSOT and context](#8-sessions-memory-ssot-and-context)
9. [Evidence and verification](#9-evidence-and-verification)
10. [Admin console](#10-admin-console)
11. [Quick start](#11-quick-start)
12. [Configuration](#12-configuration)
13. [API surface](#13-api-surface)
14. [Running several instances](#14-running-several-instances)
15. [Testing](#15-testing)
16. [Security model](#16-security-model)
17. [Known limitations](#17-known-limitations)
18. [Documentation map](#18-documentation-map)

---

## 1. What this is

ZombieCoder Runtime is a **self-hosted runtime**, not a SaaS. One Node.js process gives you:

| Layer | What it does |
| --- | --- |
| **Transport** | HTTP, HTTPS and a Unix domain socket, all optional and independently configurable |
| **Provider layer** | Registers providers, syncs their model catalogs, routes requests by priority, normalises responses, trips a circuit breaker on repeated upstream failure |
| **Masking layer** | Presents a public "ZombieCoder" model identity so a client never learns the real provider or model |
| **Agent layer** | 12 agents with DB-backed personas, an access scope, and per-agent metrics |
| **Execution layer** | A lifecycle of `goal → plan → consent → execute → verify` with four boundaries: provider, native tool, remote MCP tool, and tool loop |
| **Tool layer** | A registry of 32 tools, application-scoped permissions, path boundaries, and consent |
| **MCP** | A client that consumes external MCP servers and an optional server that exposes 25 tools to MCP clients |
| **Context layer** | SSOT, syllabus, memory, entities and a compiled context budget |
| **Evidence layer** | Records observations, refuses to promote them to "verified" without proof |
| **Admin layer** | A single-file SPA over an admin JSON API |

**Design principle:** an answer is a claim, and a claim needs evidence. Every response
carries a verification status, and the runtime will say `unverified` before it will guess.

## 2. What's in the box

```
src/
  server.js              # the HTTP surface and every route
  agents/                # 12 agent definitions, persona registry, metrics, runtime audit
  execution/             # lifecycle, contract, orchestrator, tool/MCP/provider adapters, tool loop
  tools/                 # tool registry and policy
  mcp/                   # MCP client, server, registry, permissions, sessions, audit, schema, security
  providers/             # provider registry, adapters, router, normalizer, masking, model catalog
  context/               # compiler, SSOT, evidence validation
  evidence/              # the evidence gate
  session/               # session client and metadata sanitising
  storage/               # JSON store and SQLite store (schema + migrations)
  config/                # env loading and configuration
  compatibility/         # legacy/current route maps and feature reconciliation
  transport/, http/, admin/, auth/, browser/, network/, policy/, registry/, runtime/, skills/
tools/common/            # the 25 runnable tool implementations
public/
  admin/index.html       # the admin SPA (self-contained)
  chat.html              # the browser chat client (self-contained)
tests/                   # 306 tests, run with node --test
docs/OBSERVABILITY.md    # logging, diagnostics, privacy
scripts/build-runtime.mjs# build a self-contained runtime directory
```

There are **no dependencies**. `package.json` declares none, and `node_modules` is empty.

## 3. How a request works

```
Client (desktop / CLI / browser / MCP)
        │
        ▼
  Transport + auth          application key, rate limit, concurrency limit
        │
        ▼
  Route + task policy       what may this request do, with which tools
        │
        ▼
  Agent + persona resolve   agent definition + DB persona (+ shared core rules)
        │
        ▼
  Context compile           SSOT, syllabus, memory, entities, recent messages, budget
        │
        ▼
  System prompt build       identity → agent persona → shared persona → core rules →
                            provider masking → evidence rules → goal → context → tools
        │
        ▼
  Execution boundary        provider | native tool | remote MCP tool | tool loop
        │
        ▼
  Evidence gate             observation recorded, verification status decided
        │
        ▼
  Response + session + log  masked provider identity, JSONL audit trail
```

Every stage is observable: the runtime writes structured JSONL with a `requestId` and
`traceId`, and the admin **Requests** view tails that stream live.

## 4. Agents and personas

Twelve agents ship as file defaults and are seeded into the database on first start:

| Agent | Role | Call sign |
| --- | --- | --- |
| `code-guru` | architecture | The Builder |
| `bug-hunter` | debugging | The Hunter |
| `security-hero` | security | The Guardian |
| `perf-wizard` | performance | The Optimizer |
| `doc-king` | documentation | The Librarian |
| `qa-tyrant` | quality | The Judge |
| `planner` | planning | The Cartographer |
| `researcher` | research | The Scout |
| `integrator` | integration | The Bridge |
| `team-heart` | team-coordination | The Conductor |
| `customer-experience-specialist` | customer-experience | The Listener |
| `ecommerce-operations-analyst` | ecommerce-operations | The Quartermaster |

Each persona carries a **mission**, a **core persona**, **responsibilities** and a
**decision rule**. The two commerce-facing agents additionally carry a
**non-negotiable fairness clause**: a 2-taka order and a 2-lakh-taka order receive the
same greeting, response-time target, packing quality, fraud-check standard, escalation
rights and refund consideration — and no bias by order value, district, gender, religion,
dialect or writing style.

**Ownership rule.** The database is the SSOT for persona text; the `.js` files are the
fallback:

- a persona saved through the admin API is marked `source: 'admin'` and is **never**
  overwritten;
- any other row is *file-owned*: on start, `ensureDefaults()` refreshes it when the file
  default changes, keeping a three-entry `personaHistory` so an upgrade cannot silently
  destroy text;
- if no row exists, `resolve()` reads the file default directly.

**Core rules.** Every prompt also carries the shared persona — ten universal rules,
hallucination minimisation, learning-first, regression safety, dual validation,
consensus-before-output, communication policy and the engineering principle. It is placed
*after* the agent persona and states that on conflict, the rule wins. A persona can add
behaviour; it cannot talk an agent out of the rules.

## 5. Tools

33 tools are registered; **26 are runnable**.

**Runnable (26):** `runtime_echo`, `read_file`, `write_file`, `list_directory`,
`create_file`, `edit_file`, `apply_diff`, `delete_file`, `list_dir`, `read_directory`,
`grep_search`, `regex_search`, `file_search`, `find_files`, `view_symbol`, `code_graph`,
`run_terminal_command`, `execute_bash`, `kill_process`, `undo`, `revert_file`, `git_diff`,
`git_status`, `task_planner`, `todo_manager`, `note_store`.

**Deliberately not implemented (7):** `web_search`, `fetch_web_page`, `delegate_subagent`
(`NOT_IMPLEMENTED`), and `public_api`, `tts`, `ocr`, `facebook_ads` (`UNVERIFIED`).
They are registered so the surface is honest about what does not exist yet.

> **Registering a tool is not the same as enabling it.** `ZOMBIECODER_TOOLS` is a
> hand-maintained allowlist, and a runnable tool that is missing from it is refused at
> execution time as `tool_disabled_by_configuration` — which the executor reports as
> `tool_not_permitted`, exactly like an application that was never granted it. An empty
> list means "no list-based restriction"; the runtime warns at boot
> (`tool.config_allowlist_excludes_runnable_tools`) and logs the reason of every refusal
> (`tool.permission_denied`) so the two are no longer indistinguishable.

A tool call is authorised by, in order: the **task policy**, the **application
permission** grant, **execution consent**, the **path boundary**, and the **execution
mode**. Tool availability never implies permission.

**Path boundary.** An agent's persisted scope decides where its declared paths resolve:

- `global` — any existing folder; the agent may name any root it is allowed to reach.
- `working-directory` — all tools, but confined to that directory.

Symlink-escape and must-exist checks still apply in both modes: "any folder" is not
"no sandbox". `TOOL_ACCESS_MODE=permissioned` (default) keeps the per-application grant
gate; `unrestricted` drops that gate so every agent can call every runnable tool. A tool
disabled by configuration is refused either way.

**Choosing where to look.** The six search tools — `grep_search`, `regex_search`,
`file_search`, `find_files`, `view_symbol` and `code_graph` — take an optional `path`
(a folder, or a single file), plus `maxFiles`, `maxDepth` and `includeIgnored`. Without
`path` they start at the project root. A walk is bounded three ways (file count, depth and
a 10-second deadline) and reports when it truncated instead of quietly returning a partial
answer, and a path that does not exist is reported as `[path not found: …]` rather than as
an empty result. A symlink cannot be used to escape a scoped root.

**Terminal commands are allowlisted, and the list is deliberately not configurable.**
`run_terminal_command` accepts `node`, `npm`, `pnpm`, `yarn`, `composer`, `php`, `python3`
and `git`, and only in read/verify subcommands (`node --version|--check|--test`,
`git status|diff|log|rev-parse|branch`, `php -l`, `python -m pytest`, …). Package
mutations such as `npm install` are refused with `package_mutation_requires_separate_approval`,
so installing dependencies is an explicit operator action rather than something an agent can
decide. `execute_bash` is the broader tool and is governed by the same consent, path and
execution-mode gates.

**The offer is narrowed to the request; the permission is not.** A tool loop used to send
all 25 tool definitions on every round — measured at **1,927 tokens** of prompt, re-sent
every round, which on its own can exceed a free tier's per-minute input budget and gives
the model a manual to read instead of a job to do. The runtime now offers only the tools
the request has a reason to use:

- an always-on core so the agent can always look around: `read_file`, `list_directory`,
  `grep_search`, `file_search`;
- one whole family per detected purpose — *change* adds the write family, *run/verify*
  adds the terminal, *version control* adds git, *plan* adds the planners, *structure or
  symbols* adds the explorer tools;
- anything the caller names in `toolIds`, and anything the task policy hints at.

Measured effect: a read-only question offers **4 of 25** tools (`reason: core_only`), a
change request **9 of 25** (`purpose:write`), a run-and-verify request **6 of 25**
(`purpose:run`). A tool named explicitly in the request is always offered, the always-on
core always survives the cap, and the agent's own earlier tool output can never widen the
surface — only the user's words are read. `meta.toolSurface` reports `count`, `toolIds`,
`allowedCount`, `mode`, `reason`, `groups` and `dropped`, so the choice is auditable rather
than implicit.

Narrowing is an offer, never a grant: permission, consent, the path boundary, the task
policy and the execution mode are all enforced downstream and unchanged. Set
`TOOL_SURFACE_MODE=full` (or send `toolSurface:"full"`, or name `toolIds`) to keep the whole
allowed surface; `TOOL_SURFACE_MAX` (default 12) caps only the optional families. If the
narrowed surface somehow contains no runnable tool, the request falls back to the full
allowed surface rather than failing.

### The browser pipe (`src/browser/cdp-pipe.js`)

A zero-dependency, self-contained way to drive a Chromium browser without opening a debug
port. Chrome is launched with `--remote-debugging-pipe`, so CDP JSON travels over an
inherited pipe — **Chrome reads fd 3 and writes fd 4**, NUL-terminated; the parent writes
into `stdio[3]` and reads from `stdio[4]`. There is no TCP port, no WebSocket and no HTTP in
the control channel, so nothing else on the machine can connect to a DevTools socket. The
page may of course load `http(s)`/`file`/`data` URLs; that is Chrome doing its job.

It is a module, not a tool: nothing in the agent loop calls it unless an operator wires it
up. `browseCdp({url, action})` supports `text`, `html`, `title`, `url` and `screenshot`, and
every returned payload is bounded.

`discoverChrome()` finds a browser instead of assuming one: `CHROME_BIN`, then `PATH`, then
the platform's well-known locations, and a failure lists everything it tried. It keeps
Chrome's own sandbox unless the process is already root or `CDP_NO_SANDBOX=1` is set, uses
`os.tmpdir()` (override with `CDP_TMP_ROOT`) instead of a hardcoded `/tmp`, removes its
profile directory on stop, keeps a bounded tail of Chrome's stderr and attaches it to
failures, and kills its browser on process exit. `openTarget()` prefers a fresh tab but
falls back to an existing page target, because an Electron-based Chromium does not implement
`Target.createTarget` and answers "Not supported".

**Verification status.** The transport is *live-probed* against a real Chromium: Electron
bundles Chromium, and the OpenCode desktop app on this machine answers `Browser.getVersion`
over the pipe as `Chrome/152.0.7977.130`. A full page browse against a stock Chrome is
**not tested** here — this machine has no Chrome binary (only a `chromium-browser` snap stub
that refuses to start). The remaining behaviour is covered by
`tests/phase67-cdp-pipe.test.js` against `tests/fixtures/fake-chrome.mjs`, a
protocol-compatible stand-in that speaks the same NUL-framed fd 3/4 protocol.

## 6. Providers and model masking

Providers are declared in `PROVIDER_CONFIG_JSON`; keys are read from
`PROVIDER_KEY_<PROVIDER_ID>` (with `_` normalised to `-`). Ollama's own convention,
`OLLAMA_API_KEY`, is honoured as a fallback for every provider whose driver is `ollama`
when no provider-specific key is set — an explicit `PROVIDER_KEY_*` always wins.

- **Priority routing** — requests walk providers in priority order; the first healthy
  candidate that can serve the required capabilities wins.
- **Circuit breaker** — repeated upstream failures open a circuit with a reset timeout and
  a half-open probe, so one dead provider cannot stall every request.
- **Model catalog sync** — model lists are fetched from the upstream and stored, so the
  catalog reflects what the provider actually serves.
- **Masking** — a client only ever sees a public ZombieCoder model identity. The real
  provider and model are resolved inside the runtime, kept in the log, and masked in every
  public projection. Per-provider `modelAliases` let you map a public model name onto a
  real one; explicit aliases outrank default-model fallbacks.

Secrets never reach the browser: provider keys are absent from every admin payload and
from `/api/config/mcp`.

## 7. MCP — client and server

**As a client**, the runtime consumes external MCP servers: endpoints are registered with
their own `headers` (replayed on discover and on call), tools are discovered over
Streamable HTTP, and each tool gets a qualified name (`<endpoint>.<tool>`) so two servers
can expose the same tool name safely. Calls are recorded in an MCP audit trail with
`permission`, `request` and `result` stages, plus the `sessionId`, `connectionId`,
`runtimeId` and `clientId` that produced them.

**As a server**, when `MCP_SERVER_ENABLED=true` the runtime exposes `POST /mcp` with the
same 25 runnable tools, negotiates the protocol version, and supports optional
authentication. For loopback-only work an admin switch can relax inbound auth while
still auto-provisioning an application, so sessions, permissions and audit rows keep
a real owner.

External MCP tool calls are reachable through `POST /v1/mcp/tools/call` (application
authenticated) and through the execution boundary (`POST /v1/execution/run` with a
`qualifiedName`), which returns the remote result plus evidence.

## 8. Sessions, memory, SSOT and context

- **Sessions** hold messages, status and application-owned metadata. Client identity
  (editor, version, OS, device, session source) is sanitised to an allowlist before it is
  stored or put in a prompt.
- **SSOT** is the single source of truth for project state; agents are told to read it
  before acting.
- **Syllabus** records what was learned per project; **memory** holds recent entries.
- **Notes** are the agent's own short, dated lines about the folder it is working in
  (`.zombiecoder/agents/notes.json`). The syllabus and the memory have no writer an agent
  can reach, so an agent that learned something had nowhere to put it and the next request
  started from zero; `note_store` closes that gap with three actions — `append`, `list`,
  `search` — plus `remove` for the console. Notes are **per project root**, so the folder
  you work in is the one that is remembered, and switching folders remembers that one
  instead. The store is built on Node's own modules, writes atomically (temporary file
  plus rename, so a crash cannot leave a half-written file), is bounded
  (`NOTES_MAX_ENTRIES`, default 500), and **never reads `process.cwd()`**: every call takes
  an absolute root and a relative one is refused with `note_root_must_be_absolute`. A file
  that does not parse is reported through `warnings` and left untouched, never deleted.
- **Entities** model domain objects.
- **Context compiler** assembles the minimum relevant context under a configurable byte
  budget (`COMPILED_CONTEXT_BYTES`, default 20 KB) and a recent-message window. Which SSOT
  sections it selects is decided by how much of the request they actually match: a section
  whose **title** matches (or one the runtime always wants) is included in full, while a
  section matched only somewhere in its body gets a budget proportional to the number of
  distinct words it matched. Without that rule one ordinary word could pull a whole file
  listing into the prompt — see the note in `src/context/compiler.js`.

  The budget has to stay **below** the prompt's own limit on the compiled context
  (`COMPILED_CONTEXT_PROMPT_CHARS`, 24,000 characters). When it did not — the default was
  192 KB — a long conversation compiled to ~60 KB, the prompt cut the JSON at the character
  limit, and the model was handed a document that does not parse. Below the limit the
  compiler's own reduction runs instead, and it shrinks *structurally*: syllabus first, then
  memory, then SSOT sections, then the oldest messages — so what survives is always valid
  JSON and always the most recent part. Measured: a 4 KB budget keeps 10 recent messages,
  8 KB keeps 22, 20 KB keeps 56.

## 9. Evidence and verification

The evidence gate is the spine of the runtime:

- `EvidenceGate.validate()` requires `source`, `status` and `observedAt` on every record.
- `canClaimSuccess()` returns true only when some evidence item is `verified`.
- A provider response is an **observation**, never proof that a requested change happened.
- When verification is missing the run is reported as `awaiting_verification` and the
  response body is withheld, rather than being dressed up as success.
- A malformed evidence item degrades a run to `awaiting_verification` and is logged — it
  can never fail a request whose work has already executed.

**Verification vocabulary** used throughout the docs and the API:

| Term | Meaning |
| --- | --- |
| **Intended** | design goal only |
| **Implemented** | code exists in a named build; correctness is not implied |
| **Suite-verified** | the test suite passed; live compatibility is not implied |
| **Live verified** | an identified real endpoint/client passed a recorded test |
| **Not tested** | the check was not run |
| **Unverified** | evidence is missing or incomplete |

## 10. Admin console

`http://127.0.0.1:9999/admin` — a self-contained SPA (no CDN, no charting library; charts
are hand-rolled inline SVG). Views:

| Group | Views |
| --- | --- |
| Overview | Dashboard |
| Catalog | Providers, Models, Masking Models |
| Agents | Agents, Agent Mappings |
| Tools & MCP | Tools, MCP |
| Operations | Requests, Logs, Metrics, Tester |
| System | Runtime, Settings |

Highlights: per-provider **Test** (pick a model, see request → response), provider
priority editing, masking-model mapping display, per-agent persona editing and access
scope, tool enable/disable, the MCP page (connected clients, client IDs, which client is
working now, endpoint auth, new endpoint by URL + discovery), live request/log streaming
with browser-side filtering, metric cards and graphs, and a **Tester** page whose route
catalog is read from `GET /v1/admin/routes` so it cannot drift.

The browser chat client lives at `/` (also `/chat`). It streams over SSE using `fetch` +
`ReadableStream` and keeps its key in `localStorage` under `zc_chat_key`. Both pages share
one strict Content-Security-Policy.

## 11. Quick start

```bash
# 1. install (no dependencies — this only fetches nothing, it is here for clarity)
node --version          # must be >= 22.5.0

# 2. configure
cp .env.example .env
#    then edit .env: set at least one provider key and enable that provider
#    PROVIDER_KEY_OLLAMA_CLOUD_OPENAI=<your key>
#    ZOMBIECODER_EXECUTION_MODE=tools-enabled   # only if you want tool execution

# 3. run the tests
npm test

# 4. start the runtime
npm start
```

Then open:

- **Chat:** `http://127.0.0.1:9999/`
- **Admin:** `http://127.0.0.1:9999/admin`
- **Health:** `http://127.0.0.1:9999/health`

Verify the process is alive:

```bash
curl -s http://127.0.0.1:9999/health | head -c 200
```

Stop it with `node start.js --stop`.

### Windows

The runtime has **zero npm dependencies**, so there is no install step — but two things
trip Windows users up: the Node.js version and the PowerShell execution policy.
`scripts/start-windows.ps1` handles the first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-windows.ps1
```

It checks for Node.js >= 22.5.0, offers to install the LTS build with `winget` if it is
missing or too old (and makes no change if you decline), then starts the runtime the same
way `npm start` does. The Unix domain socket is disabled by default on Windows.

### Linux (systemd service)

`scripts/setup-os-runtime.sh` installs the runtime as a systemd service. It makes **no
change at all** unless it is running as root, on Linux, with systemd available, and the
Node.js version check passes:

```bash
sudo bash scripts/setup-os-runtime.sh
```

Templates live in `scripts/systemd/` (the unit file plus a short README) and
`scripts/nginx/zombiecoder.conf.template` for a reverse-proxy front end. Read section 16
first: the runtime is designed for loopback, and a reverse proxy must not be the thing that
exposes it.

### Verify a deployment

```bash
node scripts/verify-deployment.mjs                          # probes http://127.0.0.1:9999
ZC_VERIFY_URL=http://127.0.0.1:10001 node scripts/verify-deployment.mjs
```

It runs live checks (health, model catalog, TLS endpoint when enabled, an authenticated chat
call and an authenticated streaming call) and writes a JSON report, by default to
`./data/deployment-verification.json`. It is a live probe, so treat its output as observed
evidence rather than a guarantee.

### The `.zombiecoder/` directory

The first start creates a `.zombiecoder/` directory inside the project root the runtime is
working in. It is runtime-owned scratch space — it is in `.gitignore` and is not source:

| Path | What it is |
| --- | --- |
| `SSOT.md` | Project state the runtime observed: detected technologies and file structure. It is rebuilt when it is missing **or was not written by this runtime**, so a stale file left behind by an editor plugin cannot be handed to the model as project truth. A foreign file is preserved as `SSOT.imported.md`. |
| `agents/syllabus.md` | Knowledge entries for this project. |
| `agents/memory.json` | Project notes. Starts empty — see the note below. |
| `version.json`, `mcp-config.json`, `vscode.json`, `jetbrains.json`, `editor-config.json` | Markers an editor integration reads. |

`syllabus.md` and `memory.json` are written through `POST /v1/context/syllabus` and
`POST /v1/context/memory`. Nothing writes them automatically and no tool lets an agent record
a note yet, so a default install reports `memory entries: 0`. The **reader** side is fully
wired: the context compiler selects only the sections relevant to the current request, under
the `COMPILED_CONTEXT_BYTES` budget, instead of pasting the whole file into the prompt.

## 12. Configuration

`.env` is gitignored; `.env.example` documents every key. Sections:

| Section | Covers |
| --- | --- |
| Runtime | host, port, HTTPS, UDS, data/log dirs, SQLite path, execution mode, admin token, loopback auth bypass |
| Provider routing | provider catalog sync, timeouts, model refresh, API keys |
| Network policy | plaintext HTTP, private networks, host allowlists, response size caps |
| MCP | external endpoints, discovery, inbound server, inbound auth, network policy |
| Tool / execution limits | tool root, tool-loop rounds, per-round call caps, repeat caps |
| Session / context | message caps, context budget, compiled-context budget, memory entries |
| Observability | log level, dir, file, rotation, payload logging |
| Reliability | circuit breaker thresholds and timeouts |
| Browser/CDP | optional browser automation endpoint |
| Instance identity | runtime id, instance id |

Three switches worth knowing:

- `ZOMBIECODER_EXECUTION_MODE` — `chat-only` (default) or `tools-enabled`. Tool execution
  routes answer `503 tool_execution_not_verified` until this is `tools-enabled`.
- `TOOL_ACCESS_MODE` — `permissioned` (default) or `unrestricted`.
- `TOOL_SURFACE_MODE` — `narrowed` (default) or `full`. What an agent is *offered*, never
  what it is *allowed*; see §5. `TOOL_SURFACE_MAX` (default 12) caps the optional tool
  families, and `COMPILED_CONTEXT_BYTES` (default 20 KB) bounds the compiled context; see §8.

Never commit `.env`, API keys, tunnel tokens or private keys.

## 13. API surface

The route inventory is machine-readable at `GET /v1/admin/routes`
(`currentConcreteRoutes: 94`, `currentHandlerBlocks: 58`; the legacy inventory is 31
concrete routes plus 17 compatibility routes). `currentConcreteRoutes` is derived from the
route map, so it tracks the code; `currentHandlerBlocks` is hand-maintained and no code
derives it, and the map now says so. The 94 current routes group as follows:

| Group | Routes | Examples |
| --- | --- | --- |
| Health / models | 1 | `GET /health` (`GET /v1/models` is also served) |
| OpenAI-compatible | 1 | `POST /v1/chat/completions` (stream and non-stream) |
| Execution | 3 | `POST /v1/execution/prepare`, `POST /v1/execution/run`, `POST /v1/execution/stream` |
| Context | 9 | `POST /v1/context/setup`, `GET /v1/context`, `POST /v1/context/ssot/refresh`, `/syllabus`, `/memory`, `/notes` (GET/POST/DELETE) |
| Sessions | 5 | `POST /v1/sessions`, `GET /v1/sessions/{id}`, `PATCH /v1/sessions/{id}/metadata`, `GET …/messages`, `POST …/close` |
| MCP (public) | 1 | `POST /v1/mcp/tools/call` |
| Admin — applications | 7 | `POST /v1/admin/applications`, `…/{id}/rotate-key`, `…/revoke`, `…/extend`, `…/capabilities` |
| Admin — providers | 8 | list, create, `sync`, `{id}/sync`, `route`, `{id}/models/refresh`, `models`, `{id}/test` |
| Admin — models & masking | 4 | `GET /v1/admin/models`, `POST …/models/sync-all`, `GET /v1/admin/masking-models`, `GET /v1/admin/agent-model-mappings` |
| Admin — registry | 16 | agents, `agents/{id}/boundary`, `agents/runtime-audit`, tools, skills, transports, external-mcp |
| Admin — personas | 4 | `GET/POST /v1/admin/personas`, `PATCH/DELETE /v1/admin/personas/{id}` |
| Admin — tools | 3 | `GET/POST/DELETE /v1/admin/tools/permissions` |
| Admin — agents | 2 | `GET/DELETE /v1/admin/agents/metrics` |
| Admin — MCP | 19 | endpoints, `{id}/discover`, permissions, connections, reconcile, incomplete, audit, tools, auth, server, clients |
| Admin — operations | 11 | routes, logs, `logs/stream`, metrics, evidence, constitution, `compatibility/*`, task-profiles |

`GET /v1/admin/routes` is the authoritative list; treat the table above as a map, not as a
second source of truth.

Admin API calls work on loopback without a token when `LOCAL_AUTH_BYPASS=true` and
`ADMIN_TOKEN` is empty — which is the intended setup on a machine you control, and the reason
this runtime must never be exposed beyond `127.0.0.1`.

A tool-loop chat requires explicit consent:

```bash
curl -s -X POST http://127.0.0.1:9999/v1/chat/completions \
  -H "authorization: Bearer <application-key>" \
  -H 'content-type: application/json' \
  -d '{"model":"zombie-mini","agent":"code-guru","messages":[{"role":"user","content":"..."}],
       "autoToolLoop":true,"consent":true,"toolIds":["runtime_echo"],
       "projectRoot":"/path/to/project"}'
```

Without `"consent": true` the runtime answers `409 execution_consent_required`.

## 14. Running several instances

The build copies runtime sources only — no `.env`, `data/`, `logs/`, `tests/` or secrets —
and refuses to replace an output directory it does not manage, or one that is currently
running.

```bash
npm run build                                             # ./dist/zombiecoder-runtime
node scripts/build-runtime.mjs --output dist/zc-10001      # an independent second instance
```

Keep each instance's configuration, certificates, database and logs **outside** the build
output, so rebuilding the code cannot erase them:

```bash
mkdir -p instances/zc-10001/{certs,data,logs}
cp .env.example instances/zc-10001/.env
# in instances/zc-10001/.env set PORT, HTTPS_PORT, DATA_DIR, SQLITE_PATH, LOG_DIR, UDS_PATH
```

## 15. Testing

```bash
npm test           # node --test
```

Current baseline: **306 tests, 304 passing, 2 failing.** The two failures are known and
pre-existing:

- `tests/phase49-mcp-streamable-http.test.js` — asserts an older protocol version than the
  runtime now negotiates (stale fixture).
- `server-side PHP integration` — requires a `php` binary that is not installed here.

Treat a green suite as *suite-verified*, never as *live verified*.

## 16. Security model

- **Loopback first.** The default host is `127.0.0.1`. Never put this behind a reverse
  proxy or expose it on a public interface.
- **Secrets stay server-side.** Provider keys are never returned by any admin payload, and
  are redacted from the MCP endpoint view.
- **Provider identity is masked** in every public projection.
- **Path boundaries** are enforced with symlink-escape and must-exist checks, in both
  access modes.
- **Consent** is required before risky or irreversible actions.
- **The chat page provisions its own application** when the admin API is reachable
  without a token on loopback: it creates (or rotates) one `chat-page-*` application per
  browser and stores the key in that browser's `localStorage`, so a normal user can just
  type. This grants no new authority — it uses the same loopback admin bypass that already
  exists — but it is another reason this runtime must stay on `127.0.0.1`. Where the admin
  API is protected, the create call answers `401` and the page falls back to the manual key
  bar.
- **The loopback auth bypass is a development affordance**, not a security control. If you enable
  remote access, set `ADMIN_TOKEN` and application keys, and terminate TLS properly.

Known, accepted gaps: `DELETE /mcp` terminates a session without authentication
(loopback only), and `GET /mcp` returns `405` (optional in Streamable HTTP).

## 17. Known limitations

This repository does **not** claim complete compatibility with every provider or client.
Be explicit about the line between "implemented" and "verified".

- `web_search`, `fetch_web_page` and `delegate_subagent` are **not implemented**;
  `public_api`, `tts`, `ocr` and `facebook_ads` are registered but **unverified**.
- Remote MCP endpoints are only useful if something is actually listening at their URL.
  A declared endpoint that cannot be reached stays in `error` with zero tools and is
  reported as such rather than being silently dropped.
- In `global` access mode, `grep_search` / `file_search` / `find_files` still search only
  the project root, because they take no path argument. "Search anywhere" is therefore not
  yet implemented for those three tools.
- External MCP tools are **not** injected into an agent's native tool list. They are
  invoked explicitly through `/v1/mcp/tools/call` or the execution boundary, so an agent
  will not spontaneously choose a remote MCP tool.
- The two failing tests above are left failing rather than silenced.
- A successful `/health`, a fixture test, or a model appearing in a catalog is **not**
  proof that authentication, inference, streaming, tool calling and client integration all
  work.

## 18. Documentation map

| Document | Contents |
| --- | --- |
| `README.md` | this file |
| `docs/OBSERVABILITY.md` | runtime logging, diagnostics, privacy guidance, troubleshooting |
| `IMPLEMENTATION_MANIFEST.md` | per-phase implementation record |
| `CHANGELOG.md` | release history |
| `GET /v1/admin/routes` | the authoritative, machine-readable route inventory |
| `GET /v1/admin/constitution` | the core constitution returned as JSON |
| `.env.example` | every configuration key, documented |
| `tests/` | executable specification of current behaviour |

Do not cite a document that is not present in this tree. For the exact behaviour of this
build, read the source, `.env.example`, `IMPLEMENTATION_MANIFEST.md` and the test suite.
