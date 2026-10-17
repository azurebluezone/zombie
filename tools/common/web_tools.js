import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { assertSafeOutboundUrl } from '../../src/network/outbound-policy.js';
import { RUNTIME_USER_AGENT } from '../../src/runtime/version.js';

/*
 * The two tools that leave the machine.
 *
 *   fetch_web_page — a URL chosen by the model or the customer. Untrusted, so
 *                    it is held to the strictest policy: https, standard port,
 *                    public address only, every redirect hop re-validated.
 *   web_search     — an endpoint chosen by the operator in `.env`. Trusted, so
 *                    a private SearXNG address is allowed, because an operator
 *                    who wrote the URL down already made that decision.
 *
 * Both return the MCP text envelope `{content:[{type:'text',text}]}`, the same
 * shape every other native tool returns.
 */

const textResult = (text, extra = {}) => ({ content: [{ type: 'text', text: String(text) }], ...extra });
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
const flag = (value) => String(value ?? '').trim().toLowerCase() === 'true';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

const FETCH_USER_AGENT = `${RUNTIME_USER_AGENT} (+web-fetch)`;

/* -------------------------------------------------------------------------- */
/* Text extraction                                                            */
/* -------------------------------------------------------------------------- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', bull: '•', deg: '°',
};

export function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/**
 * Turn a page into readable text. Deliberately lossy: scripts, styles, comments
 * and markup are dropped so the model receives prose instead of a wall of tags.
 * Bengali text survives untouched — the only rewriting is whitespace.
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  text = text.replace(/<template[\s\S]*?<\/template>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/\n[^\S\n]*/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function extractTitle(html) {
  const match = String(html ?? '').match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One HTTP exchange with a hard byte ceiling and a wall-clock timeout.
 *
 * `lookup` is the pinned resolver returned by `assertSafeOutboundUrl`. Passing
 * it here is what closes the DNS-rebinding window: the address that was checked
 * is the address that is dialled, even if DNS changes in between.
 */
export function httpExchange(url, { method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, headers = {}, lookup, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const options = { method, headers, timeout: timeoutMs };
    if (lookup) options.lookup = lookup;

    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };

    const request = send(target, options, (response) => {
      const chunks = [];
      let size = 0;
      let truncated = false;

      response.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
          response.destroy();
          finish(resolve, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated: true,
          });
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => finish(resolve, {
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        truncated,
      }));

      response.on('error', (error) => finish(reject, error));
    });

    request.on('timeout', () => request.destroy(new Error('web_request_timeout')));
    request.on('error', (error) => finish(reject, error));
    if (body) request.write(body);
    request.end();
  });
}

/**
 * Follow redirects by hand, because every hop is a new SSRF decision.
 *
 * Node's `http.request` does not follow redirects, and the global `fetch` does
 * so without telling us where it is about to go. Re-validating each Location
 * against the same policy means a public URL cannot bounce the runtime onto
 * `http://169.254.169.254/` or an internal host on a non-standard port.
 */
export async function fetchWithRedirects(rawUrl, policy, options = {}) {
  let current = rawUrl;
  const chain = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safe = await assertSafeOutboundUrl(current, policy);
    const response = await httpExchange(safe.url.href, { ...options, lookup: safe.lookup });
    const location = response.headers?.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(Number(response.status));
    if (!isRedirect || !location) {
      return { ...response, finalUrl: safe.url.href, redirects: chain };
    }
    chain.push({ from: safe.url.href, status: Number(response.status), to: String(location) });
    current = new URL(String(location), safe.url.href).href;
  }
  throw new Error('web_fetch_too_many_redirects');
}

/* -------------------------------------------------------------------------- */
/* fetch_web_page                                                             */
/* -------------------------------------------------------------------------- */

function fetchPolicy() {
  return {
    protocols: ['https:'],
    allowPlaintextHttp: flag(process.env.WEB_FETCH_ALLOW_HTTP),
    allowHosts: [],
    allowPrivateNetwork: false,
    allowPrivateHosts: [],
    requireStandardHttpsPort: true,
  };
}

