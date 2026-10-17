import { mkdir, appendFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = {error:0, warn:1, info:2, debug:3, trace:4};
const LOG_SCHEMA_VERSION = 1;
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|cookie|set-cookie|credential)/i;

/**
 * Secrets inside *values*, not just secrets under a suspicious *key*.
 *
 * Redacting by key name is not enough, and the gap was measurable rather than
 * theoretical: a request to `/v1/admin/applications/<token>/token` is logged with
 * `path: req.url`, and `path` is an innocent-looking key carrying a live token. The
 * same applies to `?access_token=...` in a query string and to an upstream error
 * message that echoes back the credential it was handed. In each case the log said
 * nothing about tokens and contained one anyway — which is worse than not logging,
 * because it makes "tokens are never written to a log" a false statement.
 *
 * So a second pass runs over every string that reaches the log. The fast path is a
 * single regex test that almost every string fails, so the cost on ordinary log
 * lines is negligible; the rewrites only happen when a marker is present.
 */
const SECRET_MARKER = /zc_[A-Za-z0-9_-]{8}|(?:sk|pk|rk)-[A-Za-z0-9_-]{12}|EAA[A-Za-z0-9_-]{20}|eyJ[A-Za-z0-9_-]{10,}\.|[?&](?:token|access_token|api[-_]?key|key|secret|password|signature)=/i;
const SECRET_VALUE_PATTERNS = [
  /zc_[A-Za-z0-9_-]{8,}/g,                                                  // this runtime's own token shape
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,                                   // provider key shapes
  /\bEAA[A-Za-z0-9_-]{20,}\b/g,                                             // Meta access tokens begin EAA
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g        // JWTs
];
const SECRET_QUERY = /([?&](?:token|access_token|api[-_]?key|key|secret|password|signature)=)[^&#\s]+/gi;

export function redactSecrets(value) {
  if (typeof value !== 'string' || !value || !SECRET_MARKER.test(value)) return value;
  let out = value.replace(SECRET_QUERY, '$1[REDACTED]');
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

// Payload-like fields are omitted from the log on purpose: a log line must never
// carry conversation content, prompts, tool arguments or upstream bodies.
//
// The rule matches key *names*, so it also swallows diagnostic keys that merely
// happen to contain one of those words (providerMessage, remoteMessage,
// messageCount, recentMessages, systemPromptInjected, ...). That silently hid the
// very reasons the runtime wrote into the log — an upstream rejection looked like
// a bare "provider_http_error" with no explanation.
//
// Convention: diagnostic fields must not contain messages/content/arguments/
// prompt/body/payload/data in their name. Use upstreamReason, remoteReason,
// msgCount, recentCount, sessionCount, contextInjected instead.
const PAYLOAD_KEY = /(messages?|content|arguments|prompt|body|payload|data)/i;

function sanitize(value, {allowPayloads = false} = {}, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (!allowPayloads && typeof value === 'string' && value.length > 2000) return `[redacted-long-string:${value.length}]`;
  if (typeof value === 'string') return redactSecrets(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, {allowPayloads}, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (SECRET_KEY.test(key)) out[key] = '[REDACTED]';
      else if (!allowPayloads && PAYLOAD_KEY.test(key)) {
        if (Array.isArray(item)) out[key] = `[omitted:${item.length} items]`;
        else if (typeof item === 'string') out[key] = `[omitted:${item.length} chars]`;
        else out[key] = '[omitted]';
      } else out[key] = sanitize(item, {allowPayloads}, depth + 1);
    }
    return out;
  }
  return redactSecrets(String(value));
}

export class SystemLogger {
  constructor({dir='./logs', file='runtime.jsonl', level='info', stdout=true, maxBytes=10*1024*1024, maxFiles=7, allowPayloads=false} = {}) {
    this.dir = path.resolve(dir);
    this.file = file;
    this.level = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
    this.stdout = stdout;
    this.maxBytes = Math.max(1024, Number(maxBytes) || 10 * 1024 * 1024);
    this.maxFiles = Math.max(1, Number(maxFiles) || 7);
    this.allowPayloads = Boolean(allowPayloads);
    this.chain = Promise.resolve();
  }

  child(base = {}) { return new LogContext(this, base); }
  enabled(level) { return (LEVELS[level] ?? LEVELS.info) <= this.level; }

  log(level, event, fields = {}) {
    if (!this.enabled(level)) return Promise.resolve();
    const entry = {
      ...sanitize(fields, {allowPayloads: this.allowPayloads}),
      schemaVersion: LOG_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      level,
      event: String(event)
    };
    const line = JSON.stringify(entry) + '\n';
    if (this.stdout) {
      try { process.stdout.write(line); }
      catch (error) { this.reportWriteFailure(error, 'stdout', String(event)); }
    }
    this.chain = this.chain.then(async () => {
      await mkdir(this.dir, {recursive:true});
      const target = path.join(this.dir, this.file);
      await this.rotateIfNeeded(target, Buffer.byteLength(line));
      await appendFile(target, line, 'utf8');
    }).catch(error => this.reportWriteFailure(error, path.join(this.dir, this.file), String(event)));
    return this.chain;
  }

  async rotateIfNeeded(target, incomingBytes) {
    try {
      const info = await stat(target);
      if (info.size + incomingBytes <= this.maxBytes) return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try { await unlink(`${target}.${this.maxFiles}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = `${target}.${index}`;
      const to = `${target}.${index + 1}`;
      try { await rename(from, to); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rename(target, `${target}.1`);
  }

  reportWriteFailure(error, target, sourceEvent) {
    const entry = {
      schemaVersion: LOG_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      level: 'error',
      event: 'logger.write_failed',
      target,
      sourceEvent,
      errorName: String(error?.name ?? 'Error'),
      errorCode: String(error?.code ?? 'unknown')
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  error(event, fields) { return this.log('error', event, fields); }
  warn(event, fields) { return this.log('warn', event, fields); }
  info(event, fields) { return this.log('info', event, fields); }
  debug(event, fields) { return this.log('debug', event, fields); }
  trace(event, fields) { return this.log('trace', event, fields); }
}

export class LogContext {
  constructor(logger, base = {}) { this.logger = logger; this.base = {...base}; }
  child(fields = {}) { return new LogContext(this.logger, {...this.base, ...fields}); }
  log(level, event, fields = {}) { return this.logger.log(level, event, {...this.base, ...fields}); }
  error(event, fields) { return this.log('error', event, fields); }
  warn(event, fields) { return this.log('warn', event, fields); }
  info(event, fields) { return this.log('info', event, fields); }
  debug(event, fields) { return this.log('debug', event, fields); }
  trace(event, fields) { return this.log('trace', event, fields); }
}
