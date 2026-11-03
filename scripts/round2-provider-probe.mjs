#!/usr/bin/env node
// Round-2 provider probe. Runs only against real provider APIs and a real
// isolated runtime: no fixture stands in for a provider, and a missing key
// fails the probe instead of being reported as a pass.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROVIDERS = Object.freeze([
  { id: 'ollama-cloud-openai', driver: 'ollama', mode: 'openai-compatible', protocol: 'openai-compatible', baseUrl: 'https://ollama.com/v1', model: 'gpt-oss:20b', keyEnv: 'PROVIDER_KEY_OLLAMA_CLOUD_OPENAI', priority: 1 },
  { id: 'ollama-cloud-native', driver: 'ollama', mode: 'native', protocol: 'ollama-native', baseUrl: 'https://ollama.com', model: 'gpt-oss:20b', keyEnv: 'PROVIDER_KEY_OLLAMA_CLOUD_NATIVE', priority: 2 },
  { id: 'gemini', driver: 'gemini', protocol: 'gemini-generate-content', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', keyEnv: 'PROVIDER_KEY_GEMINI', priority: 3 },
  // Groq's free tier allows 8k tokens per minute. The tool-loop test sends a
  // large system prompt plus tool definitions several times, so give the bucket
  // one full window to refill instead of reading the 429 as a runtime defect.
  { id: 'groq', driver: 'groq', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b', keyEnv: 'PROVIDER_KEY_GROQ', priority: 4, pauseBeforeToolLoopMs: 65000 }
]);

const ACTIVE_PROVIDERS = PROVIDERS.filter(provider => !process.env.ZC_PROBE_PROVIDERS || process.env.ZC_PROBE_PROVIDERS.split(',').map(item => item.trim()).includes(provider.id));

function readDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!/^[A-Z0-9_]+=/.test(line)) continue;
    const at = line.indexOf('=');
    out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 120000 } = {}) {
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, headers: response.headers, text, json };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runtimeErrors(logDir) {
  const out = [];
  let files = [];
  try { files = await readdir(logDir); } catch { return out; }
  for (const name of files) {
    if (!/\.(log|jsonl)$/.test(name)) continue;
    const text = await readFile(path.join(logDir, name), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const event = String(row.event ?? row.msg ?? '');
        if (row.level === 'error' || /fail|error/i.test(event)) out.push({
          event,
          providerId: row.providerId ?? null,
          model: row.model ?? null,
          error: row.error ? String(row.error).slice(0, 200) : null,
          statusCode: row.statusCode ?? null,
          upstreamReason: row.upstreamReason ? String(row.upstreamReason).slice(0, 300) : null
        });
      } catch {}
    }
  }
  return out.slice(-12);
}

