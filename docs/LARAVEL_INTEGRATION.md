# Laravel / PHP integration guide

This document describes how a PHP or Laravel e-commerce application talks to a
ZombieCoder Runtime deployment. It is written for the engineer who owns the
application side. It states what is implemented, what was verified in this
environment, and what remains unverified — the same discipline the runtime
applies to its own answers.

Runtime build this document describes: **v0.49.0 (phase 49)**. Node.js
`>= 22.5.0`.

---

## 1. Scope

- **In scope:** the HTTP contract between a server-side PHP application and the
  runtime, authentication, sessions, project context, tool execution, MCP tool
  calls, capability tools, errors, limits, and the verification rule.
- **Out of scope:** the runtime's internal provider routing, the admin console
  UI, and any deployment hardening beyond the security checklist in §16.

The runtime is a **self-hosted process**, not a SaaS. There is no vendor
endpoint to call. You deploy it next to your application (or on an internal
host) and speak to it over HTTP or HTTPS.

---

## 2. Where ZombieCoder sits

```text
Browser
  |
  | HTTPS (no runtime key here, ever)
  v
PHP / Laravel application          <-- owns the customer-facing workflow
  |
  | HTTPS + Bearer <application key>   (server-to-server only)
  v
ZombieCoder Runtime                <-- owns AI / runtime orchestration
  |
  +-- application policy (capabilities, per-app tool toggles)
  +-- session + project context (SSOT, syllabus, memory, notes)
  +-- agent + tool boundary
  +-- provider + MCP routing
  +-- evidence + verification
  v
Canonical response + requestId / traceId
```

Two rules follow from this diagram:

1. The browser must never receive the ZombieCoder application key. All runtime
   calls are made from PHP, server-side.
2. The PHP application owns the business action. The runtime produces a
   response and evidence; it does not decide whether an order exists.

---

## 3. Deployment assumptions

| Item | Value |
| --- | --- |
| Transport | HTTP (loopback only) or HTTPS with a certificate in `certs/` |
| Default bind | `127.0.0.1:9999` |
| Base URL for clients | `http(s)://<host>:<port>/v1` |
| Execution mode | `ZOMBICODER_EXECUTION_MODE=tools-enabled` for tool execution; `chat-only` otherwise |
| Plaintext HTTP | Only when `ALLOW_PLAINTEXT_HTTP=true`; do not place behind a reverse proxy |

`GET /health` returns the service identity and version and requires no key:

```json
{ "ok": true, "service": "zombiecoder-runtime", "version": "0.49.0", "phase": 49 }
```

---

## 4. Authentication

Two credential kinds exist.

| Credential | Header | Used for |
| --- | --- | --- |
| **Application key** | `Authorization: Bearer zc_…` | Every `/v1/*` route an application calls (chat, sessions, context, execution, MCP call) |
| **Admin token** | `Authorization: Bearer <ADMIN_TOKEN>` | `/v1/admin/*` routes only |

An application key is created by an administrator:

```bash
curl -sX POST http://127.0.0.1:9999/v1/admin/applications \
  -H 'Authorization: Bearer '"$ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"laravel-store"}'
```

The response contains the key **once** and the runtime says so explicitly:

```json
{ "application": { "id": "app_…", "name": "laravel-store" },
  "apiKey": "zc_…",
  "warning": "Store this key now; it will not be shown again." }
```

The key is stored only as a hash. To replace it use
`POST /v1/admin/applications/{id}/rotate-key`; to disable it use
`POST /v1/admin/applications/{id}/revoke`.

A missing, malformed, expired, or revoked key returns:

```json
{ "error": "application_unauthorized_or_expired" }
```

> On a loopback deployment with `LOOPBACK_AUTH_BYPASS=true` and an empty
> `ADMIN_TOKEN`, admin routes accept requests from `127.0.0.1` without a token.
> This is a local-development convenience; it is not an authentication scheme
> for a networked deployment.

---

## 5. Configuration

Application-side environment variables:

