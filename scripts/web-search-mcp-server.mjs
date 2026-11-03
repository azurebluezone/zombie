#!/usr/bin/env node
'use strict';

// Local web-search transport. It exists because the runtime's web_search tool
// needs a SearXNG-shaped JSON endpoint, while the same capability should also be
// discoverable as an external MCP server. One process serves both surfaces so an
// operator does not have to run two backends or paste an API key.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RESULTS = 8;
const USER_AGENT = 'zombiecoder-web-search/0.1 (+https://github.com/azurebluezone/zombie)';

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
};

function stripHtml(value) {
  return text(String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const url = text(item?.url);
    const title = text(item?.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title.slice(0, 300), url: url.slice(0, 2000), content: text(item?.content).slice(0, 600) });
  }
  return out;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch { json = null; }
  return { status: response.status, ok: response.ok, json, bytes: Buffer.byteLength(body) };
}

function flattenDuckDuckGoTopics(topics = []) {
  const out = [];
  for (const topic of Array.isArray(topics) ? topics : []) {
    if (Array.isArray(topic?.Topics)) out.push(...flattenDuckDuckGoTopics(topic.Topics));
    else if (topic?.FirstURL) out.push({ title: stripHtml(topic.Text), url: topic.FirstURL, content: stripHtml(topic.Text) });
  }
  return out;
}

function duckDuckGoResults(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const out = [];
  if (payload.AbstractURL) {
    out.push({
      title: stripHtml(payload.Heading || payload.AbstractSource || 'DuckDuckGo summary'),
      url: payload.AbstractURL,
      content: stripHtml(payload.AbstractText)
    });
  }
  if (payload.Answer && payload.AbstractURL) {
    out.push({ title: 'DuckDuckGo answer', url: payload.AbstractURL, content: stripHtml(payload.Answer) });
  }
  for (const item of Array.isArray(payload.Results) ? payload.Results : []) {
    if (item?.FirstURL) out.push({ title: stripHtml(item.Text), url: item.FirstURL, content: stripHtml(item.Text) });
  }
  out.push(...flattenDuckDuckGoTopics(payload.RelatedTopics));
  return out;
}

function wikipediaResults(payload) {
  const rows = Array.isArray(payload?.query?.search) ? payload.query.search : [];
  return rows.map((row) => ({
    title: text(row.title),
    url: row.pageid ? `https://en.wikipedia.org/?curid=${row.pageid}` : `https://en.wikipedia.org/wiki/${encodeURIComponent(String(row.title ?? '').replaceAll(' ', '_'))}`,
    content: stripHtml(row.snippet)
  }));
}

/**
 * Search public sources without an API key. DuckDuckGo's HTML endpoint answers
 * with an anti-bot challenge from this host, so the Instant Answer API and the
 * Wikipedia Search API are the two backends that return real JSON reliably.
 */
export async function searchWeb(query, { limit = DEFAULT_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchJsonImpl = fetchJson } = {}) {
  const clean = text(query);
  if (!clean) throw new Error('query_required');
  const max = clamp(limit, 1, 25, DEFAULT_RESULTS);
  const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(clean)}&format=json&utf8=1&srlimit=${Math.min(max, 10)}`;
  const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(clean)}&format=json&no_html=1&skip_disambig=1`;

  const [wiki, ddg] = await Promise.allSettled([
    fetchJsonImpl(wikiUrl, timeoutMs),
    fetchJsonImpl(ddgUrl, timeoutMs)
  ]);

  const backends = {};
  const collected = [];

  if (ddg.status === 'fulfilled' && ddg.value?.json) {
    const rows = duckDuckGoResults(ddg.value.json);
    backends.duckduckgo = { status: ddg.value.status, count: rows.length };
    collected.push(...rows);
  } else {
    backends.duckduckgo = { status: 'error', error: text(ddg.reason?.message ?? 'duckduckgo_failed').slice(0, 120) };
  }

  if (wiki.status === 'fulfilled' && wiki.value?.json) {
    const rows = wikipediaResults(wiki.value.json);
    backends.wikipedia = { status: wiki.value.status, count: rows.length };
    collected.push(...rows);
  } else {
    backends.wikipedia = { status: 'error', error: text(wiki.reason?.message ?? 'wikipedia_failed').slice(0, 120) };
  }

  const results = dedupe(collected).slice(0, max);
  return { query: clean, results, count: results.length, backends };
}

function jsonRpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function toolDefinition() {
  return {
    name: 'web_search',
    description: 'Search the public web. Returns title, url and snippet for each result. Backends: DuckDuckGo Instant Answer and Wikipedia Search; no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results, 1-25', default: DEFAULT_RESULTS }
      },
      required: ['query'],
      additionalProperties: false
    }
  };
}

