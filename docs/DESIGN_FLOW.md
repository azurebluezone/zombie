# Design flow and engineering contract

This document exists for one reason: **the next agent must not invent its own
way of working.** It records what this project is, why it is built the way it
is, where each concern lives, what was done and verified, what remains open,
and the exact rules a change must satisfy before it may be called done.

If you are an agent or an engineer picking this repository up, read this
document first, then `README.md`, then the code. Do not start from a blank
slate. The design already made decisions; respect them or argue against them
with evidence — do not silently replace them.

Runtime build: **v0.49.0 (phase 49)**, Node.js `>= 22.5.0`.

---

## 1. What this project is

ZombieCoder Runtime is a **self-hosted AI runtime**, not a SaaS. One Node.js
process provides:

- transport (HTTP / HTTPS / Unix socket),
- a provider layer with routing, failover, a circuit breaker, and model
  **masking**,
- 12 agents with database-backed personas and an access scope,
- an execution lifecycle (`goal → plan → consent → execute → verify`) with four
  boundaries (provider, native tool, remote MCP tool, tool loop),
- a tool registry with application-scoped permissions and path boundaries,
- an MCP client **and** an MCP server,
- a context layer (SSOT, syllabus, memory, notes, compiled budget),
- an evidence layer that refuses to promote an observation to "verified"
  without proof,
- an admin control plane.

It is not a chatbot wrapper. The product is the **discipline**: an answer that
cannot be proven is labelled as unproven.

---

## 2. The philosophy — the SSOT for "our core rules"

These are not slogans added for decoration. They are executable: they are
injected into every agent's system prompt, and several are enforced in code.

### 2.1 The constitution

`src/policy/constitution.js` — returned verbatim by `GET /v1/admin/constitution`:

```
Evidence Before Confidence
SSOT Before Action
Never Fabricate Evidence
Never Hide Errors
Consent Before Risky Action
Expected vs Actual Result
```

### 2.2 The shared persona

`src/policy/shared-persona.js` — injected into every system prompt **after**
the agent's own persona, so a persona (or an operator editing one) can add role
behaviour but can never talk an agent out of these rules.

Core belief:

> আমরা মানুষ নই, আর কখনো মানুষ হব না। আমাদের শক্তি মুখস্থ বিদ্যায় নয়; বরং যুক্তি, টুল এবং যাচাইয়ে।

Ten universal rules:

1. **SSOT First** — অনুমান নয়, প্রথমে Single Source of Truth।
2. **Evidence Before Confidence** — আত্মবিশ্বাসের আগে প্রমাণ।
3. **Footprint Mindset** — সমস্যার সমাধান পৃথিবীর কোথাও না কোথাও আগে হয়েছে; আগে পদচিহ্ন খুঁজো।
4. **Tool Before Guess** — টুল থাকলে অনুমান নয়, টুল ব্যবহার করো।
5. **State Uncertainty** — নিশ্চিত না হলে তা স্পষ্টভাবে বলো।
6. **Normalize Everything** — প্রোভাইডার যেই হোক, আউটপুটকে অভিন্ন কাঠামোতে রূপান্তর করো।
7. **Respect Reality** — বাস্তব তথ্য কল্পনার চেয়ে গুরুত্বপূর্ণ।
8. **Explain Your Reasoning** — সম্ভব হলে সিদ্ধান্তের ভিত্তি ব্যাখ্যা করো।
9. **Never Hide Errors** — ভুল লুকিও না; রিপোর্ট করো।
10. **Technology For Everyone** — জ্ঞান ভাগ করে নেওয়াই লক্ষ্য।

Principle: **প্রথমে প্রমাণ, তারপর সিদ্ধান্ত। প্রথমে সত্য, তারপর আত্মবিশ্বাস।**

### 2.3 The policies that govern how work is done

| Policy | Rule |
| --- | --- |
| Hallucination | No Evidence → No Verified Answer → say "Unknown" / "Unable to Verify". |
| Regression safety | Fix One → Check All → Nothing Broken? → Approve. |
| Dual validation | **Engineer validation** (terminal, exit code, logs, API response) **and user validation** (browser, click, UX) must both pass. |
| Consensus | Collect → Compare Evidence → Resolve Conflicts → SSOT Validation → Final Answer. No single agent's opinion is final. |
| Communication | Normal, plain Bengali with the user; keep code, API names, commands, filenames, library names in their original form. |
| Engineering | We do not claim to discover new truth; we verify existing information and admit uncertainty. |

> **Source note (honesty):** the shared persona states it is taken from a
> project "Agent Architecture document". That source document is **not present
> in this tree**. The rules above are therefore the current SSOT by code
> (`src/policy/shared-persona.js`), and are labelled `SOURCE_VERIFIED` against
> the code, not against the missing document.

