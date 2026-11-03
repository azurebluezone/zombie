#!/usr/bin/env node
// Round-4 release gate.
//
// Fast checks run live: installer syntax, the env writer on a throwaway copy,
// Node 24, the real build, the running runtime, both Caddy TLS edges, external
// MCP discovery, and a real web_search tool call. The 12x28 matrix is a real
// run recorded separately; this gate verifies that artifact instead of repeating
// a multi-minute model loop inside the contract-close budget.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = 'http://127.0.0.1:9999';
const ADMIN_UI = 'http://127.0.0.1:8088';
const REPORT = path.join(ROOT, 'data/round4-verification.json');
const MATRIX_ARTIFACT = path.join(ROOT, 'data/agent-mcp-matrix.json');
const MAX_MATRIX_AGE_MS = 48 * 60 * 60 * 1000;
const CA_CANDIDATES = [
  path.join(os.homedir(), '.local/share/caddy/pki/authorities/local/root.crt'),
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'caddy/pki/authorities/local/root.crt')
];

const checks = {};
const failures = [];
function record(name, status, detail = {}) {
  checks[name] = { status, ...detail };
  if (status === 'fail') failures.push(`${name}:${detail.reason ?? 'failed'}`);
}
function pass(name, detail = {}) { record(name, 'pass', detail); }
function fail(name, reason, detail = {}) { record(name, 'fail', { reason, ...detail }); }

function run(command, args, { timeoutMs = 60000, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-500000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-200000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readEnvFile() {
  const text = await readFile(path.join(ROOT, '.env'), 'utf8');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return { text, values };
}

async function jsonFetch(url, options = {}, timeoutMs = 15000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, headers: response.headers, body, text };
}

async function verifyInstaller() {
  const result = await run('bash', ['-n', 'install.sh'], { timeoutMs: 10000 });
  if (result.code !== 0) return fail('installer', 'bash_syntax_failed', { tail: result.stderr.slice(-400) });
  const script = await readFile(path.join(ROOT, 'install.sh'), 'utf8');
  const missing = ['git clone', 'ZC_NODE_MAJOR=24', 'scripts/install-env.mjs', 'deploy/caddy/Caddyfile.runtime', 'scripts/build-runtime.mjs', '/health', 'external-mcp/sync', 'INSTALL_OK'].filter(marker => !script.includes(marker));
  if (missing.length) return fail('installer', 'installer_steps_missing', { missing });

  // Exercise the env writer for real on a throwaway copy: syntax alone would not
  // prove that provider keys survive or that the seed is updated.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-round4-gate-'));
  try {
    await writeFile(path.join(dir, '.env.example'), 'ADMIN_TOKEN=replace-with-a-long-random-admin-token\nRUNTIME_SECRET=replace-with-a-long-random-runtime-secret\nPROVIDER_CONFIG_JSON=[]\n');
    await writeFile(path.join(dir, '.env'), 'ADMIN_TOKEN=gate-token\nRUNTIME_SECRET=gate-secret\nPROVIDER_KEY_GEMINI=gate-key\nPROVIDER_CONFIG_JSON=[{"id":"llama-cpu","enabled":true},{"id":"ollama-selfhosted","defaultModel":"REPLACE_WITH_OLLAMA_MODEL","models":[]}]\n');
    const envResult = await run(process.execPath, ['scripts/install-env.mjs', '--root', dir, '--ollama-model', 'qwen2.5:1.5b', '--llama-cpp-ok', '0'], { timeoutMs: 15000 });
    if (envResult.code !== 0) return fail('installer', 'env_writer_failed', { tail: envResult.stderr.slice(-400) });
    const written = await readFile(path.join(dir, '.env'), 'utf8');
    if (!/^PROVIDER_KEY_GEMINI=gate-key$/m.test(written)) return fail('installer', 'provider_key_overwritten');
    if (!/^WEB_SEARCH_ENDPOINT=http:\/\/127\.0\.0\.1:8091\/search$/m.test(written)) return fail('installer', 'web_search_endpoint_missing');
    const providers = JSON.parse(written.match(/^PROVIDER_CONFIG_JSON=(.*)$/m)[1]);
    if (providers.find(item => item.id === 'llama-cpu')?.enabled !== false) return fail('installer', 'dead_llama_not_disabled');
    if (providers.find(item => item.id === 'ollama-selfhosted')?.defaultModel !== 'qwen2.5:1.5b') return fail('installer', 'ollama_model_not_applied');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  pass('installer', { scriptBytes: Buffer.byteLength(script), envWriter: 'real_run' });
}

function verifyNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) return fail('node24', 'node_below_24', { version: process.versions.node });
  pass('node24', { version: process.versions.node });
}

