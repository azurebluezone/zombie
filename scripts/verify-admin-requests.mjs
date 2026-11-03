#!/usr/bin/env node
// Contract gate for the admin request log, its disable switch, provider
// add/edit/test and the provider x model matrix.
//
// Everything here is a real run: the built runtime is started on a free loopback
// port with a throwaway DATA_DIR, a real HTTP server stands in for the vendor so
// the runtime's own chat path can complete without network flakiness, and the
// admin UI is fetched from its real static server. The shipped build is used on
// purpose: a stale dist fails instead of passing on source code.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'dist/zombiecoder-runtime');
const EXPECTED = 'ADMIN_OK requests=recorded,read,disabled,re-enabled providers=add,edit,test matrix=served ui=served';
const KEEP = process.env.ZC_ADMIN_CHECK_KEEP === '1';

const summary = { steps: [] };
const children = [];

function step(name) {
  summary.steps.push(name);
  console.error(`[admin-check] ${name}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fail(reason, detail = {}) {
  console.error(`ADMIN_FAIL reason=${reason}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
  process.exitCode = 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}

async function request(url, { method = 'GET', token = null, body = null, timeoutMs = 20000 } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body != null) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON stays text */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function waitFor(predicate, { attempts = 100, everyMs = 50, label = 'condition' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await delay(everyMs);
  }
  throw new Error(`timeout_waiting_for_${label}`);
}

function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        return json(200, { object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }] });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let model = 'stub-model';
        try { model = JSON.parse(body)?.model ?? model; } catch { /* keep default */ }
        return json(200, {
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'stub ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
        });
      }
      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
    server.once('error', reject);
  });
}

async function assertFreshBuild() {
  let marker;
  try {
    marker = JSON.parse(await readFile(path.join(BUILD, '.zombiecoder-build.json'), 'utf8'));
  } catch (error) {
    throw new Error(`build_marker_unreadable:${error.code ?? error.message}`);
  }
  const required = ['src/server.js', 'src/admin/request-log.js', 'src/storage/sqlite-store.js'];
  for (const relative of required) {
    if (!marker.sha256?.[relative]) throw new Error(`build_missing:${relative}`);
    const actual = createHash('sha256').update(await readFile(path.join(ROOT, relative))).digest('hex');
    if (actual !== marker.sha256[relative]) throw new Error(`build_stale:${relative}`);
  }
  return { version: marker.version, files: marker.fileCount, checked: required };
}

async function bootRuntime() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-admin-check-'));
  const port = await freePort();
  const adminToken = `check-${Date.now()}`;
  const child = spawn(process.execPath, ['start.js'], {
    cwd: BUILD,
    env: {
      ...process.env,
      ENV_LOADER_ENABLED: 'false',
      HOST: '127.0.0.1',
      PORT: String(port),
      ADMIN_TOKEN: adminToken,
      LOCAL_AUTH_BYPASS: 'false',
      DATA_DIR: dir,
      SQLITE_PATH: path.join(dir, 'runtime.sqlite'),
      LOG_DIR: path.join(dir, 'logs'),
      UDS_ENABLED: 'false',
      MCP_SERVER_ENABLED: 'false',
      PROVIDER_CONFIG_JSON: '[]',
      PROVIDER_CATALOG_SYNC_ON_START: 'false',
      PROVIDER_MODELS_REFRESH_ON_START: 'false',
      ALLOW_PLAINTEXT_HTTP: 'true',
      PROVIDER_ALLOW_PRIVATE_NETWORK: 'true',
      ZOMBIECODER_EXECUTION_MODE: 'chat-only'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8000); });

  const base = `http://127.0.0.1:${port}`;
  const health = await waitFor(async () => {
    if (child.exitCode !== null) return null;
    try {
      const response = await request(`${base}/health`, { timeoutMs: 800 });
      return response.status === 200 && response.json?.ok === true ? response.json : null;
    } catch { return null; }
  }, { attempts: 200, label: 'runtime_boot' }).catch(() => null);
  if (!health) throw new Error(`runtime_boot_failed exit=${child.exitCode} logs=${logs.slice(-500)}`);
  return { child, dir, base, adminToken, health };
}

async function startAdminUi() {
  const forced = Number(process.env.ZC_ADMIN_CHECK_UI_PORT || 0);
  const port = forced > 0 ? forced : await freePort();
  const child = spawn(process.execPath, ['admin-ui/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ADMIN_UI_PORT: String(port), ADMIN_UI_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  const page = await waitFor(async () => {
    if (child.exitCode !== null) return null;
    try {
      const response = await request(`http://127.0.0.1:${port}/`, { timeoutMs: 800 });
      return response.status === 200 ? response : null;
    } catch { return null; }
  }, { attempts: 100, label: 'admin_ui_boot' }).catch(() => null);
  if (!page) throw new Error(`admin_ui_boot_failed exit=${child.exitCode} logs=${logs.slice(-300)}`);
  return { child, page, port };
}