### 2.4 The evidence vocabulary

Every result must carry one of these labels. Using "pass" for a check that was
not run is a lie.

| Label | Meaning |
| --- | --- |
| `SOURCE_VERIFIED` | read from source / authoritative data, not executed |
| `CONFIG_VALIDATED` | configuration parsed and accepted |
| `LIVE_PROBE_PASSED` | a real call against a running instance succeeded |
| `END_TO_END_TESTED` | the full path executed and was observed |
| `NOT_TESTED` | not run |
| `UNVERIFIED` | declared but not proven |

A documentation statement or a `file:line` citation is **not** runtime proof.

---

## 3. What was done, where, how, and why

This section is the record. Each row is a decision that shaped the design, with
the reason it was made.

### 3.1 The provider and masking layer

- **Where:** `src/providers/` (`adapters/`, `capabilities.js`), `src/network/`.
- **How:** providers are registered from configuration, their model catalogs are
  synced, and requests are routed by priority with failover and a circuit
  breaker on repeated upstream failure.
- **Why:** a client must never learn which upstream provider or model answered.
  The public identity is always `{name:"ZombieCoder", id:"masked"}` plus a
  stable alias (`zombie-mini`, `zombie-lite`, `zombie-classic`). This is a
  product requirement, not an aesthetic one.

### 3.2 The agent layer

- **Where:** `src/agents/` (12 agent modules + `registry.js`,
  `persona-registry.js`, `system-prompt.js`, `access.js`).
- **How:** personas live in the **database** with a fallback to the agent `.js`
  file. A row saved through the admin API is `source:'admin'` and is never
  overwritten by the runtime; file-owned rows are refreshed by `ensureDefaults()`
  and keep a bounded `personaHistory`.
- **Why:** an operator must be able to edit a persona and have the change take
  effect, without the runtime clobbering it on the next boot. At the same time
  the agent's role can never override the shared persona (§2.2).

### 3.3 The tool layer

- **Where:** `src/tools/` (registry, selection), `src/execution/`
  (`tool-loop.js`, `tool-adapter.js`, `path-boundary.js`).
- **How:** 28 tools are registered and **all 28 are runnable** (an entry, status
  `ENABLED` or `VERIFIED`). A tool the runtime cannot run is not listed at all —
  see §3.15. Tool *access* is global
  (`TOOL_ACCESS_MODE=unrestricted`); path *scope* is per-agent
  (`global` | `working-directory`) with a `working_directory`.
- **Why:** two different concerns were deliberately separated. "Which tools may
  this agent use?" and "which paths may it touch?" are not the same question,
  and conflating them was the source of earlier confusion.

### 3.4 The tool surface is narrowed per request

- **Where:** `src/tools/selection.js`.
- **How:** the surface sent to the model is a set of always-on core tools
  (`read_file`, `list_directory`, `grep_search`, `file_search`, `note_store`)
  plus the purpose families the user's message actually needs. An explicit
  `toolIds` or a resolved `taskPolicy.allowedToolHints` always wins.
  `TOOL_SURFACE_MODE=full`, `toolSurface:"full"`, or explicit `toolIds` opt out.
  The decision is reported in `meta.toolSurface` with a `reason`.
- **Why:** an agent uses five to seven tools at a time, not seventy. Sending the
  whole catalog wastes context and invites the model to pick the wrong tool.

### 3.5 The prompt is dieted

- **Where:** `src/context/compiler.js`, `src/context/context-budget.js`,
  `src/agents/system-prompt.js`.
- **How:** `COMPILED_CONTEXT_BYTES` default is **20 KB**;
  `COMPILED_CONTEXT_PROMPT_CHARS = 24000`. The in-prompt `TOOL CATALOG` is
  included only when the selected route candidate does not have
  `nativeFunctionCalling`; the `TOOL CALL FORMAT FALLBACK` only when
  `nativeToolCalling` is false.
- **Why:** a large system prompt is the opposite of intelligence. The agent
  should *look things up*, not *memorise them*. The relevance rule: a title
  match (or an `always`-listed section) gets the full `MAX_SECTION_CHARS`; a
  body-only match gets a smaller body allowance.

### 3.6 The context layer and the note store

- **Where:** `src/context/` (`ssot.js`, `syllabus.js`, `memory.js`,
  `project-context.js`, `resolver.js`, `auto-setup.js`).
- **How:** four boundaries — SSOT, syllabus, memory, notes. The note store is
  per project root at `.zombiecoder/agents/notes.json`, written atomically,
  bounded by `NOTES_MAX_ENTRIES`, and it **never** reads `process.cwd()`.
- **Why:** there was no agent-writable memory, and that was a deliberate product
  decision, not a defect — an agent should not silently accumulate state. A
  separate, explicit, small note store was added instead. The `process.cwd()`
  rule exists because file-path pain caused real problems before; a relative
  root now throws `note_root_must_be_absolute` rather than resolving somewhere
  unexpected.