async function verifyEnv() {
  if (!existsSync(path.join(ROOT, '.env'))) return fail('env', 'env_missing');
  const { values } = await readEnvFile();
  const problems = [];
  if (!/^http:\/\/127\.0\.0\.1:8091\/search$/.test(values.WEB_SEARCH_ENDPOINT || '')) problems.push('WEB_SEARCH_ENDPOINT');
  if (!/^http:\/\/127\.0\.0\.1:8091\/mcp$/.test(values.EXTERNAL_MCP_WEB_SEARCH_URL || '')) problems.push('EXTERNAL_MCP_WEB_SEARCH_URL');
  if (values.MCP_ALLOW_HTTP !== 'true') problems.push('MCP_ALLOW_HTTP');
  if (values.MCP_ALLOW_PRIVATE_NETWORK !== 'true') problems.push('MCP_ALLOW_PRIVATE_NETWORK');
  if (!/127\.0\.0\.1/.test(values.MCP_ALLOW_HOSTS || '')) problems.push('MCP_ALLOW_HOSTS');
  let providers = [];
  try { providers = JSON.parse(values.PROVIDER_CONFIG_JSON || '[]'); } catch { problems.push('PROVIDER_CONFIG_JSON_json'); }
  const ollama = providers.find(item => item.id === 'ollama-selfhosted');
  if (!ollama?.enabled) problems.push('ollama_disabled');
  if (!ollama?.defaultModel || /^REPLACE_WITH_/i.test(ollama.defaultModel)) problems.push('ollama_model_placeholder');
  const llama = providers.find(item => item.id === 'llama-cpu');
  if (llama && llama.enabled === true) {
    const probe = await fetch('http://127.0.0.1:9933/v1/models', { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
    if (!probe) problems.push('llama_enabled_but_unreachable');
  }
  if (problems.length) return fail('env', 'env_values_missing', { problems });
  pass('env', { ollamaModel: ollama.defaultModel, llamaCppEnabled: llama?.enabled === true });
}

async function verifyCaddyTls() {
  const ca = CA_CANDIDATES.find(file => existsSync(file));
  if (!ca) return fail('caddy_tls', 'caddy_ca_missing');
  const results = {};
  for (const [label, url] of [['runtime', 'https://localhost:9443/health'], ['admin', 'https://localhost:9444/']]) {
    const result = await run('curl', ['-fsS', '--cacert', ca, '-o', '/dev/null', '-w', '%{http_code}', url], { timeoutMs: 10000 });
    results[label] = { code: result.code, status: result.stdout.trim(), error: result.stderr.slice(-200) || null };
    if (result.code !== 0 || result.stdout.trim() !== '200') return fail('caddy_tls', `${label}_tls_failed`, results);
  }
  pass('caddy_tls', { ca, ...results });
}

async function verifyBuild() {
  const build = await run(process.execPath, ['scripts/build-runtime.mjs', '--output', 'dist/zombiecoder-runtime'], { timeoutMs: 60000 });
  if (build.code !== 0) return fail('build', 'build_failed', { tail: build.stderr.slice(-500) });
  let report = null;
  try { report = JSON.parse(build.stdout); } catch {}
  if (report?.verified !== true) return fail('build', 'build_not_verified', { tail: build.stdout.slice(-500) });
  const output = path.join(ROOT, 'dist/zombiecoder-runtime');
  for (const relative of ['start.js', 'src/server.js', 'package.json', '.zombiecoder-build.json']) {
    if (!existsSync(path.join(output, relative))) return fail('build', 'artifact_missing', { relative });
  }
  const syntax = await run(process.execPath, ['--check', path.join(output, 'src/server.js')], { timeoutMs: 15000 });
  if (syntax.code !== 0) return fail('build', 'artifact_syntax_failed', { tail: syntax.stderr.slice(-400) });
  pass('build', { files: report.files, syntaxChecks: report.syntaxChecks, output: 'dist/zombiecoder-runtime' });
}

async function verifyRuntime() {
  const health = await jsonFetch(`${RUNTIME}/health`, {}, 10000).catch(error => ({ status: 0, body: null, error: error.message }));
  if (health.status !== 200 || health.body?.ok !== true) return fail('start', 'runtime_health_failed', { status: health.status, error: health.error ?? null });
  pass('start', { httpStatus: health.status });

  const body = health.body;
  const problems = [];
  if (body.executionMode !== 'tools-enabled') problems.push('executionMode');
  if (!body.externalMcp || typeof body.externalMcp.registered !== 'number') problems.push('externalMcp');
  if (body.externalMcp?.registered < 1) problems.push('externalMcp_registered_zero');
  if (body.externalMcp?.discovered < 1) problems.push('externalMcp_discovered_zero');
  if (body.externalMcp?.tools < 1) problems.push('externalMcp_tools_zero');
  if (body.webSearch?.configured !== true) problems.push('webSearch_not_configured');
  if (problems.length) return fail('health', 'health_fields_missing', { problems, externalMcp: body.externalMcp ?? null, webSearch: body.webSearch ?? null });
  pass('health', { externalMcp: body.externalMcp, webSearch: body.webSearch });
}

async function verifyAdmin() {
  const page = await fetch(`${ADMIN_UI}/`, { signal: AbortSignal.timeout(10000) }).then(async r => ({ status: r.status, text: await r.text() })).catch(error => ({ status: 0, text: '', error: error.message }));
  if (page.status !== 200) return fail('admin', 'admin_ui_unreachable', { status: page.status, error: page.error ?? null });
  const missing = ['webSearchBanner', 'mcpGapBanner', '/api/config/mcp', 'paintMcp'].filter(marker => !page.text.includes(marker));
  if (missing.length) return fail('admin', 'admin_ui_markers_missing', { missing });
  const config = await jsonFetch(`${RUNTIME}/api/config/mcp`, {}, 10000);
  if (config.status !== 200 || config.body?.current_spec_version !== '2026-07-28' || config.body?.spec_gap !== '2026-07-28_not_implemented') {
    return fail('admin', 'mcp_config_mismatch', { status: config.status, current_spec_version: config.body?.current_spec_version ?? null });
  }
  pass('admin', { bytes: Buffer.byteLength(page.text), specGap: config.body.spec_gap });
}

async function verifyDocs() {
  const files = {
    readme: await readFile(path.join(ROOT, 'README.md'), 'utf8'),
    install: await readFile(path.join(ROOT, 'docs/FRESH_INSTALL.md'), 'utf8'),
    admin: await readFile(path.join(ROOT, 'admin-ui/README.md'), 'utf8')
  };
  const problems = [];
  if (!files.readme.includes('install.sh') || !files.readme.includes('9443') || !files.readme.includes('web_search')) problems.push('README');
  if (!files.install.includes('install.sh') || !files.install.includes('9443') || !files.install.includes('Caddy')) problems.push('FRESH_INSTALL');
  if (!files.admin.includes('Caddy') || !files.admin.includes('9443') || !files.admin.includes('web-search')) problems.push('admin-ui/README');
  if (problems.length) return fail('docs', 'docs_missing_installer_or_tls', { problems });
  pass('docs', { files: Object.keys(files) });
}

async function verifyExternalMcp() {
  const { values } = await readEnvFile();
  const token = values.ADMIN_TOKEN || '';
  const response = await jsonFetch(`${RUNTIME}/v1/admin/registry/external-mcp`, { headers: { authorization: `Bearer ${token}` } }, 15000);
  if (response.status !== 200) return fail('external_mcp', 'admin_registry_unreachable', { status: response.status });
  const endpoint = (response.body?.endpoints ?? []).find(item => item.id === 'web-search');
  const server = (response.body?.servers ?? []).find(item => item.id === 'web-search');
  if (!server) return fail('external_mcp', 'web_search_not_declared');
  if (!endpoint) return fail('external_mcp', 'web_search_endpoint_missing', { servers: response.body?.servers ?? [] });
  if (endpoint.status !== 'discovered') return fail('external_mcp', 'web_search_not_discovered', { status: endpoint.status, lastErrorCode: endpoint.lastErrorCode ?? null });
  if (!Array.isArray(endpoint.tools) || endpoint.tools.length < 1) return fail('external_mcp', 'web_search_has_no_tools');
  pass('external_mcp', { id: 'web-search', tools: endpoint.tools.length, protocolVersion: endpoint.protocolVersion ?? null });
}

async function verifyWebSearchTool() {
  let session = null;
  let protocolVersion = null;
  async function rpc(method, params, id) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    const response = await jsonFetch(`${RUNTIME}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    }, 30000);
    const next = response.headers.get('mcp-session-id');
    if (next) session = next;
    if (method === 'initialize') protocolVersion = response.body?.result?.protocolVersion ?? null;
    return response;
  }
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'round4-gate', version: '1' } }, 1);
  if (init.status !== 200 || !init.body?.result) return fail('web_search', 'mcp_initialize_failed', { status: init.status });
  const called = await rpc('tools/call', { name: 'web_search', arguments: { query: 'Node.js', limit: 5 } }, 2);
  const result = called.body?.result;
  if (called.status !== 200 || !result) return fail('web_search', 'tool_call_failed', { status: called.status, error: called.body?.error ?? null });
  const text = Array.isArray(result.content) ? result.content.map(item => item?.text ?? '').join('\n') : String(result.content ?? '');
  if (result.isError === true) return fail('web_search', 'tool_returned_error', { text: text.slice(0, 300) });
  if (!/https?:\/\/\S+/.test(text)) return fail('web_search', 'no_result_url', { text: text.slice(0, 300) });
  pass('web_search', { query: 'Node.js', bytes: Buffer.byteLength(text), sha256: sha256(text) });
}

async function verifyMatrix() {
  if (!existsSync(MATRIX_ARTIFACT)) return fail('matrix_live', 'matrix_artifact_missing');
  const artifact = JSON.parse(await readFile(MATRIX_ARTIFACT, 'utf8'));
  const age = Date.now() - Date.parse(artifact.finishedAt ?? artifact.startedAt ?? 0);
  const problems = [];
  if (!/^matrix-/.test(String(artifact.runId ?? ''))) problems.push('runId');
  if (!Number.isFinite(age) || age < 0 || age > MAX_MATRIX_AGE_MS) problems.push('artifact_stale');
  if (!artifact.provider) problems.push('provider_missing');
  if (!Array.isArray(artifact.agents) || artifact.agents.length !== 12) problems.push(`agents_${artifact.agents?.length ?? 0}`);
  for (const agent of artifact.agents ?? []) {
    if (agent.httpStatus !== 200 || agent.ok !== true || agent.sentinelMatched !== true || agent.providerId !== artifact.provider) problems.push(`agent_${agent.agentId}`);
  }
  if (!Array.isArray(artifact.tools) || artifact.tools.length !== 28) problems.push(`tools_${artifact.tools?.length ?? 0}`);
  const webSearch = (artifact.tools ?? []).find(tool => tool.toolId === 'web_search');
  if (webSearch?.status !== 'PASS') problems.push(`web_search_${webSearch?.status ?? 'missing'}`);
  if ((artifact.tools ?? []).some(tool => tool.status === 'FAIL')) problems.push('tool_failures');
  if (artifact.mcp?.toolsListed !== 28) problems.push(`mcp_tools_${artifact.mcp?.toolsListed ?? 0}`);
  if (artifact.upstream?.chatSentinel !== true) problems.push('upstream_chat');
  if (problems.length) return fail('matrix_live', 'matrix_artifact_incomplete', { problems, runId: artifact.runId ?? null });
  pass('matrix_live', {
    runId: artifact.runId,
    provider: artifact.provider,
    model: artifact.model,
    agents: artifact.agents.length,
    tools: artifact.tools.length,
    webSearch: webSearch.status,
    finishedAt: artifact.finishedAt,
    ageMs: age
  });
}

async function verifyTests() {
  const result = await run(process.execPath, ['--test'], { timeoutMs: 90000 });
  const counts = {
    tests: Number(result.stdout.match(/ℹ tests (\d+)/)?.[1] ?? 0),
    pass: Number(result.stdout.match(/ℹ pass (\d+)/)?.[1] ?? 0),
    fail: Number(result.stdout.match(/ℹ fail (\d+)/)?.[1] ?? 0),
    skipped: Number(result.stdout.match(/ℹ skipped (\d+)/)?.[1] ?? 0)
  };
  if (result.code !== 0 || counts.fail !== 0 || counts.skipped !== 0 || counts.pass < 445) {
    return fail('tests', 'test_suite_failed', { exitCode: result.code, ...counts, tail: (result.stderr || result.stdout).slice(-800) });
  }
  pass('tests', counts);
}

await verifyInstaller();
verifyNode();
await verifyEnv();
await verifyCaddyTls();
await verifyBuild();
await verifyRuntime();
await verifyAdmin();
await verifyDocs();
await verifyExternalMcp();
await verifyWebSearchTool();
await verifyMatrix();
await verifyTests();

const report = {
  checkedAt: new Date().toISOString(),
  runtime: RUNTIME,
  node: process.versions.node,
  checks,
  failures,
  status: failures.length ? 'FAIL' : 'PASS'
};
await mkdir(path.join(ROOT, 'data'), { recursive: true });
await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (failures.length) {
  console.log(`ROUND4_FAIL ${failures.join(',')}`);
  console.log(`report=${path.relative(ROOT, REPORT)}`);
  process.exit(1);
}

const summary = [
  'ROUND4_OK',
  'installer=ok',
  'node24=ok',
  'env=ok',
  'caddy_tls=ok',
  'build=ok',
  'start=ok',
  'health=ok',
  'admin=ok',
  'docs=ok',
  'external_mcp=web-search',
  'web_search=PASS',
  'matrix_live=real_run',
  `tests=${checks.tests.pass}`,
  `matrix_provider=${checks.matrix_live.provider}`,
  `matrix_model=${checks.matrix_live.model}`
];
console.log(summary.join(' '));
console.log(`report=${path.relative(ROOT, REPORT)}`);