```env
ZOMBIECODER_BASE_URL=https://runtime.example.internal/v1
ZOMBIECODER_API_KEY=server-side-application-key
ZOMBIECODER_MODEL=zombie-mini
ZOMBICODER_AGENT=customer-experience-specialist
ZOMBICODER_TIMEOUT=60
```

The model value is a **public ZombieCoder alias**, not an upstream model ID.
The runtime masks the real provider and model; a client never learns them.

| Alias | Meaning |
| --- | --- |
| `zombie-mini` | default, small/fast route |
| `zombie-lite` | lighter route |
| `zombie-classic` | larger route |

An administrator may also force a specific provider per request by adding
`"provider": "<provider-id>"` to the body; this is a routing constraint, not
something a normal application should send.

---

## 6. The chat endpoint

```text
POST /v1/chat/completions
Authorization: Bearer <application key>
Content-Type: application/json
Accept: application/json          (or text/event-stream when streaming)
```

### 6.1 Request fields

Standard OpenAI fields:

| Field | Type | Notes |
| --- | --- | --- |
| `model` | string | a ZombieCoder alias (required) |
| `messages` | array | OpenAI-style `{role, content}` list (required) |
| `stream` | boolean | `false` (default) or `true` |

Orchestration fields the runtime understands (all optional):

| Field | Type | Effect |
| --- | --- | --- |
| `agent` | string | agent id, e.g. `customer-experience-specialist` |
| `autoToolLoop` | boolean | allow model → tool → model rounds |
| `consent` | boolean | required `true` before a consent-gated tool runs |
| `toolIds` | string[] | narrow the tool surface to these tool ids |
| `toolSurface` | string | `"full"` disables narrowing for this request |
| `projectRoot` | string | absolute path the agent may read/write |
| `sessionId` | string | continue an existing session |
| `createSession` | boolean | create a session for this request |
| `userId` | string | attach an end-user identity to the session |
| `provider` | string | hard routing constraint (admin use) |
| `goal` / `expectedOutcome` | string | used by the execution lifecycle |

Any field not listed above is stripped before the request reaches the upstream
provider.

### 6.2 Non-streaming

```bash
curl -sX POST https://runtime.example.internal/v1/chat/completions \
  -H 'Authorization: Bearer '"$ZOMBIECODER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
        "model": "zombie-mini",
        "agent": "customer-experience-specialist",
        "messages": [{"role":"user","content":"How do I return an item?"}],
        "stream": false,
        "autoToolLoop": false,
        "consent": true
      }'
```

The response is OpenAI-shaped (`choices[0].message.content`) plus a `meta`
object (§6.4).

### 6.3 Streaming

With `"stream": true` the runtime returns `text/event-stream`. Each line is an
SSE frame:

```text
data: {"id":"…","object":"chat.completion.chunk","choices":[{"delta":{"content":"Thank"}}]}

data: {"id":"…","object":"chat.completion.chunk","choices":[{"delta":{"content":" you!"},"finish_reason":"stop"}]}

data: [DONE]
```

Unicode content (for example Bengali text) is passed through unchanged and can
be concatenated without re-serialising the JSON.

Two behaviours a client must handle:

- **Runtime events are interleaved.** Alongside `data:` token frames the
  runtime may emit `event: runtime` frames carrying tool-loop progress.
  A client that only reads `data:` will ignore them safely.
- **A token can arrive twice** (once as a `data:` frame and once as a
  `runtime`/`stream_chunk` mirror). Concatenating all `data:` frames is
  therefore the correct client strategy; do not assume the mirrors are absent.
  This was measured in this environment, not assumed. See §15.

If the upstream stream fails before any chunk is emitted, the runtime falls
back to a non-streaming provider call. If it fails after chunks were emitted,
it reports `stream_failed` rather than replaying a partial answer.

### 6.4 Response metadata

Every chat response carries `meta`:

