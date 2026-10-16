# Changelog

## 0.44.0 — Provider contract and masking hardening
- Added stable agent-facing ZombieCoder aliases (`zombie-mini`, `zombie-lite`, `zombie-classic`) while keeping upstream model IDs in the authenticated admin catalog.
- Added provider-specific `modelAliases` mapping and 1–10 routing priority normalization, including ordering preservation for legacy priorities above 10.
- Fixed OpenAI-compatible streaming normalization so `delta` and incremental tool-call arguments are preserved; Bengali/Unicode chunks remain concatenable without JSON reserialization.
- Added non-streaming fallback when an upstream stream returns no usable chunks, and provider failover before any partial stream output has been emitted.
- Fixed Gemini model-list resource names, system/developer message mapping, token parameter mapping, tool choice mapping, and stream timeout propagation.
- Prevented provider catalog sync from persisting API keys or arbitrary secret-bearing fields.
- Added local HTTP fixture tests for environment-provided auth headers, model catalog persistence, aliases, priority, streaming normalization and secret exclusion.
- Regression suite: 160 passed, 0 failed; JavaScript syntax checks passed; runtime boot smoke returned HTTP 200 for v0.44.0 / phase 44.
- Live provider credentials and account-specific model availability were not available for this verification; fixture tests do not claim live-provider success.


- Hardened legacy external MCP declaration resolution, disabled-server handling, duplicate identity detection, and safe error reporting.
- Added tests based on the supplied legacy loader contract. Individual legacy MCP server sources remain missing from the supplied archive; no behavioral parity is claimed for those servers.

## 0.42.0 — Provider Configuration Reliability

- Fixed capability routing for the native Gemini `generateContent` adapter without misrepresenting its upstream protocol as OpenAI-compatible.
- Added an exact private-host exception list for provider networking, preserving default denial and existing global host allowlist behavior.
- Documented safe local Ollama configuration without requiring a global allowlist that would block public providers.
- Added actual loopback HTTP integration coverage for Gemini request/response normalization and SQLite-backed Ollama model refresh.
- Regression suite: 145 passed, 0 failed.
- Remote Gemini/Ollama Cloud and the user's actual local services were not live-verified.

## 0.41.0 — Legacy Filesystem Tool Contract Alignment

- Compared filesystem tool contracts against extracted `api.zip` / legacy `api.js`, not names alone.
- Aligned read/write/list outputs with the legacy MCP text-content envelope.
- Restored the 100,000-character read cap, recursive write parent creation, legacy write message semantics, and text directory listing.
- Kept project-root and symlink protections stricter than the legacy unrestricted default; exact security parity is explicitly not claimed.
- Added real temporary-filesystem integration tests through the registry, permission policy, path boundary and actual tool modules.
- Regression suite: 140 passed, 0 failed (before final clean rerun).

## 0.40.0 — Configuration Reliability & Tool Parity Ledger

- Added explicit, default-deny opt-in for local/private HTTP MCP with exact host allowlisting.
- MCP discovery and tool calls share the same URL policy; DNS/address checks still run before outbound requests.
- Added admin-only legacy tool parity inventory at `/v1/admin/compatibility/tools`.
- Documented migration status for filesystem, public API, ads, OCR, TTS, screen-recorder, skill and combined MCP tools.
- Regression suite: 135 passed, 0 failed.

## 0.39.0 — Phase 39

- Frontend legacy compatibility adapters for model/chat/SSOT/context views.
- Runtime-resolved tool catalog injected into system prompt.
- Ollama OpenAI-compatible/native deterministic integration coverage.
- Admin route inventory endpoint and documentation.
- Provider streaming fallback now refuses replay after emitted chunks.

## 0.38.0

- Closed the normal chat lifecycle from session archive through bounded context, provider response, evidence observation and session persistence.
- Persisted provider observations against session context without treating them as verified execution evidence.
- Included a bounded set of session evidence in compiled context.
- Added controlled runtime end-to-end smoke coverage for authenticated session continuity and SQLite evidence persistence.
- 121 tests pass.

# CHANGELOG

## 0.36.0 — Boot, Provider Persistence & Runtime Connectivity Verification

- Added boot-time provider upsert verification and SQLite persistence coverage.
- Added explicit Ollama Cloud OpenAI-compatible (`https://ollama.com/v1`) and native (`https://ollama.com/api/*`) example configurations.
- Fixed native Ollama adapter authentication headers for model, chat, and streaming requests.
- Added Phase 36 boot/provider runtime verification tests and documentation.

