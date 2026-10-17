## Phase 43 implemented

- Resolved legacy External MCP declaration sources with `EXTERNAL_MCP_URLS` kept as a comma-separated list.
- Disabled server declarations are not registered. Conflicting server IDs fail closed; exact duplicates collapse.
- Registration failures return stable safe error codes rather than raw exception messages.
- Status exposes disabled/configuration-only/configuration-missing/identity-conflict states without claiming discovery or health.
- The supplied legacy archive includes `api.js` and `external-mcp.js` but lacks individual `external mcp/*.js` implementations; their behavioral parity remains unverified.
- Regression suite: 150 passed, 0 failed. Runtime boot smoke: HTTP 200, version 0.43.0, phase 43.


## Phase 29 implemented

- Database-first application tool capability JSON with environment fallback.
- Existing tool permission table remains a separate execution authorization boundary.
- Common tools registered once and persisted in the existing `tools` collection.
- External MCP registry with folder/environment definitions and database precedence.
- Admin routes for capability state and External MCP registry/sync.
- Real common-tool adapter tests and failure-case regression coverage.
# Implementation Manifest — v0.49.0

## Verified baseline

- Phase 1–7 runtime foundations retained.
- Phase 8 modular core boundaries retained.
- Phase 9 execution contract retained.
- Phase 10 extension registries and Phase 11 resolution retained.
- Phase 12 provider execution and Phase 13 tool/MCP execution retained.
- Phase 14 provider adapters, evidence gate, agent boundary and application-owned sessions retained.
- Phase 15 bounded multi-round tool execution added.

## Phase 15 implemented

- Canonical tool-call extraction and stable argument signatures.
- Explicit `toolBindings` boundary from model function name to registered Tool or MCP qualified name.
- Automatic model → tool/MCP → tool result → next model turn when `autoToolLoop: true`.
- Maximum rounds, maximum tool calls per round, and repeated identical call guards.
- Tool execution errors are represented as tool-result error messages and remain observable; they are not hidden.
- Durable session message state in SQLite with application ownership checks and bounded history.
- Streaming tool-call assembly before tool execution.
- Multi-round streaming execution with runtime events.
- Observed execution evidence remains distinct from verified evidence.

## Verified in this environment

- `npm test`: 112 tests passed, 0 failed.
- Phase 15 contract fixture: real registered Tool module executed through the loop.
- Phase 15 contract fixture: tool result reached the second provider turn.
- Phase 15 repeated-call guard: stopped at configured limit without success claim.
- Phase 15 stream assembler: fragmented tool-call arguments reassembled correctly.
- No mock/demo/fake provider implementation is shipped in the runtime.

## Not implemented / not claimed

- Automatic retry after ambiguous remote side effects.
- Automatic promotion of tool execution evidence from `observed` to `verified`.
- Unbounded autonomous loops.
- Arbitrary model tool calls without explicit runtime binding.
- Full provider-specific parity for every multimodal/tool-call schema.
- Live external Ollama endpoint execution from this build environment; the supplied hostname remains DNS-unresolvable here.
- Production distributed locking/rate limiting, secret vault/KMS, and crash-level remote execution recovery.

No unverified capability is represented as completed.


Phase 16: native ENV loader, structured system JSONL logs, bounded log rotation, secret/payload redaction, and agent/persona observability.


## Phase 20 implemented

- Shared inbound request handler mounted on HTTP and UDS.
- Optional HTTPS listener using explicit certificate/key configuration.
- OpenAI-compatible SSE mode on `POST /v1/chat/completions` with `stream: true`.
- Node runtime client for HTTP/HTTPS/UDS plus SSE chat streaming.
- Transport registry now marks HTTP, UDS and SSE as verified by local contract tests; HTTPS remains unverified until live TLS smoke testing.


## Phase 25 implemented