async function startRuntime() {
  const dotenv = readDotEnv();
  const missing = ACTIVE_PROVIDERS.filter(provider => !dotenv[provider.keyEnv]);
  if (missing.length) throw new Error(`missing_provider_keys:${missing.map(item => item.id).join(',')}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-round2-probe-'));
  const dataDir = path.join(dir, 'data');
  const logDir = path.join(dir, 'logs');
  // A project root with no SSOT/syllabus keeps the system prompt small. Without
  // this the isolated runtime loaded the real repository SSOT (37 KB) into every
  // request, which on Groq's 8k-token/minute free tier exhausted the budget before
  // the second tool-loop round and looked like a runtime failure.
  const workspace = path.join(dataDir, 'workspace');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(logDir, { recursive: true });
  const port = await freePort();
  const adminToken = `round2-${randomUUID()}`;
  const providerConfig = ACTIVE_PROVIDERS.map(provider => ({
    id: provider.id,
    name: provider.id,
    driver: provider.driver,
    ...(provider.mode ? { mode: provider.mode } : {}),
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.model,
    models: [provider.model],
    enabled: true,
    capabilities: ['chat-completions', 'streaming', 'function-calling', 'model-catalog'],
    priority: provider.priority
  }));
  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false',
    HOST: '127.0.0.1',
    PORT: String(port),
    ADMIN_TOKEN: adminToken,
    LOCAL_AUTH_BYPASS: 'false',
    DATA_DIR: dataDir,
    SQLITE_PATH: path.join(dataDir, 'runtime.sqlite'),
    LOG_DIR: logDir,
    LOG_TO_STDOUT: 'false',
    UDS_ENABLED: 'false',
    // Gemini 3.x reasoning models can spend longer than the 30s default before
    // the first streamed byte; this is latency, not a missing response.
    PROVIDER_TIMEOUT_MS: '180000',
    PROVIDER_CATALOG_SYNC_ON_START: 'false',
    PROVIDER_MODELS_REFRESH_ON_START: 'false',
    PROVIDER_CONFIG_JSON: JSON.stringify(providerConfig),
    ZOMBIECODER_EXECUTION_MODE: 'tools-enabled',
    TOOL_ACCESS_MODE: 'unrestricted',
    MCP_SERVER_ENABLED: 'true',
    MCP_SERVER_AUTH: 'required',
    MCP_SERVER_PROJECT_ROOT: dataDir,
    EXTERNAL_MCP_URLS: '',
    PROJECT_ROOTS: '',
    CORS_ALLOW_ORIGINS: 'http://127.0.0.1:8088'
  };
  for (const provider of ACTIVE_PROVIDERS) env[provider.keyEnv] = dotenv[provider.keyEnv];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = chunk => { output = (output + chunk).slice(-20000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(`runtime_exited:${child.exitCode}:${output.slice(-800)}`);
    try {
      const health = await request(`${base}/health`, { timeoutMs: 2000 });
      if (health.status === 200) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error(`runtime_not_ready:${output.slice(-800)}`);
  return { child, dir, dataDir, logDir, workspace, base, adminToken, port, output: () => output };
}

async function createApplication(base, adminToken) {
  const created = await request(`${base}/v1/admin/applications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'round2-provider-probe' }),
    timeoutMs: 15000
  });
  assert(created.status === 201, `application_create_failed:${created.status}:${created.text.slice(0, 200)}`);
  assert(created.json?.apiKey, 'application_create_missing_key');
  return created.json;
}

function parseSse(text) {
  const chunks = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try { chunks.push(JSON.parse(payload)); } catch {}
  }
  return chunks;
}