### 3.7 One authorization decision per request

- **Where:** `src/context/project-context.js` (`root()`, `trustRoot()`),
  `src/server.js` (`resolveAgentScope`).
- **How:** a root authorized by the agent scope is remembered via
  `ProjectContextStore.trustRoot()` so downstream services (SSOT, syllabus,
  memory, auto-setup) do not re-check it against `PROJECT_ROOTS`. Additive
  only; fails closed on a non-existent path; returns `null` when no allowlist
  is configured.
- **Why:** the runtime was refusing a project root that the agent scope had just
  authorized — a self-contradiction. The fix makes authorization a single
  decision, not a series of re-checks.

### 3.8 The execution lifecycle

- **Where:** `src/execution/` (`lifecycle.js`, `orchestrator.js`,
  `contract.js`, `evidence/`, `src/evidence/gate.js`).
- **How:** `goal → plan → consent → execute → verify`. Consent-gated tools
  refuse to run without `"consent": true`. Observed evidence is distinct from
  verified evidence; only the latter sets `meta.verified`.
- **Why:** "Consent Before Risky Action" and "Expected vs Actual Result" are
  constitution principles. They are enforced, not documented.

### 3.9 The MCP client and server

- **Where:** `src/mcp/` (client, server, sessions, security, schema,
  `external-surface.js`), `external-mcp/`.
- **How:** the client consumes external MCP servers declared in
  `external-mcp/servers.json` (env fallback); the server exposes 26 tools to
  MCP clients over Streamable HTTP at `POST /mcp`. A **discovered** endpoint's
  tools are offered in the agent's surface as function definitions bound to
  their qualified name, and the tool loop routes the call to the MCP adapter —
  the same mechanism it uses for a native tool.
- **Why:** the runtime should be usable both as a consumer and as a provider of
  tools, and a remote tool should be as reachable as a local one. Two outbound
  facts are handled explicitly rather than assumed: **TLS** (`MCP_TLS_CA_FILE` /
  per-endpoint `caFile`, because Node verifies certificates and an internal CA
  is normal), and **transport** (`http` | `sse` | `grpc`; a `grpc` endpoint fails
  closed with `mcp_transport_grpc_requires_bridge` because the runtime does not
  embed a protobuf compiler).

### 3.10 The memory reporting

- **Where:** `src/runtime/memory.js`, wired into `src/server.js` and
  `GET /v1/admin/metrics` and the admin Metrics page.
- **How:** `runtime.memory` is logged at startup and on an interval
  (`MEMORY_LOG_INTERVAL_MS`, default 60000, `0` disables). The timer is
  `unref()`'d.
- **Why:** heap and RSS must be visible again. A process that silently grows is
  a process nobody can operate.

### 3.11 The browser pipe

- **Where:** `src/browser/cdp-pipe.js`.
- **How:** the Chrome DevTools Protocol over pipes. Convention: Chrome **reads
  fd 3** and **writes fd 4**; the parent writes `stdio[3]` and reads `stdio[4]`.
  `openTarget()` prefers `Target.createTarget` and falls back to an existing
  `type:'page'` target.
- **Why:** it was modernised rather than deleted, and its external URLs were
  removed because they were not ours. The fd convention was confirmed by a live
  probe after a test fixture had it backwards — evidence corrected the guess.

### 3.12 The fresh-machine bootstrap

- **Where:** `scripts/bootstrap.sh`, pinned by `tests/phase70-bootstrap.test.js`.
- **How:** it finds what exists and installs only what is missing. It never
  overwrites an existing `.env`, never runs `git reset` / `clean`, never
  `rm -rf`, never `--force`, never sets `ZOMBICODER_EXECUTION_MODE`, and never
  configures a proxy (that stays in the root-only
  `scripts/setup-os-runtime.sh`). `ZC_SKIP_SYSTEM=1` never calls apt;
  `ZC_NO_START=1` never offers to start.
- **Why:** reinstalling the main OS should be one command, and a bootstrap
  script that destroys state is worse than no script. The test reads
  executable lines only (comments stripped), because the header names the
  commands the script refuses to run.

### 3.13 The documentation set

- **Where:** `docs/`, `README.md`, `IMPLEMENTATION_MANIFEST.md`,
  `CHANGELOG.md`, `.env.example`, `tests/`.
- **How:** the README is the map; the manifest is the per-phase record; the
  changelog is the release history; `.env.example` documents every key; the
  tests are the executable specification.
- **Why:** an agent that has to guess will guess wrong. The map must be complete
  and honest, including what is *not* implemented.

### 3.14 The stream carries one token on one channel