- Runtime instance identity and per-runtime lock.
- Runtime-scoped default UDS boundary with fail-closed socket handling.
- Unified ExecutionContext.
- Canonical project/working-directory path containment and symlink protection.
- Application-scoped Tool Policy and admin permission routes.
- Realpath-constrained executable tool modules.
- Allowlisted session metadata and incremental SQLite session operations.
- Full regression: 112 passed, 0 failed.

## Phase 27 additions

- `src/execution/task-policy.js` — purpose-first task profiles and minimal tool surface.
- `src/compatibility/legacy/reconciliation.js` — legacy purpose reconciliation decisions.
- `tests/phase27-purpose-reconciliation.test.js` — phase 27 regression coverage.
- `docs/compatibility/api-feature-reconciliation-v0.27.md` — phase 27 decision record.
- `GET /v1/admin/compatibility/reconciliation` — admin reconciliation report.
- Runtime version/phase: `0.27.0` / `27`.

## Phase 28 additions

- Purpose-derived task surface is enforced inside the tool loop, not only at HTTP input filtering.
- `/v1/admin/task-profiles` exposes the current task-purpose profiles to admin control plane.
- Runtime/start script phase is 28.
- No legacy behavioral parity claim is added.


## Phase 32
- PHP integration boundary: `integration/php/ZombieCoderClient.php`
- Integration guide: `integration/php/README.md`
- Observability/failure contract: `docs/60-phase-31-php-integration-boundary.md`
- Request/trace correlation and HTTP outcome logging

## Phase 32
- Context compiler: session + SSOT + syllabus + project memory are compiled into bounded, validated JSON before system prompt injection.

## Phase 33

Runtime Reality & Outbound Troubleshooting — v0.33.0

- Fixed Node custom DNS lookup callback handling when `options.all === true`.
- Added a real local HTTP integration test that exercises the custom lookup through Node's HTTP client.
- Added bounded outbound circuit breaker with `closed -> open -> half-open -> closed` lifecycle.
- Added safe outbound failure diagnosis for DNS, timeout, connection, TLS and lookup-contract failures.
- Provider and MCP outbound request surfaces use the shared circuit protection.
- Circuit breaker never bypasses HTTPS, DNS pinning, private-address denial, or host allowlists.
- Added troubleshooting/runbook documentation.
- Full test suite: 108/112 passed.
- No provider credential is stored in source or documentation.


## Phase 34 — Runtime Reliability & Agent Integration Verification

- Fixed outbound custom DNS lookup callback compatibility with Node `options.all`.
- Added real outbound HTTP integration coverage.
- Added configurable outbound circuit breaker with 503/Retry-After behavior and 4xx exclusion.
- Added runtime version/phase identity sourced from `package.json`.
- Reused a single SmartRouter instance across provider execution and tool loop.
- Replaced runtime security/correlation IDs that used `Math.random()` with `randomUUID()`.
- Made session message errors fail accurately instead of converting every error to 404.
- Added runtime agent audit and ensured default agents remain resolvable when persisted custom agents exist.
- Added `/v1/admin/registry/agents/runtime-audit`.
- `/health` now reports actual module capability checks, agent runtime readiness and circuit-breaker configuration.

## Not implemented / not claimed

- No automatic source-code self-modification by the circuit breaker.
- No claim that every agent has an explicit tool boundary; only agents with an explicit boundary are marked as such.


## Phase 39
Execution lifecycle binds system prompt, session metadata, evidence gate, normalizer, provider fallback and tool-loop lifecycle.


## Phase 40 — Configuration Reliability & Tool Parity Ledger

- Explicit default-deny policy for local HTTP/private-network MCP; exact allowlist required.
- Local MCP fixture exercises real HTTP initialize/tools/list flow.
- `/v1/admin/compatibility/tools` inventories known legacy tools and runtime registrations without claiming behavioral parity.
- Regression: 135/135 passed.
- Live provider/MCP/browser verification remains environment-dependent and is not claimed.


## Phase 41 — Legacy Filesystem Tool Contract Alignment

