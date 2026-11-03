#!/usr/bin/env node
'use strict';

// Writes the deployment values an installer owns without rewriting secrets it
// does not own. Existing provider keys stay exactly as the operator left them;
// only missing runtime secrets are generated, and every write leaves a backup.
import { randomBytes } from 'node:crypto';
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { out[key] = next; index += 1; }
    else out[key] = true;
  }
  return out;
}

function normalizeOllamaBase(raw) {
  let value = String(raw ?? '').trim();
  if (!value) value = 'http://127.0.0.1:11434';
  value = value.replace(/\/+$/, '');
  value = value.replace(/\/(v1|api)$/i, '');
  return value;
}

function parseEnv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    rows.push(match ? { raw: line, key: match[1], value: match[2] } : { raw: line, key: null, value: null });
  }
  return rows;
}

function serialize(rows) {
  return `${rows.map((row) => row.raw).join('\n').replace(/\n+$/, '')}\n`;
}

function get(rows, key) {
  return rows.find((row) => row.key === key)?.value ?? '';
}

function set(rows, key, value, { onlyIfMissing = false } = {}) {
  const stringValue = String(value ?? '');
  const existing = rows.find((row) => row.key === key);
  if (existing) {
    if (onlyIfMissing && String(existing.value ?? '').trim()) return false;
    if (existing.value === stringValue) return false;
    existing.raw = `${key}=${stringValue}`;
    existing.value = stringValue;
    return true;
  }
  rows.push({ raw: `${key}=${stringValue}`, key, value: stringValue });
  return true;
}

function mergeList(existing, additions) {
  const values = String(existing ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const item of additions) if (!values.includes(item)) values.push(item);
  return values.join(',');
}

function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function updateProviderConfig(raw, { ollamaBaseUrl, ollamaModel, llamaCppOk }) {
  let list = [];
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  if (!list.length) {
    list = [
      {
        id: 'ollama-selfhosted', name: 'Ollama Self-Hosted', driver: 'ollama', protocol: 'openai-compatible',
        baseUrl: `${ollamaBaseUrl}/v1`, defaultModel: ollamaModel || '', models: ollamaModel ? [ollamaModel] : [],
        enabled: true, capabilities: ['chat-completions', 'streaming', 'function-calling', 'model-catalog'], priority: 1
      }
    ];
  }
  for (const provider of list) {
    if (!provider || typeof provider !== 'object') continue;
    if (provider.id === 'ollama-selfhosted') {
      provider.baseUrl = `${ollamaBaseUrl}/v1`;
      provider.enabled = true;
      provider.priority = 1;
      if (ollamaModel) {
        provider.defaultModel = ollamaModel;
        provider.models = [ollamaModel];
      }
    }
    if (provider.id === 'llama-cpu') {
      provider.enabled = llamaCppOk;
      if (!llamaCppOk) provider.priority = 9;
    }
  }
  return JSON.stringify(list);
}