- **Where:** `src/execution/tool-loop.js` (`stream()`), `src/server.js`
  (`/v1/chat/completions` with `stream:true`), `tests/phase72-stream-single-channel.test.js`.
- **What:** a streamed token is written once, as an OpenAI-compatible `data:`
  frame. The `event: runtime` channel carries lifecycle only (`assistant`,
  `tool_result`, `tool_error`, `stream_chunk`, `complete`) and no token text.
- **How:** the tool loop used to write each masked chunk twice — once via
  `onChunk` (a `data:` frame) and once via `onEvent({type:'stream_chunk', chunk})`
  (a `runtime` event). `stream_chunk` is now a payload-free progress marker that
  keeps only `round` and, on the fallback path, `fallback`.
- **Why:** measured live with `autoToolLoop:true`, a 3-token answer produced 7
  `data:` frames **and** 7 byte-identical mirrors. Any client that concatenated
  both channels, or listened on the runtime channel, doubled every answer. One
  token, one channel is also what the sibling Mission Barisal engine does (all
  twelve of its events ride the single `data:` channel with a `type` field).
- **Proof:** before the fix the two channels were identical
  (`dataText === runtimeText === "ALPHA BRAVO CHARLIE"`); after it the runtime
  channel is empty and `data:` still carries the whole answer.

### 3.15 A tool the runtime cannot run is not in the list

- **Where:** `src/tools/common-defaults.js` (the declarations),
  `src/tools/registry.js` (the read-time reconciliation),
  `tools/common/web_tools.js` (the two network tools).
- **What:** the registry only lists tools that can actually execute. There is no
  `NOT_IMPLEMENTED` or `UNVERIFIED` tier left.
- **How:** `COMMON_TOOLS` is the single source for code-owned rows. On every
  read the registry (a) **retires** a code-owned row the code no longer declares,
  so `git pull` can remove a phantom tool and not only add one, and (b) refreshes
  `status` from the code unless the saved status is `DISABLED`, which is the one
  value an operator writes from the global tool switch.
- **Why:** seven tools used to be registered without an implementation — three
  `NOT_IMPLEMENTED` and four `UNVERIFIED` external-MCP placeholders. The agent
  never saw them (`canResolveManifest` excludes them) but the operator did, and a
  list that ships seven names it cannot run is worse than a short list that is
  true. `web_search` and `fetch_web_page` are now real; `delegate_subagent` was
  removed (agent choice is a request field, not a tool); the four external
  capabilities are declared once, in `external-mcp/servers.json`.
- **Proof:** live registry reads `28 tools | 28 runnable | 0 unavailable`.
  `fetch_web_page` fetched `https://example.com` through the chat tool loop and
  returned `Example Domain`. `web_search` reported `search_backend_not_configured`
  with no backend and returned normalized results with one.

### 3.16 One error shape, and it is the one clients actually read

- **Where:** `src/http/json.js` (`send`), `src/server.js` (the chat route),
  `src/providers/masking/provider-mask.js` (`logprobs`).
- **What:** every 4xx/5xx body is the OpenAI error envelope
  `{error:{message,type,param,code}}`. The success shapes — `chat.completion`,
  `chat.completion.chunk`, `/v1/models` — were already correct.
- **How:** `send` rewrites a string `error` into the envelope on the way out, so
  none of the 144 call sites had to change. `code` and `message` carry the same
  value, `type` is derived from the status (`invalid_request_error` /
  `rate_limit_error` / `server_error`), and `param` is taken from the body when
  the caller passed a string. A success body is never touched. Sibling fields the
  handler added (`executionMode`, `required`, `toolId`) survive next to `error`.
- **Why:** an OpenAI SDK reads `error.message` and guards the lookup with a bare
  `except`, so a string `error` degraded silently to "Error code: 401" with no
  reason — easy to miss, impossible for a client to act on. The chat route also
  accepted a request with neither `messages` nor `goal` and answered it with a
  completion about the literal string "chat request", hiding a client bug.
- **Proof:** live — 400 `messages_required` (with `param:"messages"`), 401
  `application_unauthorized_or_expired` and 404 `not_found` all carry the
  envelope; a 200 chat response still carries `choices[0].logprobs = null`.
  `tests/phase74-openai-compat.test.js` (8 tests) pins the envelope, the status
  mapping and the `logprobs` rule.

### 3.17 A channel plan is data, not prose

- **Where:** `src/channels/catalog.js`, `GET /v1/admin/channels`,
  `src/agents/ecommerce-tool-boundaries.js` (`channels`), and the `Channels` view in
  `public/admin/index.html`.
- **What:** the four messaging channels the business needs — Facebook Messenger,
  Facebook comments, WhatsApp Cloud API, and read-only Facebook Ads insights — are
  declared once as data, together with the scopes, the webhook object and field, the
  reply window, and the rules that decide whether a reply is allowed at all.
