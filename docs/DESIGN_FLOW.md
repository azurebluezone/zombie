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
- **How:** 33 tools are registered; **26 are runnable** (status `ENABLED` or
  `VERIFIED` with an entry). Tool *access* is global
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
   and keep it observable.
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

---

## 6. What is not done — carried forward honestly

| Item | Status | Notes |
| --- | --- | --- |
| `web_search`, `fetch_web_page`, `delegate_subagent` | `NOT_IMPLEMENTED` | registered, no entry |
| `public_api`, `tts`, `ocr`, `facebook_ads` | `UNVERIFIED` | endpoint env vars unset; never called |
| `facebook-ads` transport | declared `grpc`, refused with `mcp_transport_grpc_requires_bridge` | needs a JSON/HTTP facade in front of the gRPC service |
| Path scoping (`working-directory` mode) | frozen | feature deferred, not removed |
| `grep_search` / `file_search` / `find_files` outside the project root | not implemented | they take no path argument |
| SSE token delivered twice | measured, not changed | `onChunk` `data:` frame + `onEvent` `stream_chunk` mirror |
| `src/providers/manifest.js`, `src/providers/openai-compatible.js` | dead files | measured; not removed |
| Stale `working_directory` on two agents | measured, not changed | frozen area |
| `process.cwd()` in `projectAllowedRoots` | measured, not changed | too invasive for a frozen area |
| `phase49` protocol-version test | failing | asserts `2025-06-18`; stale assertion |
| `server-side PHP integration client` test | failing | no `php` on the build host |
| `instances/zc-10001/.env` dead MCP keys | left in place | deliberately untouched |

Regression baseline at the time of writing: **329 tests, 327 pass, 2 fail**
(both listed above). The two failures are left failing rather than silenced.

---

## 7. What we will do next — start, how, end

This section tells the next agent where to begin and where to stop.

### 7.1 Where to start

Start from the **unfinished items in §6**, in this order of value:

1. **Capability tools** (`public_api`, `tts`, `ocr`, `facebook_ads`) — either
   configure a reachable endpoint and verify them end-to-end, or remove them.
   An `UNVERIFIED` tool that nobody intends to finish is a trap. The runtime side
   is ready: a discovered endpoint's tools already reach the agent's surface.
2. **The `facebook-ads` gRPC endpoint** — put a JSON/HTTP facade in front of the
   gRPC service and declare that facade as an `http` endpoint. Do not widen the
   HTTP client to guess gRPC: the message shape and method path come from a
   `.proto` schema and cannot be derived from a URL.
3. **The two failing tests** — fix the `phase49` assertion to the current
   negotiated version, and either make the PHP test skip cleanly when `php` is
   absent or install `php` in the verification environment.
4. **The three `NOT_IMPLEMENTED` tools** — implement or remove.

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
| `docs/OBSERVABILITY.md` | logging, diagnostics, troubleshooting |
| `IMPLEMENTATION_MANIFEST.md` | the per-phase implementation record |
| `CHANGELOG.md` | release history |
| `GET /v1/admin/routes` | authoritative, machine-readable route inventory |
| `GET /v1/admin/constitution` | the constitution as JSON |
| `.env.example` | every configuration key |
| `tests/` | the executable specification of current behaviour |