async function chat(base, apiKey, body, timeoutMs = 120000) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  const transient = new Set([429, 502, 503, 504]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await request(`${base}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), timeoutMs
    });
    if (!transient.has(result.status) || attempt === 2) return result;
    const retryMs = Number(result.json?.error?.retryAfterMs ?? result.json?.retryAfterMs ?? 5000 * (attempt + 1));
    // A per-minute token bucket refills gradually; retry-after alone can name a
    // shorter window than the next full request needs. A provider that declares
    // 8k TPM gets one full minute.
    const waitMs = body.provider === 'groq' && result.status === 429 ? Math.max(retryMs, 65000) : retryMs;
    await delay(Math.min(90000, Math.max(1000, waitMs)));
  }
  throw new Error('chat_retry_exhausted');
}

const ECHO_TOOL = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echo a value back',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
  }
};

async function checkProvider(base, apiKey, provider, workspace) {
  const entry = { id: provider.id, model: provider.model, checks: {}, status: 'PASS' };
  const fail = (phase, message) => { throw new Error(`${phase}:${message}`); };

  const tool = await chat(base, apiKey, {
    provider: provider.id,
    model: provider.model,
    agent: 'code-guru',
    projectRoot: workspace,
    messages: [{ role: 'user', content: 'Call the echo tool with value 7. Do not answer with prose.' }],
    tools: [ECHO_TOOL],
    tool_choice: 'auto',
    // Reasoning providers (Groq gpt-oss, Gemini 2.5 thinking) spend this budget
    // before emitting the tool call, so a 128-token budget tests the truncator
    // instead of the tool surface.
    max_tokens: 512,
    temperature: 0
  });
  if (tool.status !== 200) fail('tool', `http_${tool.status}:${tool.text.slice(0, 240)}`);
  const choice = tool.json?.choices?.[0] ?? {};
  const calls = choice.message?.tool_calls ?? [];
  if (!calls.some(call => call?.function?.name === 'echo')) fail('tool', `missing_echo_call:${tool.text.slice(0, 240)}`);
  if (choice.finish_reason !== 'tool_calls') fail('tool', `finish_reason=${choice.finish_reason}`);
  if (tool.json?.model !== 'zombiecoder/code-guru') fail('tool', `model_not_masked:${tool.json?.model}`);
  if (tool.text.includes(provider.model)) fail('tool', 'upstream_model_leaked');
  entry.checks.tool = { pass: true, finishReason: choice.finish_reason, model: tool.json.model };

  const stream = await request(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      provider: provider.id,
      model: 'zombie-mini',
      agent: 'code-guru',
      projectRoot: workspace,
      messages: [{ role: 'user', content: 'Say ZC_STREAM_OK and nothing else.' }],
      stream: true,
      max_tokens: 256,
      temperature: 0
    }),
    timeoutMs: 180000
  });
  if (stream.status !== 200) fail('stream', `http_${stream.status}:${stream.text.slice(0, 240)}`);
  const chunks = parseSse(stream.text);
  const streamText = chunks.map(chunk => chunk?.choices?.[0]?.delta?.content ?? '').join('');
  if (!streamText.includes('ZC_STREAM_OK')) fail('stream', `text=${streamText.slice(0, 120)};raw=${stream.text.slice(-400)}`);
  const models = [...new Set(chunks.map(chunk => chunk.model).filter(Boolean))];
  if (models.length !== 1 || models[0] !== 'zombie-mini') fail('stream', `models=${models.join(',')}`);
  if (stream.text.includes(provider.model)) fail('stream', 'upstream_model_leaked');
  entry.checks.stream = { pass: true, chunks: chunks.length, model: models[0] };

  if (provider.pauseBeforeToolLoopMs) await delay(provider.pauseBeforeToolLoopMs);
  const loop = await chat(base, apiKey, {
    provider: provider.id,
    model: provider.model,
    agent: 'code-guru',
    projectRoot: workspace,
    messages: [{ role: 'user', content: 'Call the runtime_echo tool with value 7, then report the value.' }],
    autoToolLoop: true,
    consent: true,
    toolIds: ['runtime_echo'],
    max_tokens: 512,
    temperature: 0
  }, 180000);
  if (loop.status !== 200) fail('tool_loop', `http_${loop.status}:${loop.text.slice(0, 240)}`);
  const loopMeta = loop.json?.meta?.toolLoop ?? {};
  const rounds = Array.isArray(loopMeta.rounds) ? loopMeta.rounds : [];
  const used = rounds.some(round => (round?.toolCalls ?? []).some(call => call?.name === 'runtime_echo'));
  if (loopMeta.status !== 'completed' || !used) fail('tool_loop', `status=${loopMeta.status}:used=${used}:${loop.text.slice(0, 240)}`);
  if (loop.text.includes(provider.model)) fail('tool_loop', 'upstream_model_leaked');
  entry.checks.toolLoop = { pass: true, rounds: rounds.length, evidenceCount: loopMeta.evidenceCount ?? 0 };
  return entry;
}

async function checkMcp(base, apiKey) {
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, accept: 'application/json, text/event-stream' };
  const post = (body, headers = {}) => request(`${base}/mcp`, {
    method: 'POST', headers: { ...auth, ...headers }, body: JSON.stringify(body), timeoutMs: 30000
  });
  const init = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'round2-probe', version: '1' } }
  });
  assert(init.status === 200, `mcp_initialize_http_${init.status}`);
  assert(init.json?.result?.protocolVersion === '2024-11-05', 'mcp_body_version_mismatch');
  assert(init.headers.get('mcp-protocol-version') === '2024-11-05', 'mcp_header_version_mismatch');
  const session = init.headers.get('mcp-session-id');
  assert(session, 'mcp_session_missing');
  const headers = { 'mcp-session-id': session, 'mcp-protocol-version': '2024-11-05' };

  const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers);
  assert(listed.status === 200, `mcp_tools_list_http_${listed.status}`);
  const names = (listed.json?.result?.tools ?? []).map(tool => tool.name);
  assert(names.includes('runtime_echo'), 'mcp_runtime_echo_not_advertised');

  const called = await post({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'runtime_echo', arguments: { value: 'MCP_OK' } }
  }, headers);
  assert(called.status === 200 && called.json?.result?.isError === false, `mcp_tool_call_failed:${called.text.slice(0, 200)}`);
  assert(called.text.includes('MCP_OK'), 'mcp_tool_result_missing');

  const noSession = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert(noSession.status === 400 && noSession.json?.error?.message === 'mcp_session_id_required', `mcp_no_session:${noSession.status}`);

  const noVersion = await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, { 'mcp-session-id': session });
  assert(noVersion.status === 400 && noVersion.json?.error?.message === 'mcp_protocol_version_required', `mcp_no_version:${noVersion.status}`);

  const badVersion = await post({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { 'mcp-session-id': session, 'mcp-protocol-version': '1999-01-01' });
  assert(badVersion.status === 400 && badVersion.json?.error?.message === 'mcp_protocol_version_unsupported', `mcp_bad_version:${badVersion.status}`);

  const mismatch = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' });
  assert(mismatch.status === 400 && mismatch.json?.error?.message === 'mcp_protocol_version_mismatch', `mcp_mismatch:${mismatch.status}`);

  const unknown = await post({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { 'mcp-session-id': 'mcp-does-not-exist', 'mcp-protocol-version': '2024-11-05' });
  assert(unknown.status === 404, `mcp_unknown_session:${unknown.status}`);

  const badOrigin = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { ...headers, origin: 'https://attacker.example' });
  assert(badOrigin.status === 403 && badOrigin.json?.error?.message === 'origin_not_allowed', `mcp_bad_origin:${badOrigin.status}`);

  const deleted = await request(`${base}/mcp`, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': session }, timeoutMs: 15000 });
  assert(deleted.status === 204, `mcp_delete:${deleted.status}`);

  return { status: 'PASS', session, tools: names.length, version: '2024-11-05' };
}

export async function runProviderProbe({ onProgress = null } = {}) {
  const runtime = await startRuntime();
  const errors = [];
  try {
    const app = await createApplication(runtime.base, runtime.adminToken);
    const providers = [];
    for (const provider of ACTIVE_PROVIDERS) {
      onProgress?.(`provider:${provider.id}`);
      try {
        providers.push(await checkProvider(runtime.base, app.apiKey, provider, runtime.workspace));
      } catch (error) {
        errors.push(`${provider.id}:${error.message}`);
        providers.push({ id: provider.id, model: provider.model, status: 'FAIL', error: error.message, checks: {} });
      }
    }
    let mcp;
    try {
      mcp = await checkMcp(runtime.base, app.apiKey);
    } catch (error) {
      errors.push(`mcp:${error.message}`);
      mcp = { status: 'FAIL', error: error.message };
    }
    return {
      ok: errors.length === 0,
      providers,
      mcp,
      errors,
      runtimeErrors: await runtimeErrors(runtime.logDir),
      runtime: { port: runtime.port, isolated: true }
    };
  } finally {
    runtime.child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => runtime.child.once('exit', resolve)), delay(3000)]);
    if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL');
    if (process.env.ZC_PROBE_KEEP === '1') console.error(`[probe] kept ${runtime.dir}`);
    else await rm(runtime.dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProviderProbe({ onProgress: message => console.error(`[probe] ${message}`) })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch(error => {
      console.error(`PROBE_FAIL ${error.message}`);
      process.exitCode = 1;
    });
}