export async function writeInstallEnv({
  root = process.cwd(),
  ollamaUrl = 'http://127.0.0.1:11434',
  ollamaModel = '',
  llamaCppOk = false,
  runtimePort = 9999,
  webSearchPort = 8091,
  adminUiPort = 8088,
  caddyHttpsPort = 9443,
  adminHttpsPort = 9444,
  enableTools = true
} = {}) {
  const envFile = path.join(root, '.env');
  const exampleFile = path.join(root, '.env.example');
  let created = false;
  let source;
  try {
    source = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = await readFile(exampleFile, 'utf8');
    created = true;
  }

  const rows = parseEnv(source);
  const changed = [];
  const mark = (key, did) => { if (did) changed.push(key); };
  const base = normalizeOllamaBase(ollamaUrl);
  const model = String(ollamaModel ?? '').trim();

  mark('OLLAMA_BASE_URL', set(rows, 'OLLAMA_BASE_URL', `${base}/v1`));
  if (model) mark('OLLAMA_MODEL', set(rows, 'OLLAMA_MODEL', model));
  mark('PROVIDER_ALLOW_PRIVATE_NETWORK', set(rows, 'PROVIDER_ALLOW_PRIVATE_NETWORK', 'true'));
  mark('PROVIDER_ALLOW_PRIVATE_HOSTS', set(rows, 'PROVIDER_ALLOW_PRIVATE_HOSTS', mergeList(get(rows, 'PROVIDER_ALLOW_PRIVATE_HOSTS'), ['127.0.0.1', 'localhost'])));
  mark('ZOMBIECODER_EXECUTION_MODE', set(rows, 'ZOMBIECODER_EXECUTION_MODE', enableTools ? 'tools-enabled' : 'chat-only'));

  const adminToken = String(get(rows, 'ADMIN_TOKEN') ?? '').trim();
  let adminTokenGenerated = false;
  if (!adminToken || /^replace-with-/i.test(adminToken)) {
    mark('ADMIN_TOKEN', set(rows, 'ADMIN_TOKEN', generateSecret(32)));
    adminTokenGenerated = true;
  }
  const runtimeSecret = String(get(rows, 'RUNTIME_SECRET') ?? '').trim();
  if (!runtimeSecret || /^replace-with-/i.test(runtimeSecret)) {
    mark('RUNTIME_SECRET', set(rows, 'RUNTIME_SECRET', generateSecret(32)));
  }

  mark('WEB_SEARCH_ENDPOINT', set(rows, 'WEB_SEARCH_ENDPOINT', `http://127.0.0.1:${webSearchPort}/search`));
  mark('WEB_SEARCH_API_KEY', set(rows, 'WEB_SEARCH_API_KEY', '', { onlyIfMissing: true }));
  mark('WEB_SEARCH_RESULTS', set(rows, 'WEB_SEARCH_RESULTS', '8', { onlyIfMissing: true }));
  mark('WEB_SEARCH_TIMEOUT_MS', set(rows, 'WEB_SEARCH_TIMEOUT_MS', '15000', { onlyIfMissing: true }));
  mark('WEB_SEARCH_TRANSPORT_HOST', set(rows, 'WEB_SEARCH_TRANSPORT_HOST', '127.0.0.1'));
  mark('WEB_SEARCH_TRANSPORT_PORT', set(rows, 'WEB_SEARCH_TRANSPORT_PORT', String(webSearchPort)));
  mark('EXTERNAL_MCP_WEB_SEARCH_URL', set(rows, 'EXTERNAL_MCP_WEB_SEARCH_URL', `http://127.0.0.1:${webSearchPort}/mcp`));
  mark('EXTERNAL_MCP_DISCOVER_ON_START', set(rows, 'EXTERNAL_MCP_DISCOVER_ON_START', 'true'));
  mark('EXTERNAL_MCP_REFRESH_TOOLS_ON_START', set(rows, 'EXTERNAL_MCP_REFRESH_TOOLS_ON_START', 'true'));
  mark('MCP_ALLOW_HTTP', set(rows, 'MCP_ALLOW_HTTP', 'true'));
  mark('MCP_ALLOW_PRIVATE_NETWORK', set(rows, 'MCP_ALLOW_PRIVATE_NETWORK', 'true'));
  mark('MCP_ALLOW_HOSTS', set(rows, 'MCP_ALLOW_HOSTS', mergeList(get(rows, 'MCP_ALLOW_HOSTS'), ['127.0.0.1', 'localhost'])));
  mark('CORS_ALLOW_ORIGINS', set(rows, 'CORS_ALLOW_ORIGINS', mergeList(get(rows, 'CORS_ALLOW_ORIGINS'), [
    `http://127.0.0.1:${adminUiPort}`,
    `https://localhost:${adminHttpsPort}`,
    `https://127.0.0.1:${adminHttpsPort}`
  ])));
  mark('ZC_CADDY_HTTPS_PORT', set(rows, 'ZC_CADDY_HTTPS_PORT', String(caddyHttpsPort)));
  mark('ZC_ADMIN_HTTPS_PORT', set(rows, 'ZC_ADMIN_HTTPS_PORT', String(adminHttpsPort)));
  mark('ZC_RUNTIME_PORT', set(rows, 'ZC_RUNTIME_PORT', String(runtimePort)));
  mark('ZC_ADMIN_UI_PORT', set(rows, 'ZC_ADMIN_UI_PORT', String(adminUiPort)));
  mark('PORT', set(rows, 'PORT', String(runtimePort)));

  let providerRaw = get(rows, 'PROVIDER_CONFIG_JSON');
  if (!String(providerRaw ?? '').trim()) {
    try { providerRaw = get(parseEnv(await readFile(exampleFile, 'utf8')), 'PROVIDER_CONFIG_JSON'); } catch {}
  }
  const providerConfig = updateProviderConfig(providerRaw, { ollamaBaseUrl: base, ollamaModel: model, llamaCppOk: Boolean(llamaCppOk) });
  mark('PROVIDER_CONFIG_JSON', set(rows, 'PROVIDER_CONFIG_JSON', providerConfig));

  const next = serialize(rows);
  if (!created && next === source) {
    return { file: envFile, created: false, changed: [], adminTokenGenerated: false, model: model || null, llamaCppOk: Boolean(llamaCppOk) };
  }

  if (!created) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(envFile, `${envFile}.bak.${stamp}`);
  }
  const temp = `${envFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, envFile);
  try { await stat(envFile); } catch {}
  return { file: envFile, created, changed, adminTokenGenerated, model: model || null, llamaCppOk: Boolean(llamaCppOk) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const result = await writeInstallEnv({
    root: path.resolve(String(args.root ?? process.cwd())),
    ollamaUrl: String(args['ollama-url'] ?? 'http://127.0.0.1:11434'),
    ollamaModel: String(args['ollama-model'] ?? ''),
    llamaCppOk: String(args['llama-cpp-ok'] ?? '0') === '1',
    runtimePort: Number(args['runtime-port'] ?? 9999),
    webSearchPort: Number(args['web-search-port'] ?? 8091),
    adminUiPort: Number(args['admin-ui-port'] ?? 8088),
    caddyHttpsPort: Number(args['caddy-https-port'] ?? 9443),
    adminHttpsPort: Number(args['admin-https-port'] ?? 9444),
    enableTools: String(args['enable-tools'] ?? '1') !== '0'
  });
  console.log(JSON.stringify(result, null, 2));
}