| Path | Meaning |
| --- | --- |
| `meta.phase` | runtime phase number |
| `meta.executionMode` | `chat-only` or `tools-enabled` |
| `meta.provider` | always `{name:"ZombieCoder", id:"masked"}` |
| `meta.model` | the public alias |
| `meta.agent` | the agent that served the request |
| `meta.persona` | persona id used |
| `meta.agentAccess` | resolved access scope (`global` or a root) |
| `meta.toolSurface` | `{count, toolIds, allowedCount, mode, reason, groups, dropped}` |
| `meta.evidence` | observed evidence items (public-safe view) |
| `meta.verified` | whether evidence was promoted to **verified** |
| `meta.verificationRequired` | `true` — the client must not skip the check |
| `meta.toolLoop` | `{status, stoppedReason, rounds, roundCount, evidenceCount, verified}` |
| `meta.taskPolicy` | resolved task profile and effective tool ids |

`meta.verified` is the only field that may be treated as proof. `meta.evidence`
items are **observations**, not proof.

---

## 7. Sessions

A session is owned by the application that created it. Session message state is
stored in SQLite.

| Method | Path | Body / notes |
| --- | --- | --- |
| `POST` | `/v1/sessions` | `{userId?, metadata?}` → `201 {session}` |
| `GET` | `/v1/sessions/{id}` | → `200 {session}` or `404 session_not_found` |
| `PATCH` | `/v1/sessions/{id}/metadata` | `{metadata:{…}}` → `200 {session}` |
| `GET` | `/v1/sessions/{id}/messages` | → `200 {sessionId, messages[]}` |
| `POST` | `/v1/sessions/{id}/close` | → `200 {session}` |

A session that belongs to another application is reported as
`session_not_found`, not as a permission error, so an application cannot probe
for the existence of other tenants' sessions.

---

## 8. Project context

The context layer has four parts, each with its own boundary:

| Boundary | Endpoint(s) | Contents |
| --- | --- | --- |
| **SSOT** | `POST /v1/context/setup`, `POST /v1/context/ssot/refresh`, `GET /v1/context` | project state and detected structure |
| **Syllabus** | `POST /v1/context/syllabus` | knowledge / reference entries |
| **Memory** | `POST /v1/context/memory`, `GET /v1/context/memory/recent` | session-derived project notes |
| **Notes** | `GET` / `POST` / `DELETE /v1/context/notes` | agent-writable short notes |

Notes are stored per project root at `.zombiecoder/agents/notes.json`. The path
is resolved against the project root, **never** against the process working
directory, so the store behaves the same whichever directory the runtime was
started from. A note write returns the note and the resolved path:

```json
{ "note": { "id": "…", "text": "…", "createdAt": "…" },
  "path": ".zombiecoder/agents/notes.json" }
```

A note that does not exist returns `404 note_not_found`; an empty `text`
returns `400 note_text_required`.

---

## 9. Tool execution boundary

When a request needs a tool, the runtime exposes three execution routes.
They require `ZOMBICODER_EXECUTION_MODE=tools-enabled`; otherwise they return
`503 tool_execution_not_verified`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/execution/prepare` | build a plan and resolve the tool set, no execution |
| `POST` | `/v1/execution/run` | execute and return evidence |
| `POST` | `/v1/execution/stream` | execute and stream progress as SSE |

A consent-gated tool refuses to run without `"consent": true`:

```json
{ "error": "execution_consent_required" }
```

Consent-gated tools in this build: `write_file`, `create_file`, `edit_file`,
`apply_diff`, `delete_file`, `run_terminal_command`, `execute_bash`,
`kill_process`, `undo`, `revert_file`, `todo_manager`, `note_store`.

An external MCP tool is invoked through the same boundary by naming its
qualified name (or by setting `"executionTarget":"mcp"`). If the tool is not
permitted for the application, the run returns `mcp_tool_not_permitted` and
logs `tool.permission_denied` with the reason.

Tools discovered on an external MCP endpoint are also offered to the agent as
ordinary function definitions, so a tool loop can choose one without the caller
naming it. The name the model sees is derived from the endpoint id and the
remote tool name (`self-mcp.runtime_echo` → `mcp_self-mcp_runtime_echo`). An
agent that declares an external-MCP boundary sees only those endpoints;
`EXTERNAL_TOOL_SURFACE_MAX` caps how many are offered at once. What was offered
is reported under `meta.toolSurface.external`.

---

## 10. Calling an MCP tool directly

To call a registered tool without the agent loop:

```text
POST /v1/mcp/tools/call
Authorization: Bearer <application key>
```

```json
{ "applicationId": "app_…", "toolId": "read_file", "arguments": { "path": "README.md" } }
```

Required fields are `applicationId` and `toolId` (or `qualifiedName` for an
external MCP tool). Missing fields return
`application_id_and_tool_required` or `qualified_tool_required`.

The runtime also exposes an MCP server at `POST /mcp` for MCP clients; it
negotiates protocol version `2025-06-18` and advertises the runnable tool set.

---

## 11. E-commerce capability tools

Four capability tools are declared for e-commerce and customer-experience
agents. They are **registered but unverified** in this environment because
their endpoints are not configured.

| Tool | Purpose | Endpoint env var | Status |
| --- | --- | --- | --- |
| `public_api` | project / e-commerce public API access | `EXTERNAL_MCP_PUBLIC_API_URL` | UNVERIFIED |
| `tts` | text-to-speech output | `EXTERNAL_MCP_TTS_URL` | UNVERIFIED |
| `ocr` | image / document text extraction | `EXTERNAL_MCP_OCR_URL` | UNVERIFIED |
| `facebook_ads` | advertising / marketing data | `EXTERNAL_MCP_FACEBOOK_ADS_URL` | UNVERIFIED |

Their intended agent boundaries are declared in
`src/agents/ecommerce-tool-boundaries.js`:

| Agent | Tools |
| --- | --- |
| `ecommerce-operations-analyst` | `read_file`, `list_directory`, `public_api`, `facebook_ads`, `ocr` |
| `customer-experience-specialist` | `read_file`, `list_directory`, `ocr`, `tts` |

To enable one for an application once its URL is set:

```bash
curl -sX POST http://127.0.0.1:9999/v1/admin/applications/capabilities/tools \
  -H 'Content-Type: application/json' \
  -d '{"applicationId":"app_…","toolId":"tts","enabled":true}'
