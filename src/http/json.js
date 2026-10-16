export function send(res, status, bodyValue, headers = {}) {
  if (res.headersSent) return false;
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', ...headers});
  res.end(JSON.stringify(bodyValue));
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