async function cleanupChildren(stub, runtime) {
  for (const child of [...children].reverse()) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await delay(300);
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  stub?.server.close();
  if (runtime?.dir) await rm(runtime.dir, { recursive: true, force: true }).catch(() => {});
}

async function main() {
  step('build');
  const build = await assertFreshBuild();

  step('stub-upstream');
  const stub = await startStub();
  summary.stubPort = stub.port;

  let runtime = null;
  try {
    step('boot');
    runtime = await bootRuntime();
    const { base, adminToken } = runtime;
    summary.runtime = { version: runtime.health.version, pid: runtime.child.pid };

    step('provider-add');
    const providerId = 'admin-check';
    const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
    const added = await request(`${base}/v1/admin/providers`, {
      method: 'POST', token: adminToken,
      body: {
        id: providerId, name: 'Admin Check', driver: 'openai-compatible', protocol: 'openai-compatible',
        baseUrl, defaultModel: 'stub-model', models: ['stub-model'], enabled: true, priority: 7,
        capabilities: ['chat-completions', 'streaming', 'model-catalog']
      }
    });
    if (added.status !== 201 || added.json?.provider?.id !== providerId) throw new Error(`provider_add_failed:${added.status}:${added.text.slice(0, 200)}`);

    step('provider-edit');
    const edited = await request(`${base}/v1/admin/providers/${providerId}`, { method: 'PATCH', token: adminToken, body: { name: 'Admin Check Edited' } });
    if (edited.status !== 200 || edited.json?.provider?.name !== 'Admin Check Edited') throw new Error(`provider_edit_failed:${edited.status}:${edited.text.slice(0, 200)}`);
    const listed = await request(`${base}/v1/admin/providers`, { token: adminToken });
    if (!listed.json?.providers?.some(provider => provider.id === providerId && provider.name === 'Admin Check Edited')) throw new Error('provider_edit_not_persisted');

    step('provider-test');
    const tested = await request(`${base}/v1/admin/providers/${providerId}/test`, { method: 'POST', token: adminToken, body: { prompt: 'ping_stub' } });
    if (tested.status !== 200 || tested.json?.ok !== true || tested.json?.model !== 'stub-model' || !tested.json?.runId) {
      throw new Error(`provider_test_failed:${tested.status}:${tested.text.slice(0, 300)}`);
    }
    const runs = await request(`${base}/v1/admin/model-tests?provider=${providerId}&model=stub-model&limit=10`, { token: adminToken });
    if (!runs.json?.runs?.some(run => run.id === tested.json.runId && run.ok === true)) throw new Error('provider_test_not_recorded');

    step('application');
    const app = await request(`${base}/v1/admin/applications`, { method: 'POST', token: adminToken, body: { name: 'admin-requests-check' } });
    if (app.status !== 201 || !app.json?.apiKey) throw new Error(`application_create_failed:${app.status}:${app.text.slice(0, 200)}`);
    const apiKey = app.json.apiKey;

    step('chat-recorded');
    const chat = await request(`${base}/v1/chat/completions`, {
      method: 'POST', token: apiKey,
      body: { provider: providerId, messages: [{ role: 'user', content: 'ping' }], stream: false }
    });
    if (chat.status !== 200) throw new Error(`chat_failed:${chat.status}:${chat.text.slice(0, 300)}`);
    const chatRequestId = chat.headers.get('x-request-id');
    if (!chatRequestId) throw new Error('chat_missing_request_id');

    const firstRow = await waitFor(async () => {
      const list = await request(`${base}/v1/admin/requests?limit=50`, { token: adminToken });
      return list.json?.requests?.find(row => row.requestId === chatRequestId) ?? null;
    }, { label: 'request_row' });
    if (firstRow.status !== 200 || firstRow.ok !== true) throw new Error(`request_row_invalid:${JSON.stringify(firstRow).slice(0, 300)}`);
    if (firstRow.providerId !== providerId || firstRow.model !== 'stub-model') throw new Error(`request_route_not_recorded:${firstRow.providerId}/${firstRow.model}`);
    if (firstRow.stream !== false) throw new Error('request_stream_flag_wrong');
    if (typeof firstRow.latencyMs !== 'number' || firstRow.latencyMs < 0) throw new Error('request_latency_missing');
    summary.recorded = { requestId: chatRequestId, status: firstRow.status, providerId: firstRow.providerId, model: firstRow.model };

    step('recording-off');
    const off = await request(`${base}/v1/admin/requests/settings`, { method: 'PATCH', token: adminToken, body: { recording: false } });
    if (off.status !== 200 || off.json?.settings?.recording !== false) throw new Error(`recording_off_failed:${off.status}:${off.text.slice(0, 200)}`);
    const chatWhileOff = await request(`${base}/v1/chat/completions`, {
      method: 'POST', token: apiKey,
      body: { provider: providerId, messages: [{ role: 'user', content: 'ping while off' }], stream: false }
    });
    if (chatWhileOff.status !== 200) throw new Error(`chat_while_off_failed:${chatWhileOff.status}`);
    const offlineId = chatWhileOff.headers.get('x-request-id');
    await delay(250);
    const afterOff = await request(`${base}/v1/admin/requests?limit=50`, { token: adminToken });
    if (afterOff.json?.requests?.some(row => row.requestId === offlineId)) throw new Error('recording_off_still_stored_row');
    if (!afterOff.json?.requests?.some(row => row.requestId === chatRequestId)) throw new Error('recording_off_hid_old_rows');
    if (afterOff.json?.settings?.recording !== false) throw new Error('recording_off_not_reported');
    const settingsWhileOff = await request(`${base}/v1/admin/requests/settings`, { token: adminToken });
    if (settingsWhileOff.status !== 200 || settingsWhileOff.json?.settings?.recording !== false) throw new Error('settings_get_failed_while_off');
    summary.disabled = { storedNewRow: false, oldRowsReadable: true };

    step('recording-on');
    const on = await request(`${base}/v1/admin/requests/settings`, { method: 'PATCH', token: adminToken, body: { recording: true } });
    if (on.status !== 200 || on.json?.settings?.recording !== true) throw new Error(`recording_on_failed:${on.status}`);
    const chatAgain = await request(`${base}/v1/chat/completions`, {
      method: 'POST', token: apiKey,
      body: { provider: providerId, messages: [{ role: 'user', content: 'ping again' }], stream: false }
    });
    if (chatAgain.status !== 200) throw new Error(`chat_after_enable_failed:${chatAgain.status}`);
    const enabledId = chatAgain.headers.get('x-request-id');
    await waitFor(async () => {
      const list = await request(`${base}/v1/admin/requests?limit=50`, { token: adminToken });
      return list.json?.requests?.some(row => row.requestId === enabledId);
    }, { label: 'request_row_after_enable' });
    summary.reEnabled = true;

    step('matrix');
    const matrix = await request(`${base}/v1/admin/provider-matrix`, { token: adminToken });
    if (matrix.status !== 200) throw new Error(`matrix_failed:${matrix.status}:${matrix.text.slice(0, 200)}`);
    const matrixProvider = matrix.json?.providers?.find(provider => provider.id === providerId);
    if (!matrixProvider) throw new Error('matrix_provider_missing');
    if (!matrix.json?.models?.includes('stub-model')) throw new Error('matrix_model_missing');
    const cell = matrix.json?.cells?.find(item => item.providerId === providerId && item.model === 'stub-model');
    if (!cell || cell.present !== true || cell.enabled !== true) throw new Error(`matrix_cell_invalid:${JSON.stringify(cell)}`);
    if (!cell.lastTest || cell.lastTest.ok !== true) throw new Error('matrix_last_test_missing');
    summary.matrix = { providers: matrix.json.providers.length, models: matrix.json.models.length, cells: matrix.json.cells.length };

    step('admin-ui');
    const ui = await startAdminUi();
    const html = ui.page.text;
    for (const marker of ['data-view="requests"', 'data-view="matrix"', 'id="view-requests"', 'id="view-matrix"', 'id="recordingToggle"', 'id="matrixTable"']) {
      if (!html.includes(marker)) throw new Error(`admin_ui_missing:${marker}`);
    }
    if (/<script[^>]+src="https?:/i.test(html)) throw new Error('admin_ui_external_script');
    summary.ui = { port: ui.port, bytes: Buffer.byteLength(html), externalScripts: 0 };

    step('done');
    // Operator hook: keep this isolated runtime and its admin UI alive so a human
    // (or the in-app browser) can click through the same page the gate fetched.
    if (KEEP) {
      console.log(`KEEP_READY ${JSON.stringify({ base, adminToken, uiPort: ui.port, runtimePid: runtime.child.pid, uiPid: ui.child.pid })}`);
      const shutdown = async () => { await cleanupChildren(stub, runtime); process.exit(0); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      await new Promise(() => {});
    }
    console.log(EXPECTED);
    console.log(JSON.stringify({ build, ...summary }, null, 2));
  } finally {
    if (!KEEP) await cleanupChildren(stub, runtime);
  }
}

main().catch(error => {
  fail(String(error?.message ?? 'admin_check_failed'));
});