- **How:** `CHANNELS` is a frozen array; `channelSummary()` is what the admin route
  returns. Every channel is `status: 'PLANNED'` and names its `blockedBy`. The
  e-commerce boundary files name the channels their agent serves, and the test
  validates every id against the catalog, so a typo fails the suite instead of
  becoming a silent no-op.
- **Why:** the reply window *is* the product. A Messenger reply outside the 24-hour
  window, a second private reply to a comment, or a WhatsApp message to a number that
  never opted in is a policy violation, not a bug to patch later — Meta's response is
  a restricted app. Keeping the rule next to the channel, pinned by a test, is cheaper
  than rediscovering it from Meta's documentation during an incident. The declaration
  is also honest: nothing behind it calls Meta, and the status says so.
- **Proof:** `GET /v1/admin/channels` returns `4 declared / 4 planned / 0
  implemented` with the scopes and windows above; `tests/phase75-channels.test.js`
  (7 tests) fails if a window, a scope or the one-message limit is changed.

### 3.18 The inbound MCP server is opt-in, and says so when it is off

- **Where:** `src/server.js` (the `/mcp` block), `src/config/env.js`
  (`mcpServerEnabled`, `mcpServerProjectRoot`), `src/mcp/server.js`,
  `src/mcp/server-auth.js`.
- **What:** `POST /mcp` serves Streamable HTTP MCP only when
  `MCP_SERVER_ENABLED=true`. `DELETE /mcp` ends a session (`204`); `GET /mcp` is
  `405` with `allow: POST, DELETE`. With the server off, every method on `/mcp`
  answers `501 mcp_server_not_implemented` with the role (`mcp-client`) and the
  supported protocol versions — a recognised path that explains itself, never a
  bare `404`.
- **How:** `initialize` returns `mcp-session-id` and the preferred
  `mcp-protocol-version`; the body's `result.protocolVersion` is the version
  *negotiated with the caller*. Authentication follows the `requireAuth` policy
  (`GET /v1/admin/mcp/auth`); when it is `false` an unauthenticated call is still
  attributed to an auto-provisioned application, so sessions, per-application tool
  permissions and the audit trail keep an owner. A presented key always wins.
- **Why:** advertising a server capability that is switched off would be a lie
  about the surface, and a `404` would send an integrator hunting for a typo.
- **The root:** `MCP_SERVER_PROJECT_ROOT` is the root the server's tools operate
  inside and it defaults to **empty**, which falls back to `DATA_DIR` — so a tool
  call resolves against `data/`, not the project. Measured: `read_file README.md`
  answered `File not found: <root>/data/README.md`. Whether a tool may leave that
  root is `TOOL_ACCESS_MODE` (`permissioned` keeps the boundary, `unrestricted`
  does not).
- **Proof:** live — `initialize` → `200` + session id + `mcp-protocol-version:
  2025-11-25`; `notifications/initialized` → `202`; `tools/list` → **28 tools**,
  all with an object `inputSchema`; `tools/call` → `200` with the output in
  `result.content[0].text`; unknown tool → `-32602 unknown_tool`; `DELETE` →
  `204`; a clean-env instance with the server off → `501` carrying the error
  envelope plus its sibling fields. The operator-facing walkthrough, the
  post-restart checklist and the troubleshooting table are in
  `docs/FRESH_INSTALL.md`.

### 3.19 The zero-dependency rule is enforced, not assumed

- **Where:** `scripts/check-zero-deps.mjs` (the guard),
  `tests/phase76-zero-deps.test.js` (the rule in the suite), `.gitignore`
  (insurance), `package.json` (`check:zero-deps`).
- **What:** this project declares no dependencies, has no lockfile, and must have no
  `node_modules`. Any one of the three appearing is a failure. The test runner is
  `node --test`; a script that names vitest, jest, mocha, ava or tape is a failure
  too.
- **The incident this comes from:** on 2026-10-16 at 22:11:46 a `npx vitest` was run
  in this directory — npm cached vite 8.3.4 and its tree under `~/.npm/_npx`. At
  22:12:00 vitest ran `tests/phase23-system-session.test.js`, which failed, and wrote
  `node_modules/.vite` and `node_modules/.vitest-cache` into the working tree. The
  test failed for a plain reason: that file imports `node:test`, and vitest cannot
  run a `node:test` file. It was simply the wrong runner.
- **Why it matters more than it looks:** `node_modules/` is gitignored, so the
  repository was never affected — 0 files tracked, the tree committed clean. What
  was affected is the *impression*. A `node_modules` directory in a project whose
  whole design is that it has none makes the next person ask whether dependencies
  were added, and a wrong answer there is expensive. The failure is silent, so the
  rule has to be checked rather than remembered.
- **How:** the guard reads `package.json`, refuses any non-empty dependency field,
  refuses a `scripts.test` that is not `node --test`, refuses a script that names a
  forbidden runner, probes every lockfile name an installer could leave, and refuses
  the mere existence of `node_modules` (an empty one included — something created
  it). It is runnable on its own and is applied on every suite run.
- **Proof:** the guard exits `0` on this repository and exits `1` on the exact
  incident shape, reproduced by hand (`mkdir -p node_modules/.vitest-cache` →
  `node_modules exists — 1 entry/ies: .vitest-cache`). `phase76` (7 tests) covers a
  declared dependency, a lockfile, a wrong `test` script, a forbidden runner name,
  an empty `node_modules`, and that a synthetic clean root passes. The stray was
  removed surgically — only the two cache directories, then the empty parent — after
  proving it held no `package.json` and that the running process had zero
  `node_modules` mappings.

### 3.20 The constitution is policy, so it is written down and checked

- **Where:** `src/policy/constitution.js`, `src/agents/system-prompt.js`
  (`constitutionRules`), and `GET /v1/admin/constitution`.
- **What:** each of the six rules now carries the sentence it stands for. The name
  is what an operator skims and what the admin route has always returned; the
  statement is what the model is given as the `NON-NEGOTIABLE RULES` block, and what
  a reviewer can hold the runtime to.
- **How:** `statementFor(name)` turns a name into `name — statement` and passes any
  other text through untouched, so a caller's own rule (an operator persona, a test)
  is never rewritten and can never become `[object Object]`. `constitutionRules()`
  maps through it, so all five prompt call sites benefit from one change. With no
  constitution passed, the prompt falls back to the real rules rather than to a
  second, shorter paraphrase — a paraphrase is a copy, and a copy drifts.
  `GET /v1/admin/constitution` gained `statements` alongside the existing
  `constitution`, additively.
- **Why:** a rule name is a slogan, and the first thing that gets softened when a
  `404` is easier to write than an explanation is a slogan. The operator's
  instruction is that the rules carry no exceptions, so each rule has to be
  expressible as something a test can check rather than as a sentiment everyone
  interprets for themselves.
- **Proof:** LIVE_PROBE_PASSED — `GET /v1/admin/constitution` returns six names and
  six statements, and the chat response reports the same six rules the prompt was
  built from. `tests/phase77-constitution.test.js` (8 tests) pins that every name has
  a statement, that no statement is orphaned, that "Never Hide Errors" names 501,
  503 and 404 plus the phrase "off is off", that the statements actually reach the
  prompt, that a caller's own rule survives untouched, and that the whole block stays
  inside a prompt budget (<= 1600 chars — it goes into every system message).

---

## 4. The map — where each concern lives

```
src/
  server.js      the HTTP surface and every route
  admin/         admin control-plane service
  agents/        12 agent modules, registry, persona registry, system prompt
  auth/          admin and application authentication
  browser/       CDP pipe
  compatibility/ legacy route + feature reconciliation
  config/        environment loading and parsing
  context/       SSOT, syllabus, memory, compiler, project context, auto-setup
  core/          ids, logger
  entities/      entity door
  evidence/      evidence gate
  execution/     lifecycle, orchestrator, tool loop, adapters, task policy
  http/          json + security headers
  mcp/           MCP client and server
  network/       circuit breaker, outbound policy
  notes/         the agent-writable note store
  policy/        constitution, shared persona
  providers/     provider registry, adapters, capabilities
  registry/      generic catalog / resolver for code-owned defaults
  runtime/       version, memory
  session/       session client, service, state, metadata sanitising
  skills/        skill registry
  startup/       allowlist guard, provider bootstrap
  storage/       JSON store and SQLite store
  tools/         tool registry and surface selection
  transport/     HTTP / HTTPS / Unix-socket transport
tests/           68 files — the executable specification
docs/            this document, OBSERVABILITY.md, LARAVEL_INTEGRATION.md
external-mcp/    external MCP server declarations
integration/php/ dependency-free PHP client
scripts/         bootstrap, OS runtime setup, deployment verification
.zombiecoder/    runtime workspace: SSOT, syllabus, evidence gate, notes
```

---

## 5. Invariants — do not break these

1. **Never fabricate evidence.** Do not log a success that did not happen.
2. **Never hide an error.** Represent it as a tool-result error or an API error
   and keep it observable. Report the code and the reason, and never answer with
   silence.
3. **Never invent a model ID.** The public identity is a ZombieCoder alias;
   upstream IDs live only in the authenticated admin catalog.
4. **Consent before risky action.** A consent-gated tool runs only with
   `consent: true`.
5. **Observed ≠ verified.** Only verified evidence may set `meta.verified`.
6. **One authorization decision.** Do not re-check a root that the agent scope
   already authorized.
