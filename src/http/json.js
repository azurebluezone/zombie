/*
 * OpenAI-shaped error bodies.
 *
 * The runtime writes an error as `{error:'some_code'}`. An OpenAI-compatible
 * client does not read that shape: it looks for `error.message`, and when the
 * shape is wrong it gives up and shows "Error code: 401" with no reason at all.
 * (The OpenAI SDKs guard the lookup with a bare `except`, so a string `error`
 * degrades silently rather than crashing — which is exactly why the problem is
 * easy to miss.)
 *
 * So every 4xx/5xx body carrying a string `error` is rewritten on the way out:
 *
 *   { "error": { "message": "<code>", "type": "<type>", "param": null, "code": "<code>" } }
 *
 * The code is carried twice on purpose. `message` is what a human or a log line
 * shows; `code` is what a client matches on. Any other body field survives
 * untouched, so a response like `{error:'x',executionMode:'y'}` keeps `executionMode`.
 *
 * `param` is taken from the body only when the caller passed a string, which is
 * how a validation error names the offending field.
 */
const ERROR_TYPES = { 429: 'rate_limit_error' };

function errorType(status) {
  if (ERROR_TYPES[status]) return ERROR_TYPES[status];
  return status >= 500 ? 'server_error' : 'invalid_request_error';
}

function openAiErrorBody(status, code, param = null) {
  return { error: { message: String(code), type: errorType(status), param: param ?? null, code: String(code) } };
}

function normalizeErrorBody(status, bodyValue) {
  if (status < 400) return bodyValue;
  if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue)) return bodyValue;
  if (typeof bodyValue.error !== 'string' || !bodyValue.error) return bodyValue;
  const rest = { ...bodyValue };
  const code = rest.error;
  const param = typeof rest.param === 'string' ? rest.param : null;
  delete rest.error;
  delete rest.param;
  return { ...openAiErrorBody(status, code, param), ...rest };
}

export function send(res, status, bodyValue, headers = {}) {
  if (res.headersSent) return false;
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', ...headers});
  res.end(JSON.stringify(normalizeErrorBody(status, bodyValue)));
  return true;
}

export async function body(req, maxBytes = 4 * 1024 * 1024) {
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) {
      const error = new Error('request_body_too_large');
      error.statusCode = 413;
      req.destroy();
      throw error;
    }
    raw += chunk;
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const error = new Error('invalid_json_body');
    error.statusCode = 400;
    throw error;
  }
}

export function bearer(req) { const h=req.headers.authorization ?? ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }
