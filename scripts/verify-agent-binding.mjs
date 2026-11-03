// Proves the public agent-model binding end to end against the real local
// Ollama, without touching the live runtime's database or logs.
//
// It boots a disposable runtime with the binding from .env, creates a one-off
// application key over the loopback admin bypass, lists /v1/models, then sends
// one non-streaming and one streaming chat request. The public body and headers
// must carry only `zombiecoder/code-guru`; the temp JSONL must show the real
// `ollama-selfhosted` + `qwen2.5:1.5b` route.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_MODEL = 'zombiecoder/code-guru';
const AGENT_ID = 'code-guru';
const PROVIDER_ID = 'ollama-selfhosted';
const ALIAS = 'zombie-classic';
const UPSTREAM_MODEL = 'qwen2.5:1.5b';
const LEAK_MARKERS = ['qwen2.5', 'deepseek-r1', 'ollama-selfhosted', 'ollama-cloud', 'gpt-oss', 'gemini-'];

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertNoLeak(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const lower = text.toLowerCase();
  for (const marker of LEAK_MARKERS) {
    assert(!lower.includes(marker), `${label} leaked upstream marker: ${marker}`);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(120000)});
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {response, body, text};
}

const envText = await readFile(path.join(root, '.env'), 'utf8').catch(() => '');
function envValue(key) {
  for (const line of envText.split('\n')) {
    if (!line.startsWith(`${key}=`)) continue;
    return line.slice(key.length + 1);
  }
  return '';
}

const providerSeed = JSON.parse(envValue('PROVIDER_CONFIG_JSON') || '[]');
const bindingSeed = JSON.parse(envValue('AGENT_MODEL_BINDINGS') || '{}');
const provider = providerSeed.find(item => item.id === PROVIDER_ID);
assert(provider, `${PROVIDER_ID} is missing from PROVIDER_CONFIG_JSON`);
assert(provider.enabled !== false, `${PROVIDER_ID} is disabled`);
assert(provider.modelAliases?.[ALIAS] === UPSTREAM_MODEL, `${PROVIDER_ID}.modelAliases.${ALIAS} must be ${UPSTREAM_MODEL}`);
assert(Array.isArray(provider.models) && provider.models.includes(UPSTREAM_MODEL), `${PROVIDER_ID}.models must include ${UPSTREAM_MODEL}`);
const binding = bindingSeed[PUBLIC_MODEL];
assert(binding, `AGENT_MODEL_BINDINGS is missing ${PUBLIC_MODEL}`);
assert(binding.agent === AGENT_ID, `${PUBLIC_MODEL} must bind agent ${AGENT_ID}`);
assert(binding.provider === PROVIDER_ID, `${PUBLIC_MODEL} must bind provider ${PROVIDER_ID}`);
assert(binding.model === ALIAS, `${PUBLIC_MODEL} must bind model alias ${ALIAS}`);

