# Runtime logs and diagnostics

## Does the runtime need documentation files?

No. Documentation is for people; it is not loaded as executable code by the
runtime. The source files, Node.js version, configuration, and any required
runtime data determine whether the application can start. Documentation helps
operators configure, verify, troubleshoot, and maintain that application.

## Log format and correlation

The runtime writes one JSON object per line to `LOG_DIR/LOG_FILE` (JSONL). Each
entry includes a UTC timestamp (`ts`), severity (`level`), event name
(`event`), and `schemaVersion`. Event-specific fields add context such as
`requestId`, `traceId`, `runtimeId`, `instanceId`, provider/model identifiers,
status codes, outcomes, and durations where the relevant code emits them.

To follow a request across related events, filter by its `requestId` or
`traceId`. `runtimeId` and `instanceId` help distinguish deployments and
individual process starts. The request and response events include the HTTP
operation, response status, outcome, and elapsed time; provider, tool, startup,
and transport events provide additional detail when those operations occur.

Example inspection commands:

```bash
tail -n 100 logs/runtime.jsonl
jq -c 'select(.requestId == "REQUEST_ID_HERE")' logs/runtime.jsonl
jq -c 'select(.level == "warn" or .level == "error")' logs/runtime.jsonl
```

These commands require `jq` only for filtering; the runtime itself does not
require it.

## Configuration

The following settings are read from the environment (or `.env`) at startup:

| Setting | Purpose | Default |
| --- | --- | --- |
| `LOG_LEVEL` | Minimum severity written: `error`, `warn`, `info`, `debug`, or `trace` | `info` |
| `LOG_DIR` | Directory for the log file | `./logs` |
| `LOG_FILE` | Active JSONL filename | `runtime.jsonl` |
| `LOG_TO_STDOUT` | Also write each normal log record to stdout | `true` |
| `LOG_MAX_BYTES` | Rotate the active file before it grows past this size | `10485760` |
| `LOG_MAX_FILES` | Number of rotated archive files to keep, in addition to the active file | `7` |
| `LOG_PAYLOADS` | Include fields normally omitted as conversation/request payloads | `false` |

Rotation keeps numbered archives (`runtime.jsonl.1`, `runtime.jsonl.2`, etc.).
Configure the service manager's stdout/stderr collection separately if using
`LOG_TO_STDOUT=true`; file logs and service-manager logs may otherwise duplicate
records.

For temporary troubleshooting, set `LOG_LEVEL=debug` and restart the runtime.
Use `trace` only when necessary because it can produce more records. Restore
`info` after diagnosis.

## Privacy and write failures

Keep `LOG_PAYLOADS=false` in normal use. The default logger omits fields named
like conversation content, prompts, tool arguments, request bodies, and
payloads; replaces strings longer than 2,000 characters with a length marker; and
redacts secret-shaped material.

Redaction applies **inside values, not only under secret-like key names**. That
distinction matters: a credential can arrive in a URL path, a query string, a
provider key, or an upstream error message, where the field name says nothing
about the content. Those matches are replaced with `[REDACTED]`, and the patterns
cover `zc_…` application keys, `sk-`/`pk-`/`rk-` prefixes, Facebook `EAA…` tokens,
JWTs, and `?token=`/`api_key=`/`secret=` style query parameters.

This is still not a substitute for care: do not put credentials, private user
content, or secrets into fields intended for short explanations. Redaction is a
backstop, not a licence.

If a log file cannot be created, rotated, or appended, the logger writes a
`logger.write_failed` JSON record to stderr with the failing target, source
event, and error code. A logging storage failure should therefore be visible
through stderr or the service manager rather than silently discarding file
logs.

## Who called, and what the log cannot tell you

Attribution comes from `applicationId`, `path` and `method` on `http.request`,
`http.response`, `application.auth.succeeded` and `application.auth.failed`.
Those are enough to answer "which token was used, for what, and how often".

**The log does not record a user-agent or a client address.** Two callers using
the same token are therefore indistinguishable, and "was this my terminal or the
shop's server?" cannot be answered from the log alone. When that question
matters, issue a separate user per caller rather than a shared token — one token
per client is both the billing model and the only thing that makes the log
readable later. This limitation is recorded here because it was hit while
answering exactly that question.

## Events worth watching

| Event | Means |
| --- | --- |
| `application.token.revealed` | someone opened the admin console and displayed a token. Carries `applicationId` and `role`. Rare on a healthy deployment; investigate a burst |
| `application.auth.failed` | a key was missing, malformed, expired or revoked (`reason`) |
| `mcp.server.auth_failed` | an inbound MCP client presented an unacceptable credential |
| `outbound.circuit.opened` | the runtime stopped calling an upstream after repeated failures |
| `logger.write_failed` | logs are not reaching the file (written to stderr) |

## Which errors reach the caller

Internal errors are published to callers by shape, decided in
`src/core/public-errors.js`. The `outbound_*`, `provider_*`, `token_vault_*` and
`mcp_*` families are published when the message is a pure identifier; anything
carrying free text falls back to `request_failed`. Four application
write-validation codes are named explicitly and echo the caller's own value
(`application_expiresAt_invalid:whenever`).

The reason this is a shape rather than a hand-maintained list: a list drifts, and
a drifted list is a silent lie. `outbound_protocol_forbidden` — a precise policy
refusal about an endpoint scheme — reached callers as `request_failed` until the
shape rule replaced the list, which reads like a runtime bug and gives an
operator nothing to act on.

The full message is still written to the log and the audit trail even when it is
not published, so a `request_failed` in a response is not a dead end: find the
`http.error` record by `requestId` and read the real cause there.

## What logs do not prove

An `http.response` with status 200 or a healthy `/health` response does not
prove that a provider can complete inference, streaming, or tool execution.
Use the relevant end-to-end checks and interpret provider failures, timeout,
authentication, and circuit-breaker events in context. Logs are operational
evidence, not a replacement for verification tests.