## 0.35.0 — Session/Prompt Lifecycle + Provider ENV Example

- Session history is included in bounded prompt context for chat and streaming chat.
- Runtime persists the exact latest user message and generated assistant response.
- Streaming chat persists accumulated assistant content/tool calls after successful provider completion.
- Shell-safe provider key mapping supports hyphenated provider IDs via underscore env names.
- `.env.example` documents Ollama, Gemini, Groq, Cloudflare Workers AI, OpenCode-compatible, and generic custom providers.

## 0.34.0 — Runtime Reliability & Agent Integration Verification

- Outbound circuit-breaker semantics and runtime reliability hardening.
- Agent registry/persona/runtime audit and package-derived runtime version.
- 113-test verification baseline.


## 0.44.0 documentation follow-up — Phase 45 (documentation-only)

- Added a documentation index and explicit `intended` / `implemented` / `locally tested` / `live verified` / `not verified` terminology.
- Added execution planning for GitHub versus runtime exposure, Cloudflare Tunnel alternatives, provider/client compatibility, TLS and capability-specific verification gates.
- Added local agent planning for goal contracts, consent, tool authorization, execution evidence, and truthful completion reports.
- Updated the root README and implementation manifest to state that these plans are not a 100% correctness or live-compatibility claim.
- No runtime code or server configuration changed.

## 0.46.0 — OS runtime verification gate
- Added a dependency-free Node.js deployment verification script for health, model catalog, TLS, and optional authenticated chat/stream checks.
- Added a Linux/systemd setup helper with explicit chat-only vs HTTPS reverse-proxy setup choice; Nginx package installation requires confirmation.
- Added `ZOMBIECODER_EXECUTION_MODE=chat-only` as the safe default and gated execution/tool-call endpoints until an operator explicitly enables tools after local verification.
- Added an integration test proving the default mode reports `chat-only` and blocks execution routes with HTTP 503.
- No claim of universal OS, provider, editor, browser, or tool-call compatibility; Windows/macOS service setup and real deployment validation remain pending.

## 0.47.0 — Native Tool Surface + JSON Tool-Call Sanitizer
- Added server-registered native workspace tools for create/edit/diff/delete, bounded search, symbol lookup, git status/diff/restore, allowlisted terminal checks, process termination, task planning, and project-local todo management.
- Added a strict JSON tool-request sanitizer for small models that return a recognized tool-call envelope instead of native `tool_calls`; runtime registry, task scope, application permission, consent and path boundaries still decide whether execution is allowed.
- Tool-loop routing can prefer native function-calling providers while allowing explicit JSON-tool fallback on providers whose manifest does not advertise function calling.
- Web search, safe external page fetching, and sub-agent delegation remain marked `NOT_IMPLEMENTED` until their backends/contracts exist.
- Added Phase 47 regression tests; no live third-party provider or IDE compatibility claim.

## 0.48.0 — Runtime operations and admin control plane
- Hardened cross-platform launcher root resolution, environment precedence, Node.js version and port validation, and PID command-line checks before stopping a runtime.
- Added listener diagnostics that report a busy port without killing its owner.
- Added a Linux/systemd selected-port prompt and Windows PowerShell launcher with explicit winget consent for Node.js LTS installation.
- Added the data-driven `/admin` UI, provider/model CRUD/status controls, model sync-all, agent/persona controls, agent model mappings, and aggregate metrics APIs.
- Added loopback-only explicit no-token admin testing gate and provider URL secret masking.
- Agent mappings are applied to public chat requests for omitted model or `zombie-*` aliases; multi-upstream alias fallback and full MCP lifecycle remain follow-up work.

## 0.49.0 — External MCP Streamable HTTP lifecycle
- Added `notifications/initialized` after `POST initialize`, negotiated protocol-version/session propagation, and actual package version in client identity.
- Added robust JSON/SSE JSON-RPC response parsing with response-ID validation and support for progress notifications before the final response.
- Added optional Streamable HTTP GET SSE event stream with explicit close handle.
- Added stable MCP discovery error lifecycle persisted to endpoint status without storing arbitrary remote error messages.
- Added local fixture coverage for initialization, notification, tools/list, tools/call, GET SSE, response-ID mismatch and persisted error state.
