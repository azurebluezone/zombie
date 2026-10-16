// Response hardening shared by every HTTP/HTTPS/UDS client of the runtime.
// Headers are applied with `res.setHeader()` before any `writeHead()`, because
// Node merges previously-set headers with the ones passed to `writeHead()`.

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'authorization, content-type, x-request-id, x-trace-id';
const PREFLIGHT_MAX_AGE = '600';

/** Returns the request Origin when it is explicitly allowlisted, else null. */
export function matchesAllowedOrigin(origin, allowedOrigins = []) {
  const candidate = String(origin ?? '').trim();
  if (!candidate) return null;
  const allow = allowedOrigins.map(value => String(value).trim().toLowerCase()).filter(Boolean);
  return allow.includes(candidate.toLowerCase()) ? candidate : null;
}

/**
 * Applies industry-standard response headers.
 *   - nosniff / referrer-policy / frame denial: browser hardening
 *   - cache-control no-store: this is a live control plane, never cache
 *   - HSTS only when the connection is actually TLS (direct or via proxy)
 *   - CORS only for explicitly allowlisted origins; never a wildcard
 */
export function applySecurityHeaders(res, { isTls = false, origin = null, allowedOrigins = [] } = {}) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('cache-control', 'no-store');
  if (isTls) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (allowedOrigins.length) {
    res.setHeader('vary', 'Origin');
    const allowed = matchesAllowedOrigin(origin, allowedOrigins);
    if (allowed) {
      res.setHeader('access-control-allow-origin', allowed);
      res.setHeader('access-control-allow-methods', ALLOWED_METHODS);
      res.setHeader('access-control-allow-headers', ALLOWED_HEADERS);
      res.setHeader('access-control-max-age', PREFLIGHT_MAX_AGE);
    }
  }
  return res;
}

/** True when the request arrived over TLS directly or through a trusted proxy. */
export function isTlsRequest(req) {
  if (req?.socket?.encrypted === true) return true;
  const forwarded = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https';
}