- `read_file`, `write_file`, and `list_directory` now match the legacy MCP text-content output envelope and selected documented filesystem semantics.
- Actual local filesystem integration tests verify read truncation, missing/non-file handling, recursive writes, directory listing, and traversal/symlink rejection.
- Compatibility contract tested does not mean exact parity: the modular runtime intentionally keeps project-root containment while legacy `api.js` defaulted `AGENT_FS_SCOPE` to unrestricted.
- External MCP providers, screen recorder, combined MCP composition, live Gemini, and live Ollama refresh remain unverified/not migrated.


## Phase 42 — Verified in this environment

- Gemini `generate-content` capability is mapped to the runtime-facing `chat-completions` contract for the Gemini driver only.
- Provider network policy supports an explicit private-host exception list; private network access remains off by default.
- Actual local HTTP fixture exercised Gemini native request shape, API-key header, and canonical response mapping.
- Actual local HTTP fixture exercised `ProviderRegistry.refreshModels()` against an Ollama-compatible `/v1/models` endpoint and verified SQLite model persistence.
- `npm test`: 145 passed, 0 failed.
- Runtime boot smoke: `/health` returned HTTP 200 and identified the runtime. The package/runtime version smoke is re-run after version bump below.
- Not verified: live Gemini, live Ollama Cloud, or the user's SNK environment and real MCP services.


## Phase 44 — Provider contract and masking hardening (v0.44.0)
- `src/providers/masking/zombie-models.js`: stable public aliases.
- `src/providers/normalizer/stream-chunk.js`: non-stream response to valid final stream chunk fallback.
- `src/providers/normalizer/canonical-response.js`: streaming delta-preserving canonicalization.
- `src/providers/router/smart-router.js`: alias-to-upstream model routing, capability filtering, and 1–10 priorities.
- `src/providers/adapters/gemini.js`: Gemini model resource normalization and request mapping improvements.
- `src/providers/sync.js`: provider catalog allowlist and secret stripping.
- `src/server.js`: provider failover and non-empty stream fallback; masked public route metadata.
- `tests/phase44-provider-contract.test.js`: deterministic local fixture tests.


## Phase 45 — Documentation-only execution planning

- Added `docs/README.md` as the documentation index and explicit verification vocabulary.
- Added `docs/execution-planning/README.md` for provider-neutral execution, client compatibility, TLS/transport options, GitHub/source-control boundary, provider onboarding, routing, and staged verification.
- Added `docs/local-agent-planning.md` for local agent lifecycle, capability states, permission boundaries, and evidence-based completion reports.
- Updated the root README to state that compatibility is not 100% certified and to identify unverified claims.
- No runtime source, routes, provider configuration, credentials, or server behavior were changed in Phase 45.
- External references describe upstream product documentation; they do not certify ZombieCoder.

## Phase 46 — OS runtime verification gate (v0.46.0)
- Added `scripts/verify-deployment.mjs` (Node.js built-ins only).
- Added `scripts/setup-os-runtime.sh` (Linux/systemd only; OS Nginx install requires explicit confirmation).
- Added `scripts/nginx/zombiecoder.conf.template`.
- Added `ZOMBIECODER_EXECUTION_MODE` safe default `chat-only`; execution endpoints are gated until operator enables tools after local verification.
- Added `tests/phase46-os-runtime-gate.test.js` and `docs/75-phase-46-os-runtime-verification-gate.md`.
- This is not live proof of external provider, editor, browser, or target-host compatibility.


## Phase 47 — Native tool surface and strict JSON fallback (v0.47.0)

