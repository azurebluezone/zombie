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
payloads; redacts values under secret-like field names; and replaces strings
longer than 2,000 characters with a length marker. This is not a substitute for
reviewing diagnostic text: do not put credentials, private user content, or
secrets into fields intended for short explanations.

If a log file cannot be created, rotated, or appended, the logger writes a
`logger.write_failed` JSON record to stderr with the failing target, source
event, and error code. A logging storage failure should therefore be visible
through stderr or the service manager rather than silently discarding file
logs.

## What logs do not prove

An `http.response` with status 200 or a healthy `/health` response does not
prove that a provider can complete inference, streaming, or tool execution.
Use the relevant end-to-end checks and interpret provider failures, timeout,
authentication, and circuit-breaker events in context. Logs are operational
evidence, not a replacement for verification tests.