function resultText(result) {
  if (!result.results.length) return `No results for ${result.query}`;
  return result.results.map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.content}`).join('\n\n');
}

export function createWebSearchServer({ search = searchWeb, sessions = new Map() } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'zombiecoder-web-search',
          protocolVersion: LATEST_PROTOCOL_VERSION,
          supportedProtocolVersions: [...PROTOCOL_VERSIONS],
          backends: ['duckduckgo', 'wikipedia'],
          tools: ['web_search']
        });
      }

      if (req.method === 'GET' && url.pathname === '/search') {
        const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? '';
        const limit = url.searchParams.get('limit') ?? url.searchParams.get('results') ?? DEFAULT_RESULTS;
        const result = await search(query, { limit: clamp(limit, 1, 25, DEFAULT_RESULTS) });
        return sendJson(res, 200, { query: result.query, results: result.results, count: result.count, backends: result.backends });
      }

      if (url.pathname !== '/mcp') {
        return sendJson(res, 404, { error: 'not_found' });
      }

      if (req.method === 'GET') {
        res.writeHead(405, { allow: 'POST, DELETE' });
        return res.end();
      }

      if (req.method === 'DELETE') {
        const session = String(req.headers['mcp-session-id'] ?? '');
        if (session) sessions.delete(session);
        res.writeHead(204);
        return res.end();
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST, DELETE' });
        return res.end();
      }

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      }
      if (!payload || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
        return sendJson(res, 400, jsonRpcError(payload?.id, -32600, 'Invalid Request'));
      }

      const method = payload.method;
      const id = payload.id;
      const notification = id === undefined || id === null;

      if (method === 'initialize') {
        const requested = String(payload.params?.protocolVersion ?? LATEST_PROTOCOL_VERSION);
        if (!PROTOCOL_VERSIONS.includes(requested)) {
          return sendJson(res, 400, jsonRpcError(id, -32602, `Unsupported protocol version: ${requested}`, { supported: [...PROTOCOL_VERSIONS] }));
        }
        const session = `wss_${randomUUID()}`;
        sessions.set(session, { protocolVersion: requested, createdAt: Date.now() });
        return sendJson(res, 200, jsonRpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'zombiecoder-web-search', version: '0.1.0' }
        }), { 'mcp-session-id': session, 'mcp-protocol-version': requested });
      }

      if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        res.writeHead(202);
        return res.end();
      }

      if (notification) {
        res.writeHead(202);
        return res.end();
      }

      const headerVersion = String(req.headers['mcp-protocol-version'] ?? '');
      const sessionId = String(req.headers['mcp-session-id'] ?? '');
      const session = sessionId ? sessions.get(sessionId) : null;
      if (sessionId && !session) return sendJson(res, 404, jsonRpcError(id, -32001, 'Session not found'));
      if (headerVersion && !PROTOCOL_VERSIONS.includes(headerVersion)) {
        return sendJson(res, 400, jsonRpcError(id, -32602, `Unsupported protocol version: ${headerVersion}`, { supported: [...PROTOCOL_VERSIONS] }));
      }

      if (method === 'ping') return sendJson(res, 200, jsonRpcResult(id, {}));
      if (method === 'tools/list') return sendJson(res, 200, jsonRpcResult(id, { tools: [toolDefinition()] }));

      if (method === 'tools/call') {
        const name = String(payload.params?.name ?? '');
        if (name !== 'web_search') return sendJson(res, 200, jsonRpcError(id, -32601, `Unknown tool: ${name}`));
        const args = payload.params?.arguments && typeof payload.params.arguments === 'object' ? payload.params.arguments : {};
        try {
          const result = await search(String(args.query ?? ''), { limit: clamp(args.limit, 1, 25, DEFAULT_RESULTS) });
          return sendJson(res, 200, jsonRpcResult(id, {
            content: [{ type: 'text', text: resultText(result) }],
            structuredContent: { query: result.query, results: result.results, count: result.count, backends: result.backends },
            isError: false
          }));
        } catch (error) {
          return sendJson(res, 200, jsonRpcResult(id, {
            content: [{ type: 'text', text: String(error?.message ?? error) }],
            isError: true
          }));
        }
      }

      return sendJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${method}`));
    } catch (error) {
      return sendJson(res, 500, { error: 'web_search_transport_failed', detail: text(error?.message ?? error).slice(0, 200) });
    }
  });
}

export async function startWebSearchServer({ host = '127.0.0.1', port = 8091, search = searchWeb } = {}) {
  const server = createWebSearchServer({ search });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const host = process.env.WEB_SEARCH_TRANSPORT_HOST || '127.0.0.1';
  const port = clamp(process.env.WEB_SEARCH_TRANSPORT_PORT ?? 8091, 1, 65535, 8091);
  const server = await startWebSearchServer({ host, port });
  const address = server.address();
  console.log(`WEB_SEARCH_MCP_READY http://${host}:${address.port} tools=web_search protocol=${LATEST_PROTOCOL_VERSION}`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