```

The effective decision is reported by the same endpoint family
(`GET /v1/admin/applications/capabilities?applicationId=…`) and is resolved in
this order: application setting → `ZOMBICODER_TOOL_<ID>` → `ZOMBICODER_TOOLS`
allowlist → unconfigured.

> Until a capability tool has a reachable endpoint and has been called
> end-to-end, treat it as `UNVERIFIED`. A declaration is not a health claim.

---

## 12. Errors

Errors are returned as `{ "error": "<code>" }`, usually with HTTP 4xx/5xx.
The codes an application will actually see:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `application_unauthorized_or_expired` | 401 | bad / expired / revoked key |
| `application_rate_limited` | 429 | per-application rate limit hit |
| `application_concurrency_limited` | 429 | too many in-flight requests |
| `invalid_body` | 400 | body was not valid JSON |
| `model_required` | 400 | `model` missing |
| `provider_required` / `provider_not_found` | 400 / 404 | routing constraint invalid |
| `agent_not_found` | 404 | unknown agent id |
| `session_not_found` | 404 | missing or not owned |
| `execution_consent_required` | 403 | consent-gated tool without `consent:true` |
| `tool_execution_not_verified` | 503 | execution mode is not `tools-enabled` |
| `tool_not_found` | 404 | unknown tool id |
| `mcp_tool_not_permitted` | 403 | application is not allowed that tool |
| `no_registered_tool_allowed_for_task` | 400 | task policy resolved to zero tools |
| `note_id_required` / `note_text_required` / `note_not_found` | 400 / 404 | notes API |
| `stream_failed` | 502 | upstream stream failed after output |
| `not_found` | 404 | unknown route |

---

## 13. Rate limits and concurrency

| Setting | Default | Env |
| --- | --- | --- |
| Per-application rate limit | 60 | `APP_RATE_LIMIT` |
| Per-application concurrency | 4 | `APP_CONCURRENCY` |

A request over the rate limit returns `429 application_rate_limited`; a request
over the concurrency limit returns `429 application_concurrency_limited`. The
runtime reads `Retry-After` from an upstream provider and uses it internally; an
application should implement its own bounded retry with backoff and must not
fan out many simultaneous calls.

---

## 14. The verification rule

This is the one rule an integration must not break.

> A PHP integration must not turn an unverified runtime result into a
> successful business action.

An answer that says "the order is available" is not proof that the e-commerce
database contains that order. Before acting on a runtime answer:

1. Read `meta.verified`. If it is not `true`, do not treat the answer as fact.
2. If the action is a write, perform it in PHP against the real system of
   record and check the result.
3. Record the runtime's `requestId` / `traceId` alongside the business action
   so a later audit can correlate the two.

---

## 15. Verification status

Honest labels for this document and the runtime behaviour it describes.

| Claim | Status | Basis |
| --- | --- | --- |
| HTTP contract (routes, shapes, error codes) | **SOURCE_VERIFIED** | read from `src/server.js` and confirmed against the live route inventory |
| Auth behaviour (401 body, loopback bypass) | **LIVE_PROBE_PASSED** | probed against a running instance |
| Sessions / context / notes shapes | **LIVE_PROBE_PASSED** | probed against a running instance |
| Streaming SSE frames + ttfb | **LIVE_PROBE_PASSED** | measured: ttfb ≈ 0.7–1.5 s, one token delivered twice |
| Tool execution end-to-end | **END_TO_END_TESTED** | the full suite exercises the tool loop with real registered tools |
| `public_api`, `tts`, `ocr`, `facebook_ads` | **UNVERIFIED** | no endpoint configured; never called |
| A PHP/Laravel snippet executed on this host | **NOT_TESTED** | no `php` / `composer` on the build host |
| HTTPS certificate / reverse-proxy setup | **NOT_TESTED** | loopback deployment only |

---

## 16. Security checklist

- [ ] The application key is stored server-side only and never sent to a
      browser, mobile app, or log.
- [ ] The runtime is not exposed behind a reverse proxy in plaintext HTTP.
- [ ] `ALLOW_PLAINTEXT_HTTP` is `false` outside local development.
- [ ] `ADMIN_TOKEN` is a long random value, or admin routes are unreachable
      from outside the host.
- [ ] `LOOPBACK_AUTH_BYPASS` is treated as a development convenience only.
- [ ] Application capabilities are granted per application, not globally.
- [ ] `meta.verified` is checked before any business action (§14).

---

## 17. Minimal Laravel wiring

The repository ships a dependency-free client at
`integration/php/ZombieCoderClient.php`. Copy it to `app/Support/` and wire it
as a singleton.

**`config/zombiecoder.php`**

```php
<?php

return [
    'base_url' => env('ZOMBIECODER_BASE_URL', 'http://127.0.0.1:9999/v1'),
    'api_key'  => env('ZOMBIECODER_API_KEY'),
    'model'    => env('ZOMBIECODER_MODEL', 'zombie-mini'),
    'agent'    => env('ZOMBICODER_AGENT'),
    'timeout'  => (int) env('ZOMBICODER_TIMEOUT', 60),
];
```

**`app/Providers/ZombieCoderServiceProvider.php`**

```php
<?php

namespace App\Providers;

use App\Support\ZombieCoderClient;
use Illuminate\Support\ServiceProvider;