- Added native registry entries and implementations for scoped file creation/editing/deletion, bounded project search, lexical symbol navigation, allowlisted terminal checks, tracked-process termination, Git status/diff/restore, task planning, and project-local todos.
- Added strict JSON tool-call sanitization for models that return a complete recognized envelope instead of native `tool_calls`; untrusted prose is not scanned for JSON.
- Added native-tool capability preference with JSON fallback routing; `forceJsonToolCalls=true` allows a caller to avoid sending native tool schemas for a specific model/request.
- Wired optional `autoToolLoop=true` on `/v1/chat/completions` to server-side execution, subject to `tools-enabled`, explicit `consent=true`, task policy, registered tools, application permission, and project-root constraints. Default `chat-only` still blocks execution.
- Fixed tool-loop execution-context propagation so native tools receive the project root and working directory. Added task-surface enforcement to streaming tool loop.
- Web search, external page fetching, and sub-agent delegation remain explicitly `NOT_IMPLEMENTED`.
- `npm test`: 172 passed, 0 failed in local test environment; this is not live verification of real providers, editors, browser, Windows/macOS service installation, or remote client behavior.

## Phase 48 — Runtime operations and admin control plane (v0.48.0)
- Launcher: cross-platform root resolution, `.env` precedence, Node.js >=22.5.0 and PORT validation, PID command-line verification, busy-port diagnostics without blind kill.
- OS scripts: Linux/systemd selected-port propagation and Windows PowerShell launcher with explicit Node.js LTS install consent.
- Admin UI: `public/admin/index.html` loads actual runtime APIs, not a hard-coded provider/model catalog.
- Admin APIs: provider PATCH/DELETE, model list/sync-all, agent/persona edit/disable, agent-model mappings, and metrics.
- Local no-token admin testing is disabled by default and requires `LOCAL_AUTH_BYPASS=true`, empty `ADMIN_TOKEN`, and loopback TCP peer.
- Local fixture tests only; not live verified against external providers, MCP services, Windows Task Scheduler or a target Linux service host.

## Phase 49 — External MCP Streamable HTTP lifecycle (v0.49.0)
- POST lifecycle: `initialize` → `notifications/initialized` (no request ID) → `tools/list`; `tools/call` carries negotiated protocol version and session ID.
- JSON and SSE responses are normalized; JSON-RPC IDs are validated and malformed/mismatched responses fail closed.
- Optional GET SSE event stream is exposed by `openMcpEventStream()` and requires explicit lifecycle ownership/close.
- Discovery failures persist sanitized endpoint error status; successful discovery persists protocol version and session ID.
- `npm test`: local fixture suite verifies MCP protocol behavior; no live third-party MCP endpoint has been verified.

> **A gap in this record, stated rather than hidden.** The per-phase entries below resume at
> phase 73. Phases 50–72 have test files (`tests/phase50-*.test.js` … `tests/phase72-*.test.js`)
> and commits, but no entry was written here at the time, so this manifest is **not** a
> complete history. Do not read a missing phase as a missing feature, and do not read this
> file as the source of truth for behaviour: the code and the test suite are. Reconstructing
> 50–72 from the commit log is a known, named task (see `docs/JOURNEY.md` §5, journey 5).

## Phase 73 — Web and context tools that the runtime can actually run (v0.49.0)
- A listed tool is now one the runtime can actually execute; `web_search` answers
  `search_backend_not_configured` when no SearXNG-compatible endpoint is set instead of
  pretending to search, and `fetch_web_page` refuses a private address, a non-standard port
  and a non-https protocol, re-validating every redirect hop and stopping a loop.
- HTML is reduced to text without losing Bengali script, and entity forms (named, decimal,
  hex) decode; the byte ceiling truncates rather than buffering without limit, and a non-2xx
  answer is an error code rather than an empty success.
- Registry reconciliation: a code-owned tool removed from the code is retired on read, and a
  code-owned status is refreshed from code while an operator status (`DISABLED`) is kept.
- `tests/phase73-web-tools.test.js` (11 tests). The web tools are real in shape; no live
  third-party search backend was available here, so a live search remains NOT_TESTED.