const ollamaBase = String(provider.baseUrl || '').replace(/\/v1\/?$/, '');
assert(/^https?:\/\//.test(ollamaBase), 'ollama baseUrl is invalid');
const tags = await fetchJson(`${ollamaBase}/api/tags`).catch(error => fail(`ollama_unavailable: ${error.message}`));
assert(tags.response.ok, `ollama_unavailable: HTTP ${tags.response.status}`);
assert(Array.isArray(tags.body?.models) && tags.body.models.some(model => model.name === UPSTREAM_MODEL), `ollama does not have ${UPSTREAM_MODEL}`);

const port = await freePort();
const dir = await mkdtemp(path.join(tmpdir(), 'zc-agent-binding-'));
const env = {
  ...process.env,
  ENV_LOADER_ENABLED: 'false',
  HOST: '127.0.0.1',
  PORT: String(port),
  ADMIN_TOKEN: '',
  LOOPBACK_AUTH_BYPASS: 'true',
  ALLOW_PLAINTEXT_HTTP: 'true',
  PROVIDER_ALLOW_PRIVATE_NETWORK: 'true',
  PROVIDER_ALLOW_PRIVATE_HOSTS: '127.0.0.1,localhost',
  PROVIDER_CONFIG_JSON: JSON.stringify([provider]),
  AGENT_MODEL_BINDINGS: JSON.stringify({[PUBLIC_MODEL]: binding}),
  DATA_DIR: path.join(dir, 'data'),
  SQLITE_PATH: path.join(dir, 'data', 'runtime.sqlite'),
  LOG_DIR: path.join(dir, 'logs'),
  LOG_FILE: 'runtime.jsonl',
  LOG_TO_STDOUT: 'true',
  LOG_PRETTY: 'true',
  UDS_ENABLED: 'false',
  PROVIDER_CATALOG_SYNC_ON_START: 'false',
  PROVIDER_MODELS_REFRESH_ON_START: 'false',
  EXTERNAL_MCP_DISCOVER_ON_START: 'false',
  EXTERNAL_MCP_REFRESH_TOOLS_ON_START: 'false',
  PROJECT_ROOTS: '',
  ZOMBIECODER_EXECUTION_MODE: 'chat-only',
  MEMORY_LOG_INTERVAL_MS: '0',
  PROVIDER_TIMEOUT_MS: '120000'
};

const child = spawn(process.execPath, ['src/server.js'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

async function stop() {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) fail(`runtime_exited code=${child.exitCode} stderr=${stderr.slice(0, 600)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1000)});
      if (response.ok) { healthy = true; break; }
    } catch { /* not listening yet */ }
    await delay(100);
  }
  if (!healthy) fail(`runtime_not_healthy stderr=${stderr.slice(0, 600)}`);

  const app = await fetchJson(`http://127.0.0.1:${port}/v1/admin/applications`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({name: 'agent-binding-verify'})
  });
  assert(app.response.ok && app.body?.apiKey, `application_create_failed HTTP ${app.response.status}: ${app.text.slice(0, 300)}`);
  const apiKey = app.body.apiKey;
  const auth = {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'};

  const models = await fetchJson(`http://127.0.0.1:${port}/v1/models`);
  assert(models.response.ok, `models_failed HTTP ${models.response.status}`);
  assert(Array.isArray(models.body?.data) && models.body.data.some(model => model.id === PUBLIC_MODEL), `models list is missing ${PUBLIC_MODEL}`);
  assertNoLeak('models list', models.body);

  const prompt = 'Reply with exactly: OK';
  const plain = await fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({model: PUBLIC_MODEL, messages: [{role: 'user', content: prompt}], max_tokens: 16, temperature: 0, stream: false})
  });
  assert(plain.response.status === 200, `plain_chat_failed HTTP ${plain.response.status}: ${plain.text.slice(0, 400)}`);
  assert(plain.body?.model === PUBLIC_MODEL, `plain response model is ${plain.body?.model}, expected ${PUBLIC_MODEL}`);
  assert(plain.body?.provider === 'ZombieCoder', `plain response provider is ${plain.body?.provider}`);
  assert(plain.response.headers.get('x-zombie-provider') === 'ZombieCoder', 'missing x-zombie-provider header');
  assert(plain.response.headers.get('x-zombie-model') === PUBLIC_MODEL, 'missing x-zombie-model header');
  assert(plain.response.headers.get('x-zombie-agent') === AGENT_ID, 'missing x-zombie-agent header');
  assertNoLeak('plain response', plain.body);

  const streamResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({model: PUBLIC_MODEL, messages: [{role: 'user', content: prompt}], max_tokens: 16, temperature: 0, stream: true}),
    signal: AbortSignal.timeout(120000)
  });
  assert(streamResponse.status === 200, `stream_chat_failed HTTP ${streamResponse.status}`);
  assert(streamResponse.headers.get('x-zombie-model') === PUBLIC_MODEL, 'missing stream x-zombie-model header');
  const streamText = await streamResponse.text();
  const chunks = streamText.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6).trim())
    .filter(data => data && data !== '[DONE]')
    .map(data => JSON.parse(data));
  assert(chunks.length > 0, 'stream produced no JSON chunks');
  for (const chunk of chunks) {
    assert(chunk.model === PUBLIC_MODEL, `stream chunk model is ${chunk.model}`);
    assert(chunk.provider === 'ZombieCoder', `stream chunk provider is ${chunk.provider}`);
    assertNoLeak('stream chunk', chunk);
  }

  const rawLog = await readFile(path.join(dir, 'logs', 'runtime.jsonl'), 'utf8');
  const rows = [];
  for (const line of rawLog.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { fail(`jsonl_parse_failed: ${line.slice(0, 200)}`); }
  }
  const bindingRow = rows.find(row => row.event === 'runtime.agent_model_binding' && row.publicModel === PUBLIC_MODEL);
  assert(bindingRow, 'runtime.agent_model_binding is missing from JSONL');
  assert(bindingRow.providerId === PROVIDER_ID, `binding log provider is ${bindingRow.providerId}`);
  assert(bindingRow.model === ALIAS, `binding log alias is ${bindingRow.model}`);
  const routeRows = rows.filter(row => row.event === 'router.route.selected');
  assert(routeRows.length >= 2, `expected two routed requests, got ${routeRows.length}`);
  for (const row of routeRows) {
    assert(row.providerId === PROVIDER_ID, `route log provider is ${row.providerId}`);
    assert(row.model === UPSTREAM_MODEL, `route log model is ${row.model}`);
  }

  console.log(`AGENT_BINDING_OK publicModel=${PUBLIC_MODEL} provider=${PROVIDER_ID} model=${UPSTREAM_MODEL} masked=ok stream=ok leak=0`);
} catch (error) {
  console.error(`AGENT_BINDING_FAIL ${error.message}`);
  if (stderr.trim()) console.error(`runtime_stderr=${stderr.slice(-1200)}`);
  process.exitCode = 1;
} finally {
  await stop();
  await rm(dir, {recursive: true, force: true});
}