7. **The note store never reads `process.cwd()`.** Resolve against the project
   root.
8. **Admin-saved personas are never overwritten** by `ensureDefaults()`.
9. **Do not delete a test to make the suite green.** A failing test is either
   fixed or documented as failing.
10. **Do not widen a frozen area.** Path scoping (`working-directory` mode) is
    frozen; rename only with backward-compatible aliases, never remove.
11. **Masking is absolute.** No code path may leak a provider or model id to an
    unauthenticated client.
12. **A declaration is not a health claim.** An MCP endpoint declared in
    `servers.json` that cannot be reached stays in `error` and is reported.
13. **One token, one channel.** A streamed token is written once, as a `data:`
    frame. A `runtime` event must never repeat token text.
14. **Absent is not the same as switched off.** A known path that is not serving
    must say what it is and why: `501 mcp_server_not_implemented` when the MCP
    server is off, `503 tool_execution_not_verified` when execution is
    `chat-only`. `404` is reserved for a path that genuinely does not exist. An
    empty or silent response is never an option — success is success, failure is
    failure, off is off. The operator's standing instruction is that this has no
    exceptions.

---

## 6. What is not done — carried forward honestly

| Item | Status | Notes |
| --- | --- | --- |
| Messaging channels (Messenger, comments, WhatsApp, Ads insights) | declared, `PLANNED` | `src/channels/catalog.js` records the plan, the scopes, the reply windows and the blockers; `GET /v1/admin/channels` reports it; `tests/phase75-channels.test.js` pins it. No webhook receiver, no Graph call and no reply exists. Blocked on per-application credentials (below). Plan: `docs/FACEBOOK_CHANNELS.md` |
| `facebook-ads` transport | declared `grpc`, refused with `mcp_transport_grpc_requires_bridge` | points at an internal gRPC service, not the Graph API — the Graph API is REST/JSON and must not be sent down this path. Needs a JSON/HTTP facade in front of the gRPC service. See `docs/FACEBOOK_CHANNELS.md` §1.4 |
| Path scoping (`working-directory` mode) | frozen | feature deferred, not removed |
| `grep_search` / `file_search` / `find_files` outside the project root | not implemented | they take no path argument |
| `src/providers/manifest.js`, `src/providers/openai-compatible.js` | dead files | measured; not removed |
| Stale `working_directory` on two agents | measured, not changed | frozen area |
| `process.cwd()` in `projectAllowedRoots` | measured, not changed | too invasive for a frozen area |
| `phase49` protocol-version test | failing | asserts `2025-06-18`; stale assertion |
| `server-side PHP integration client` test | failing | no `php` on the build host |
| `instances/zc-10001/.env` dead MCP keys | left in place | deliberately untouched |
| Per-application MCP credentials | `NOT_IMPLEMENTED` | an external MCP endpoint carries one credential set on the endpoint (`endpoint.headers`, set at registration). Injecting each application's own token at call time is the next change; until then a per-shop token means a per-shop endpoint. Documented in `docs/LARAVEL_INTEGRATION.md` §18.7 |

Regression baseline at the time of writing: **376 tests, 375 pass, 0 fail, 1 skipped** (the skip is the PHP syntax check: no `php` binary here, reported as NOT_TESTED)
(both listed above). The two failures are left failing rather than silenced.

---

## 7. What we will do next — start, how, end

This section tells the next agent where to begin and where to stop.

### 7.1 Where to start

Start from the **unfinished items in §6**, in this order of value:

1. **The messaging channels** — `docs/FACEBOOK_CHANNELS.md` §9 gives the build
   order and the exit condition for each step. Build the window, the dedupe and the
   credential before the reply text: a working reply behind a broken window is a
   policy violation, and a broken window stays invisible until Meta acts on it.
   Nothing in that plan can be verified before item 2.
2. **Per-application credentials** — see §6. This is the blocker for "each shop
   brings its own Meta token", and therefore for every channel above. The smallest
   version: a write-only per-application credential store, resolved at call time in
   `src/execution/mcp-adapter.js` (which already receives the application id).
3. **The `facebook-ads` gRPC endpoint** — put a JSON/HTTP facade in front of the
   gRPC service and declare that facade as an `http` endpoint. Do not widen the
   HTTP client to guess gRPC: the message shape and method path come from a
   `.proto` schema and cannot be derived from a URL. Note that the Graph API path
   in `docs/FACEBOOK_CHANNELS.md` §5 is REST/JSON and does **not** go through this
   endpoint.
4. **The two failing tests** — fix the `phase49` assertion to the current
   negotiated version, and either make the PHP test skip cleanly when `php` is
   absent or install `php` in the verification environment.