## Phase 74 — One error envelope, the one an OpenAI client reads (v0.49.0)
- Every 4xx/5xx body carrying a string `error` is rewritten into
  `{error:{message,type,param,code}}`; a 5xx becomes `server_error`, a 429 becomes
  `rate_limit_error`, sibling fields survive, a string `param` names the offending field,
  and a success body is never touched.
- `test/phase74-openai-compat.test.js` (8 tests) pins each of those, including the two
  bodies that must be left alone (an object `error`, a non-object body).

## Phase 75 — The channel plan is data, not prose (v0.49.0)
- `src/channels/catalog.js` declares the four channels with the Meta windows and limits as
  Meta documents them, the credential model as client-owned, and `Path A` (the client owns
  the app) as the standing decision. Facebook Ads is declared read-only.
- A boundary channel id must exist in the catalog and a boundary tool id must be a runnable
  runtime tool, so the plan cannot reference a capability that does not exist.
- `tests/phase75-channels.test.js` (8 tests). Every channel is `PLANNED`: no webhook
  receiver, no Graph call and no reply exists.

## Phase 76 — The zero-dependency rule is enforced, not assumed (v0.49.0)
- `scripts/check-zero-deps.mjs` fails on a dependency, a lockfile or a `node_modules`
  (including an empty one), and checks every lockfile an installer could leave.
- `package.json` declares no dependency field at all, and `node --test` is the only test
  runner.
- `tests/phase76-zero-deps.test.js` (7 tests).

## Phase 77 — The constitution is policy, so it is written down and checked (v0.49.0)
- Every rule name has a statement (`statementFor(name)` → `name — statement`), and
  `constitutionRules()` maps through it, so all five prompt call sites benefit from one
  change. With no constitution passed, the prompt falls back to the real rules rather than
  to a shorter paraphrase, because a paraphrase is a copy and a copy drifts.
- A caller that writes its own rule keeps it untouched, and the block stays inside a prompt
  budget (<= 1600 chars) because it goes into every system message.
- `tests/phase77-constitution.test.js` (8 tests). `GET /v1/admin/constitution` gained
  `statements` additively, and `Path A` was recorded in the same change.

## Phase 78 — Users, tokens and terms (v0.49.0)
- The existing `applications` rows became *users*: a `role` (`admin` | `user`), per-user
  `limits` (`null` means inherit, and `null` is deliberately not `0`), and `expiresAt`.
  A row created before roles existed is a `user`, which is what it could already do.
- `src/auth/token-vault.js` seals each token with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`
  so an operator can read it back with an audited reveal; authentication still compares a
  SHA-256 hash, so nothing is decrypted to let a request in.
- `expiresAt` is validated on write (`application_expiresAt_invalid:<value>`) because an
  unparseable date does not fail loudly — `new Date('whenever') > new Date()` is `false`, so
  it would silently kill the token. `PATCH` is an allowlist
  (`application_patch_field_not_allowed:<field>`), so an unknown field is refused rather
  than silently ignored.
- `src/core/public-errors.js`: error publication moved from a hand-maintained allowlist to a
  shape rule, because the allowlist drifted and a refused plain-http endpoint reached callers
  as `request_failed`. Log redaction now applies inside values, not only under suspicious key
  names.
- `tests/phase78-users.test.js` (29 tests), including redaction proven by writing a log and
  reading it back.

## Phase 79 — The whole lifecycle over HTTP, with no browser (v0.49.0)
- `tests/phase79-users-over-http.test.js` (4 tests) boots a real server and drives create →
  `auth/verify` → reveal → term ends → renew → rotate → revoke entirely over HTTP, and never
  reads `public/admin/index.html`. A capability that lived only in the console would fail
  this file, which is what makes "the console is a client of the API" a check rather than a
  slogan.
- It also proves a refused plain-http outbound endpoint reaches the caller as
  `outbound_protocol_forbidden` rather than `request_failed`, and that a code carrying free
  text stays closed.
- `tests/phase24-audit.test.js` was raised deliberately to the new inventory: 98 concrete
  routes and 10 notes.