async function fetchWebPage(args = {}) {
  const raw = String(args.url ?? '').trim();
  if (!raw) throw new Error('url_required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('url_invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('outbound_protocol_forbidden');

  const timeoutMs = clamp(args.timeoutMs ?? process.env.WEB_FETCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, 1000, 60000);
  const maxBytes = clamp(args.maxBytes ?? process.env.WEB_FETCH_MAX_BYTES ?? DEFAULT_MAX_BYTES, 1024, 4_000_000);
  const maxChars = clamp(args.maxChars ?? 20000, 200, 200000);

  const response = await fetchWithRedirects(parsed.href, fetchPolicy(), {
    timeoutMs,
    maxBytes,
    headers: {
      'user-agent': FETCH_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.9,*/*;q=0.5',
      'accept-language': 'en,bn;q=0.8',
    },
  });

  if (Number(response.status) < 200 || Number(response.status) >= 300) {
    throw new Error(`web_fetch_http_${Number(response.status)}`);
  }

  const contentType = String(response.headers?.['content-type'] ?? '');
  const looksLikeHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(response.body);
  const title = looksLikeHtml ? extractTitle(response.body) : null;
  const text = looksLikeHtml ? htmlToText(response.body) : response.body.trim();
  const clipped = text.slice(0, maxChars);

  return textResult(clipped, {
    url: response.finalUrl,
    status: Number(response.status),
    contentType: contentType || null,
    title,
    redirects: response.redirects,
    truncated: response.truncated === true || clipped.length < text.length,
    chars: clipped.length,
  });
}

/* -------------------------------------------------------------------------- */
/* web_search                                                                 */
/* -------------------------------------------------------------------------- */

function searchPolicy(endpoint) {
  const url = new URL(endpoint);
  return {
    protocols: ['https:', 'http:'],
    allowPlaintextHttp: true,
    // The operator wrote this URL into .env. A self-hosted SearXNG normally
    // lives on a private address, and refusing it would make the tool useless
    // for the only backend that is both free and reliable.
    allowPrivateNetwork: true,
    allowPrivateHosts: [url.hostname],
    requireStandardHttpsPort: false,
  };
}

function normalizeResults(payload, limit) {
  const raw = Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.data) ? payload.data
    : [];
  return raw.slice(0, limit).map((item) => ({
    title: decodeEntities(String(item?.title ?? item?.name ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300),
    url: String(item?.url ?? item?.link ?? item?.href ?? '').trim().slice(0, 2000),
    snippet: decodeEntities(String(item?.content ?? item?.snippet ?? item?.description ?? '').replace(/\s+/g, ' ').trim()).slice(0, 600),
  })).filter((item) => item.url || item.title);
}

async function webSearch(args = {}) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query_required');

  const endpoint = String(process.env.WEB_SEARCH_ENDPOINT ?? '').trim();
  if (!endpoint) throw new Error('search_backend_not_configured');

  const limit = clamp(args.limit ?? process.env.WEB_SEARCH_RESULTS ?? 8, 1, 25);
  const timeoutMs = clamp(args.timeoutMs ?? process.env.WEB_SEARCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, 1000, 60000);
  const apiKey = String(process.env.WEB_SEARCH_API_KEY ?? '').trim();

  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');

  const headers = { 'user-agent': FETCH_USER_AGENT, accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const safe = await assertSafeOutboundUrl(url.href, searchPolicy(endpoint));
  const response = await httpExchange(safe.url.href, { timeoutMs, maxBytes: 2_000_000, headers, lookup: safe.lookup });

  if (Number(response.status) < 200 || Number(response.status) >= 300) {
    throw new Error(`search_backend_http_${Number(response.status)}`);
  }

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error('search_backend_invalid_json');
  }

  const results = normalizeResults(payload, limit);
  const text = results.length
    ? results.map((item, index) => `${index + 1}. ${item.title || '(untitled)'}\n   ${item.url}\n   ${item.snippet}`).join('\n\n')
    : `No results for ${query}`;

  return textResult(text, { query, results, backend: url.origin, count: results.length });
}

/* -------------------------------------------------------------------------- */

export async function execute(args = {}, ctx = {}) {
  switch (ctx.toolId) {
    case 'fetch_web_page': return fetchWebPage(args);
    case 'web_search': return webSearch(args);
    default: throw new Error(`unknown_web_tool:${String(ctx.toolId)}`);
  }
}