final class ZombieCoderServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(base_path('config/zombiecoder.php'), 'zombiecoder');

        $this->app->singleton(ZombieCoderClient::class, function ($app): ZombieCoderClient {
            $config = $app['config']['zombiecoder'];

            return new ZombieCoderClient(
                $config['base_url'],
                (string) $config['api_key'],
                $config['model'],
                $config['timeout'],
            );
        });
    }

    public function boot(): void
    {
        $this->publishes([
            base_path('config/zombiecoder.php') => config_path('zombiecoder.php'),
        ], 'zombiecoder');
    }
}
```

**`app/Http/Controllers/AssistantController.php`**

```php
<?php

namespace App\Http\Controllers;

use App\Support\ZombieCoderClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class AssistantController extends Controller
{
    public function __construct(private readonly ZombieCoderClient $client) {}

    public function ask(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'message' => ['required', 'string', 'max:4000'],
        ]);

        $result = $this->client->chat(
            [['role' => 'user', 'content' => $validated['message']]],
            [
                'agent'        => config('zombiecoder.agent'),
                'autoToolLoop' => false,
                'consent'      => true,
            ],
        );

        // Rule from §14: never promote an unverified answer to a business action.
        $verified = (bool) data_get($result, 'meta.verified', false);

        return response()->json([
            'answer'     => data_get($result, 'choices.0.message.content'),
            'verified'   => $verified,
            'request_id' => data_get($result, 'meta.requestId'),
        ]);
    }
}
```

**Streaming variant** — a raw passthrough that forwards the SSE bytes:

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

final class AssistantStreamController extends Controller
{
    public function stream(Request $request): StreamedResponse
    {
        $payload = json_encode([
            'model'        => config('zombiecoder.model'),
            'agent'        => config('zombiecoder.agent'),
            'messages'     => [['role' => 'user', 'content' => (string) $request->input('message')]],
            'stream'       => true,
            'autoToolLoop' => true,
            'consent'      => true,
        ], JSON_UNESCAPED_UNICODE);

        return response()->stream(function () use ($payload): void {
            $ch = curl_init(config('zombiecoder.base_url') . '/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_HTTPHEADER     => [
                    'Content-Type: application/json',
                    'Accept: text/event-stream',
                    'Authorization: Bearer ' . config('zombiecoder.api_key'),
                ],
                CURLOPT_POSTFIELDS     => $payload,
                CURLOPT_WRITEFUNCTION  => static function ($ch, string $chunk): int {
                    echo $chunk;
                    if (function_exists('ob_flush')) {
                        @ob_flush();
                    }
                    flush();

                    return strlen($chunk);
                },
            ]);
            curl_exec($ch);
            curl_close($ch);
        }, 200, [
            'Content-Type'      => 'text/event-stream',
            'Cache-Control'     => 'no-cache',
            'X-Accel-Buffering' => 'no',
        ]);
    }
}
```

**`routes/web.php`**

```php
use App\Http\Controllers\AssistantController;
use App\Http\Controllers\AssistantStreamController;

Route::middleware('auth')->group(function () {
    Route::post('/assistant', [AssistantController::class, 'ask']);
    Route::post('/assistant/stream', [AssistantStreamController::class, 'stream']);
});
```

**`.env`**

```env
ZOMBIECODER_BASE_URL=http://127.0.0.1:9999/v1
ZOMBIECODER_API_KEY=zc_…
ZOMBIECODER_MODEL=zombie-mini
ZOMBICODER_AGENT=customer-experience-specialist
ZOMBICODER_TIMEOUT=60
```

> The PHP above is a correct representation of the contract but was **not
> executed on this host** (no `php` / `composer` available). The HTTP contract
> it relies on was probed live; the PHP itself is `NOT_TESTED`.

---

## 18. Related documents

| Document | Contents |
| --- | --- |
| `README.md` | the runtime as a whole |
| `docs/OBSERVABILITY.md` | logging, diagnostics, troubleshooting |
| `docs/DESIGN_FLOW.md` | why the runtime is built this way and how the next change must be made |
| `integration/php/` | the dependency-free PHP client |
| `GET /v1/admin/routes` | authoritative, machine-readable route inventory |
| `.env.example` | every configuration key |