5. **The external capability endpoints** (`public_api`, `tts`, `ocr`) — configure
   a reachable endpoint and verify them end-to-end, or leave them declared and
   unreachable. A discovered endpoint's tools already reach the agent's surface,
   so no runtime code is missing here.

### 7.2 How to start

Follow the method in §8. Concretely:

```bash
# 1. read the ground truth before touching anything
cat README.md docs/DESIGN_FLOW.md
curl -s http://127.0.0.1:9999/v1/admin/routes | head -c 400
node --test 2>&1 | grep -E "tests |pass |fail "   # record the baseline

# 2. make the smallest change that fixes the problem
# 3. run the applicable checks (see §9)
# 4. commit and push
git add -A && git commit -m "<what changed and why>"
git push origin main
```

Restart the runtime after any `src/` change:

```bash
node start.js --stop && npm start
```

### 7.3 Where to end

A piece of work is finished when **all** of the following are true:

- The change is the smallest one that solves the problem.
- Syntax, static, unit, integration, and (where applicable) browser checks pass.
- Every check that was **not** run is explicitly labelled `NOT_TESTED`.
- Documentation is updated if behaviour changed.
- The regression baseline is recorded and no new test fails.
- The result is pushed to `origin/main`.
- No invariant in §5 was broken.
- Engineer validation **and** user validation both passed (§2.3).

Do not declare done on the strength of a green test alone. A green unit test is
not proof that the user journey works.

---

## 8. The method — how a change is made here

This is the working order. It is not optional.

1. **SSOT first.** Find the authoritative source before you write anything.
   For behaviour: the code and the tests. For routes: `GET /v1/admin/routes`.
   For configuration: `.env.example`. For rules: §2.
2. **Logic next.** State the smallest correct change and why. If two designs
   are possible, pick the one that respects the invariants in §5.
3. **Code last.** Write it. Keep it small.
4. **Evidence.** Run the check. Record the real output. Label it.
5. **Regression.** Fix One → Check All → Nothing Broken? → Approve.
6. **Consensus.** For a non-trivial decision: Collect → Compare Evidence →
   Resolve Conflicts → SSOT Validation → Final Answer.
7. **Report honestly.** If something failed or was skipped, say so.

A model's confidence is not evidence. A file:line citation is not runtime proof.
A documentation sentence is not a passing test.

---

## 9. The verification layers

Run the layers that apply and label the rest `NOT_TESTED`.

| Layer | How |
| --- | --- |
| Syntax | `node --check <file>` for each changed file |
| Unit / integration | `node --test` (68 files) |
| Contract | `GET /health`, `GET /v1/admin/routes`, `GET /v1/admin/constitution` |
| Live probe | real HTTP calls against a running instance |
| End-to-end | the full suite (`zc-full-suite.mjs`) exercising all agents and tools |
| Browser | `tools.browser.*` against the admin console / chat page |
| User journey | a human follows the flow and confirms it works |

The suite script and its evidence live outside this repository (on the
operator's machine) and produce a JSON report plus an HTML page. Treat its
output as evidence, not as the only evidence.

---

## 10. Anti-patterns — what not to do

These were observed in an ancestor repository and must not be repeated.

- **One giant file.** A 499,888-byte single `api.js` is not architecture. Keep
  boundaries.
- **Documentation that contradicts the code.** A README that claims model
  masking while a `PERSONAS.md` leaks real model names is worse than no README.
  Documentation must match behaviour.
- **Coercive persona language.** A persona that orders an agent to obey is not
  a rule; the constitution is. Role behaviour is additive and bounded.
- **Silencing a failing test.** Fix it or document it. Never delete it to get a
  green suite.
- **Guessing a file path.** Resolve against the project root. Do not trust
  `process.cwd()`.
- **Claiming a pass without running the check.** That is fabrication.
- **Sending the whole tool catalog to the model.** Narrow the surface.
- **Adding a dependency to solve a small problem.** The runtime runs on Node's
  default modules where it can.

---

## 11. Related documents

| Document | Contents |
| --- | --- |
| `README.md` | the runtime as a whole, and the honest limitations |
| `docs/LARAVEL_INTEGRATION.md` | the PHP/Laravel HTTP contract |
| `docs/FACEBOOK_CHANNELS.md` | the messaging-channel plan: rules, blockers, build order |
| `docs/FRESH_INSTALL.md` | fresh-OS install, MCP client connection, post-restart checklist |
| `docs/OBSERVABILITY.md` | logging, diagnostics, troubleshooting |
| `IMPLEMENTATION_MANIFEST.md` | the per-phase implementation record |
| `CHANGELOG.md` | release history |
| `GET /v1/admin/routes` | authoritative, machine-readable route inventory |
| `GET /v1/admin/constitution` | the constitution as JSON |
| `.env.example` | every configuration key |
| `tests/` | the executable specification of current behaviour |
