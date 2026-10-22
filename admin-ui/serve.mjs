#!/usr/bin/env node
// Static host for the ZombieCoder admin UI.
// Zero dependencies, loopback by default. This process knows nothing about the
// runtime: it serves files and GET/HEAD only. The browser does the API calls.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ADMIN_UI_PORT ?? 8088);
const HOST = process.env.ADMIN_UI_HOST ?? '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

function resolve(requestPath) {
  let rel;
  try { rel = decodeURIComponent(requestPath); } catch { return null; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(ROOT, '.' + rel);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method_not_allowed');
    return;
  }
  const file = resolve(new URL(req.url, 'http://localhost').pathname);
  if (!file) { res.writeHead(400).end('bad_path'); return; }
  let info;
  try { info = await stat(file); } catch { res.writeHead(404).end('not_found'); return; }
  if (info.isDirectory()) { res.writeHead(404).end('not_found'); return; }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[admin-ui] http://${HOST}:${PORT}  (serving ${ROOT})`);
  console.log('[admin-ui] no runtime coupling: the page talks to the API you enter.');
});
