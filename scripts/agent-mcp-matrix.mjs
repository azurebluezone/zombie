#!/usr/bin/env node
'use strict';

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.MATRIX_BASE_URL || 'http://127.0.0.1:9999';
const ARTIFACT = path.join(ROOT, 'data', 'agent-mcp-matrix.json');
const APP_KEY_FILE = '/tmp/opencode/matrix-app-key';
const AGENT_ROOT = path.join(ROOT, 'data', 'matrix-scratch');
const SCRATCH = path.join(AGENT_ROOT, 'tools');
const UDS_PATH = path.join(ROOT, 'data', 'runtime-llama.sock');
const VERIFY_ONLY = process.argv.includes('--verify');
const LLAMA_UPSTREAM = 'http://127.0.0.1:9933/v1';

function readEnv(name) {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(item => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : '';
}

async function reachable(url, ms = 2500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return response.ok;
  } catch { return false; }
}

// The matrix used to be pinned to llama.cpp. When that engine is down the run
// should fall back to Ollama instead of reporting a false upstream failure, so
// the provider and its upstream are resolved together. An explicit
// MATRIX_UPSTREAM_URL keeps the old llama.cpp behaviour.
const EXPLICIT_UPSTREAM = process.env.MATRIX_UPSTREAM_URL || '';
const OLLAMA_UPSTREAM = (readEnv('OLLAMA_BASE_URL') || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const PROVIDER = process.env.MATRIX_PROVIDER_ID
  || (EXPLICIT_UPSTREAM ? 'llama-cpu' : (await reachable(`${LLAMA_UPSTREAM}/models`) ? 'llama-cpu' : 'ollama-selfhosted'));
const UPSTREAM = EXPLICIT_UPSTREAM || (PROVIDER === 'llama-cpu' ? LLAMA_UPSTREAM : OLLAMA_UPSTREAM);
const MODEL = process.env.MATRIX_MODEL
  || (PROVIDER === 'llama-cpu' ? 'qwen2.5-0.5b' : (readEnv('OLLAMA_MODEL') || 'qwen2.5:1.5b'));
const UDS_ENABLED = process.env.MATRIX_UDS
  ? process.env.MATRIX_UDS !== '0'
  : PROVIDER === 'llama-cpu';

const adminToken = readEnv('ADMIN_TOKEN');
if (!adminToken) {
  console.error('MATRIX_FAIL ADMIN_TOKEN missing from .env');
  process.exit(2);
}
const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function snippet(value, max = 600) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function jsonFetch(url, options = {}, timeoutMs = 20000) {
  const started = Date.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, headers: response.headers, body, text, latencyMs: Date.now() - started };
}

async function retryOnce(fn, label) {
  try { return await fn(); } catch (error) {
    if (String(error?.name) === 'TimeoutError') throw error;
    const first = error;
    try { return await fn(); } catch (second) {
      const wrapped = new Error(`${label}: ${first?.message ?? first}; retry: ${second?.message ?? second}`);
      wrapped.cause = second;
      throw wrapped;
    }
  }
}

async function ensureAppKey() {
  if (existsSync(APP_KEY_FILE)) {
    const key = readFileSync(APP_KEY_FILE, 'utf8').trim();
    if (key) return key;
  }
  const created = await jsonFetch(`${BASE}/v1/admin/applications`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'agent-mcp-matrix', role: 'user' })
  });
  const key = created.body?.apiKey;
  if (created.status !== 201 || !key) throw new Error(`application_create_failed_${created.status}`);
  writeFileSync(APP_KEY_FILE, `${key}\n`, { mode: 0o600 });
  chmodSync(APP_KEY_FILE, 0o600);
  return key;
}

async function udsHealth() {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: UDS_PATH, path: '/health', method: 'GET', timeout: 5000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: response.statusCode, body: parsed, bytes: body.length, sha256: sha256(body) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('uds_health_timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function mcpClient() {
  let rpcId = 0;
  let sessionId = null;
  let protocolVersion = null;
  async function call(method, params = {}, timeoutMs = 30000) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    // MCP 2025-06-18 requires the negotiated revision on every request after
    // initialize. The server rejects a missing header with 400 instead of
    // guessing, so the harness must echo it.
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    const response = await jsonFetch(`${BASE}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    }, timeoutMs);
    const nextSession = response.headers.get('mcp-session-id');
    if (nextSession) sessionId = nextSession;
    if (method === 'initialize') protocolVersion = response.body?.result?.protocolVersion ?? protocolVersion;
    return { ...response, rpc: response.body, sessionId, protocolVersion };
  }
  return { call, get sessionId() { return sessionId; }, get protocolVersion() { return protocolVersion; } };
}

function toolResultText(rpc) {
  if (rpc?.error) return JSON.stringify(rpc.error);
  const result = rpc?.result;
  const text = Array.isArray(result?.content)
    ? result.content.map(item => item?.text ?? '').join('\n')
    : (result?.content ?? '');
  return String(text ?? '');
}

async function callTool(client, name, args, root) {
  const result = await client.call('tools/call', { name, arguments: args, _meta: { projectRoot: root } }, 60000);
  return {
    httpStatus: result.status,
    isError: result.rpc?.result?.isError === true || Boolean(result.rpc?.error),
    text: toolResultText(result.rpc),
    rpcError: result.rpc?.error ?? null
  };
}

function simpleSpec(id, root, args, check) {
  return {
    id,
    async run(client) {
      const result = await callTool(client, id, args, root);
      const verdict = check(result);
      return { called: true, status: verdict.status, text: snippet(result.text), httpStatus: result.httpStatus, isError: result.isError, note: verdict.note ?? null };
    }
  };
}

function readText(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function writeText(relative, value) {
  const target = path.join(ROOT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

async function trackedFileUndoTest(client, toolId, relative, runId) {
  const absolute = path.join(ROOT, relative);
  if (!existsSync(absolute)) return { called: false, status: 'NOT_TESTED', text: '', note: `${relative} missing` };
  const before = readFileSync(absolute, 'utf8');
  try {
    writeFileSync(absolute, `${before}\nMATRIX_${toolId.toUpperCase()}_${runId}\n`, 'utf8');
    const result = await callTool(client, toolId, { path: relative, confirm: true }, ROOT);
    const after = readFileSync(absolute, 'utf8');
    const restored = !after.includes(`MATRIX_${toolId.toUpperCase()}_${runId}`);
    const status = result.isError ? 'FAIL' : (restored ? 'PASS' : 'FAIL');
    return {
      called: true,
      status,
      text: snippet(result.text),
      httpStatus: result.httpStatus,
      isError: result.isError,
      note: restored ? `restored ${relative}` : `file still dirty; backup restored=${before.length} bytes`
    };
  } finally {
    if (readFileSync(absolute, 'utf8') !== before) writeFileSync(absolute, before, 'utf8');
  }
}

function buildToolSpecs(runId) {
  return [
    simpleSpec('runtime_echo', ROOT, { value: 'ZC_MATRIX_ECHO' }, result => ({
      status: !result.isError && result.text.includes('ZC_MATRIX_ECHO') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('read_file', ROOT, { path: 'data/matrix-scratch/README.md' }, result => ({
      status: !result.isError && result.text.includes('Matrix Scratch') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('write_file', ROOT, { path: 'data/matrix-scratch/tools/write.txt', content: 'MATRIX_WRITE', overwriteExisting: true }, result => {
      const exists = existsSync(path.join(ROOT, 'data/matrix-scratch/tools/write.txt'));
      return { status: !result.isError && exists ? 'PASS' : 'FAIL', note: exists ? 'file written' : 'file missing' };
    }),
    simpleSpec('list_directory', ROOT, { path: 'data/matrix-scratch' }, result => ({
      status: !result.isError && result.text.includes('README.md') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('create_file', ROOT, { path: 'data/matrix-scratch/tools/create.txt', content: 'MATRIX_CREATE' }, result => ({
      status: !result.isError && existsSync(path.join(ROOT, 'data/matrix-scratch/tools/create.txt')) ? 'PASS' : 'FAIL'
    })),
    simpleSpec('edit_file', ROOT, { path: 'data/matrix-scratch/tools/edit.txt', oldText: 'OLD_MATRIX', newText: 'NEW_MATRIX' }, result => {
      const file = path.join(ROOT, 'data/matrix-scratch/tools/edit.txt');
      return { status: !result.isError && existsSync(file) && readFileSync(file, 'utf8').includes('NEW_MATRIX') ? 'PASS' : 'FAIL' };
    }),
    simpleSpec('apply_diff', ROOT, { path: 'data/matrix-scratch/tools/diff.txt', oldText: 'DIFF_OLD', newText: 'DIFF_NEW' }, result => {
      const file = path.join(ROOT, 'data/matrix-scratch/tools/diff.txt');
      return { status: !result.isError && existsSync(file) && readFileSync(file, 'utf8').includes('DIFF_NEW') ? 'PASS' : 'FAIL' };
    }),
    simpleSpec('delete_file', ROOT, { path: 'data/matrix-scratch/tools/delete-me.txt', confirm: true }, result => ({
      status: !result.isError && !existsSync(path.join(ROOT, 'data/matrix-scratch/tools/delete-me.txt')) ? 'PASS' : 'FAIL'
    })),
    simpleSpec('list_dir', ROOT, { path: 'data/matrix-scratch' }, result => ({
      status: !result.isError && result.text.includes('README.md') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('read_directory', ROOT, { path: 'data/matrix-scratch' }, result => ({
      status: !result.isError && result.text.includes('src') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('grep_search', ROOT, { pattern: 'COMMON_TOOLS', path: 'src/tools', maxResults: 5 }, result => ({
      status: !result.isError && result.text.includes('common-defaults.js') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('regex_search', ROOT, { pattern: 'native\\(', path: 'src/tools/common-defaults.js', maxResults: 5 }, result => ({
      status: !result.isError && result.text.includes('common-defaults.js') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('file_search', ROOT, { query: 'common-defaults', path: 'src/tools' }, result => ({
      status: !result.isError && result.text.includes('common-defaults.js') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('find_files', ROOT, { query: 'README.md', path: 'data/matrix-scratch' }, result => ({
      status: !result.isError && result.text.includes('README.md') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('view_symbol', ROOT, { symbol: 'COMMON_TOOLS', path: 'src/tools/common-defaults.js' }, result => ({
      status: !result.isError && result.text.includes('COMMON_TOOLS') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('code_graph', ROOT, { symbol: 'execute', path: 'tools/common/workspace_tools.js' }, result => ({
      status: !result.isError && result.text.includes('workspace_tools.js') ? 'PASS' : 'FAIL'
    })),
    simpleSpec('run_terminal_command', SCRATCH, { argv: ['node', '--version'], cwd: '.' }, result => {
      const parsed = (() => { try { return JSON.parse(result.text); } catch { return null; } })();
      return { status: !result.isError && parsed?.exitCode === 0 && String(parsed?.stdout).startsWith('v') ? 'PASS' : 'FAIL' };
    }),
    simpleSpec('execute_bash', SCRATCH, { argv: ['node', '-e', 'console.log(2+2)'], cwd: '.' }, result => {
      const parsed = (() => { try { return JSON.parse(result.text); } catch { return null; } })();
      return { status: !result.isError && parsed?.exitCode === 0 && String(parsed?.stdout).trim() === '4' ? 'PASS' : 'FAIL' };
    }),
    {
      id: 'kill_process',
      async run(client) {
        const started = await callTool(client, 'run_terminal_command', { argv: ['node', '-e', 'setInterval(()=>{},1000)'], cwd: '.', background: true }, SCRATCH);
        let processId = null;
        try { processId = JSON.parse(started.text)?.processId ?? null; } catch {}
        if (!processId) return { called: true, status: 'FAIL', text: snippet(started.text), httpStatus: started.httpStatus, isError: started.isError, note: 'background process id missing' };
        const killed = await callTool(client, 'kill_process', { processId }, SCRATCH);
        return { called: true, status: !killed.isError && killed.text.includes(processId) ? 'PASS' : 'FAIL', text: snippet(killed.text), httpStatus: killed.httpStatus, isError: killed.isError, note: `managed ${processId}` };
      }
    },
    {
      id: 'undo',
      async run(client) { return await trackedFileUndoTest(client, 'undo', 'README.md', runId); }
    },
    {
      id: 'revert_file',
      async run(client) { return await trackedFileUndoTest(client, 'revert_file', 'CHANGELOG.md', runId); }
    },
    simpleSpec('git_diff', ROOT, {}, result => {
      const parsed = (() => { try { return JSON.parse(result.text); } catch { return null; } })();
      return { status: !result.isError && parsed?.exitCode === 0 ? 'PASS' : 'FAIL' };
    }),
    simpleSpec('git_status', ROOT, {}, result => {
      const parsed = (() => { try { return JSON.parse(result.text); } catch { return null; } })();
      return { status: !result.isError && parsed?.exitCode === 0 ? 'PASS' : 'FAIL' };
    }),
    simpleSpec('task_planner', ROOT, { goal: 'matrix coverage', tasks: ['agents', 'tools', 'mcp'] }, result => ({
      status: !result.isError && result.text.includes('Plan only') ? 'PASS' : 'FAIL'
    })),
    {
      id: 'todo_manager',
      async run(client) {
        const added = await callTool(client, 'todo_manager', { action: 'add', task: 'matrix-todo' }, SCRATCH);
        let id = null;
        try { const rows = JSON.parse(added.text); id = Array.isArray(rows) ? rows.at(-1)?.id : null; } catch {}
        if (!id) return { called: true, status: 'FAIL', text: snippet(added.text), httpStatus: added.httpStatus, isError: added.isError, note: 'todo id missing' };
        const removed = await callTool(client, 'todo_manager', { action: 'remove', id }, SCRATCH);
        return { called: true, status: !removed.isError ? 'PASS' : 'FAIL', text: snippet(`${added.text} | remove=${removed.text}`), httpStatus: removed.httpStatus, isError: removed.isError, note: `added+removed ${id}` };
      }
    },
    {
      id: 'note_store',
      async run(client) {
        const appended = await callTool(client, 'note_store', { action: 'append', text: 'matrix note sentinel', topic: 'matrix' }, SCRATCH);
        const listed = await callTool(client, 'note_store', { action: 'list', topic: 'matrix' }, SCRATCH);
        const ok = !appended.isError && !listed.isError && listed.text.includes('matrix note sentinel');
        return { called: true, status: ok ? 'PASS' : 'FAIL', text: snippet(`${appended.text} | ${listed.text}`), httpStatus: listed.httpStatus, isError: listed.isError, note: 'append+list' };
      }
    },
    simpleSpec('web_search', ROOT, { query: 'Node.js', limit: 5 }, result => {
      if (result.isError && /search_backend_not_configured/.test(result.text)) {
        return { status: 'NOT_TESTED', note: 'WEB_SEARCH_ENDPOINT is not configured; backend absence observed' };
      }
      const hasUrl = /https?:\/\/\S+/.test(result.text);
      return { status: !result.isError && hasUrl ? 'PASS' : 'FAIL', note: hasUrl ? 'real result URL returned' : 'no result URL in response' };
    }),
    simpleSpec('fetch_web_page', ROOT, { url: 'https://example.com/' }, result => ({
      status: !result.isError && /Example Domain/i.test(result.text) ? 'PASS' : 'FAIL'
    }))
  ];
}

async function runFull() {
  const runId = `matrix-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 6)}`;
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  for (const [relative, content] of [
    ['data/matrix-scratch/tools/edit.txt', 'OLD_MATRIX\n'],
    ['data/matrix-scratch/tools/diff.txt', 'DIFF_OLD\n'],
    ['data/matrix-scratch/tools/delete-me.txt', 'delete me\n']
  ]) writeText(relative, content);

  const startedAt = new Date().toISOString();
  const artifact = { runId, startedAt, finishedAt: null, baseUrl: BASE, provider: PROVIDER, upstreamUrl: UPSTREAM, model: MODEL, agentRoot: AGENT_ROOT, scratchRoot: SCRATCH, udsPath: UDS_ENABLED ? UDS_PATH : null, agents: [], tools: [], mcp: null, upstream: null, summary: null };

  const health = await jsonFetch(`${BASE}/health`, {}, 10000);
  artifact.health = { httpStatus: health.status, ok: health.body?.ok === true, executionMode: health.body?.executionMode ?? null, toolAccessMode: health.body?.toolAccessMode ?? null, sha256: sha256(health.text) };
  if (health.status !== 200 || health.body?.ok !== true) throw new Error(`health_failed_${health.status}`);

  const models = await jsonFetch(`${UPSTREAM}/models`, {}, 10000);
  const modelIds = Array.isArray(models.body?.data) ? models.body.data.map(item => item.id) : [];
  const chat = await jsonFetch(`${UPSTREAM}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: ZC_LLAMA_MATRIX_OK' }], max_tokens: 16, temperature: 0 })
  }, 120000);
  artifact.upstream = {
    modelsHttpStatus: models.status,
    modelIds,
    modelListed: modelIds.includes(MODEL),
    chatHttpStatus: chat.status,
    chatContent: snippet(chat.body?.choices?.[0]?.message?.content ?? ''),
    chatSentinel: String(chat.body?.choices?.[0]?.message?.content ?? '').includes('ZC_LLAMA_MATRIX_OK'),
    chatSha256: sha256(chat.text)
  };
  if (models.status !== 200 || !artifact.upstream.modelListed) throw new Error('upstream_model_not_listed');
  if (chat.status !== 200 || !artifact.upstream.chatSentinel) throw new Error('upstream_chat_sentinel_failed');

  const client = mcpClient();
  const init = await client.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'agent-mcp-matrix', version: '1.0.0' } }, 15000);
  const listed = await client.call('tools/list', {}, 15000);
  const mcpTools = listed.rpc?.result?.tools ?? [];
  artifact.mcp = {
    initializeHttpStatus: init.status,
    protocolVersion: init.rpc?.result?.protocolVersion ?? null,
    serverName: init.rpc?.result?.serverInfo?.name ?? null,
    sessionId: client.sessionId,
    toolsHttpStatus: listed.status,
    toolsListed: mcpTools.length,
    toolNames: mcpTools.map(item => item.name)
  };
  if (init.status !== 200 || listed.status !== 200) throw new Error('mcp_initialize_or_list_failed');

  const appKey = await ensureAppKey();
  const agentsResponse = await jsonFetch(`${BASE}/v1/admin/registry/agents`, { headers: adminHeaders }, 15000);
  const agents = (agentsResponse.body?.components ?? []).map(item => item.id);
  if (agents.length !== 12) throw new Error(`agent_count_${agents.length}`);
  await jsonFetch(`${BASE}/v1/admin/agents/metrics`, { method: 'DELETE', headers: adminHeaders }, 15000);
  const sentinels = {
    'code-guru': 'A1_OK',
    'bug-hunter': 'A2_OK',
    'security-hero': 'A3_OK',
    'perf-wizard': 'A4_OK',
    'doc-king': 'A5_OK',
    'qa-tyrant': 'A6_OK',
    'planner': 'A7_OK',
    'researcher': 'A8_OK',
    'integrator': 'A9_OK',
    'customer-experience-specialist': 'A10_OK',
    'ecommerce-operations-analyst': 'A11_OK',
    'team-heart': 'A12_OK'
  };
  for (const agentId of agents) {
    const sentinel = sentinels[agentId] ?? 'AGENT_OK';
    const prompt = `Reply with exactly: ${sentinel}`;
    const response = await retryOnce(() => jsonFetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agentId, provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 24, temperature: 0, projectRoot: AGENT_ROOT })
    }, 180000), `agent_${agentId}`);
    const content = String(response.body?.choices?.[0]?.message?.content ?? '');
    const metrics = await jsonFetch(`${BASE}/v1/admin/agents/metrics`, { headers: adminHeaders }, 15000);
    const metric = (metrics.body?.metrics ?? []).find(item => item.agentId === agentId) ?? null;
    const sentinelMatched = content.includes(sentinel);
    const providerId = metric?.lastProviderId ?? null;
    artifact.agents.push({
      agentId,
      prompt,
      sentinel,
      httpStatus: response.status,
      ok: response.status === 200 && sentinelMatched && providerId === PROVIDER,
      providerId,
      mappedModel: metric?.lastModel ?? null,
      publicModel: response.body?.model ?? null,
      latencyMs: metric?.lastLatencyMs ?? response.latencyMs,
      content: snippet(content),
      responded: content.trim().length > 0,
      sentinelMatched,
      finishReason: response.body?.choices?.[0]?.finish_reason ?? null,
      metricAt: metric?.lastAt ?? null,
      error: response.body?.error ?? null,
      responseSha256: sha256(response.text)
    });
    process.stderr.write(`[matrix] agent ${agentId} sentinel=${sentinelMatched} provider=${providerId} ${metric?.lastLatencyMs ?? response.latencyMs}ms\n`);
  }

  for (const spec of buildToolSpecs(runId)) {
    let record;
    try {
      record = await spec.run(client);
    } catch (error) {
      record = { called: true, status: 'FAIL', text: '', httpStatus: null, isError: true, note: String(error?.message ?? error) };
    }
    artifact.tools.push({ toolId: spec.id, ...record });
    process.stderr.write(`[matrix] tool ${spec.id} ${record.status}\n`);
  }

  const statusPorcelain = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  artifact.repo = {
    statusPorcelain,
    dirtyFiles: statusPorcelain ? statusPorcelain.split('\n').map(line => line.slice(3)) : [],
    note: 'expected untracked: scripts/agent-mcp-matrix.mjs; data/ is ignored'
  };
  artifact.summary = {
    agentsAttempted: artifact.agents.length,
    agentsOk: artifact.agents.filter(item => item.ok === true && item.responded).length,
    toolsCalled: artifact.tools.filter(item => item.called === true).length,
    toolsPass: artifact.tools.filter(item => item.status === 'PASS').length,
    toolsFailed: artifact.tools.filter(item => item.status === 'FAIL').length,
    toolsNotTested: artifact.tools.filter(item => item.status === 'NOT_TESTED').length,
    mcpTools: artifact.mcp.toolsListed,
    upstreamSentinel: artifact.upstream.chatSentinel,
    appKeyFile: APP_KEY_FILE.replace(ROOT, '.')
  };
  artifact.uds = UDS_ENABLED
    ? await udsHealth().then(value => ({ ok: value.status === 200 && value.body?.ok === true, httpStatus: value.status, sha256: value.sha256 })).catch(error => ({ ok: false, error: String(error?.message ?? error) }))
    : { ok: null, skipped: true, reason: `no UDS for provider ${PROVIDER}` };
  artifact.finishedAt = new Date().toISOString();
  artifact.artifactSha256 = sha256(JSON.stringify(artifact));
  writeFileSync(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`MATRIX provider=${PROVIDER} agents=${artifact.summary.agentsOk}/${agents.length} tools=${artifact.summary.toolsCalled}/${artifact.tools.length} mcp=${artifact.mcp.toolsListed} uds=${artifact.uds.skipped ? 'skipped' : (artifact.uds.ok ? 'ok' : 'fail')} upstream=${artifact.upstream.chatSentinel ? 'ok' : 'fail'}`);
  return artifact;
}

function verifyArtifact() {
  if (!existsSync(ARTIFACT)) throw new Error('artifact_missing');
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const problems = [];
  if (!/^matrix-/.test(String(artifact.runId ?? ''))) problems.push('runId_invalid');
  if (!Array.isArray(artifact.agents) || artifact.agents.length !== 12) problems.push(`agents_${artifact.agents?.length ?? 0}`);
  for (const agent of artifact.agents ?? []) {
    if (agent.httpStatus !== 200 || agent.ok !== true || agent.providerId !== artifact.provider || agent.sentinelMatched !== true) problems.push(`agent_incomplete_${agent.agentId}`);
  }
  if (!Array.isArray(artifact.tools) || artifact.tools.length !== 28) problems.push(`tools_${artifact.tools?.length ?? 0}`);
  for (const tool of artifact.tools ?? []) if (tool.called !== true) problems.push(`tool_not_called_${tool.toolId}`);
  if (artifact.mcp?.toolsListed !== 28) problems.push(`mcp_tools_${artifact.mcp?.toolsListed ?? 0}`);
  if (artifact.uds?.skipped !== true && artifact.uds?.ok !== true) problems.push('uds_not_ok');
  if (artifact.upstream?.chatSentinel !== true) problems.push('upstream_chat_not_ok');
  return { artifact, problems };
}

async function runVerify() {
  const { artifact, problems } = verifyArtifact();
  if (problems.length) {
    console.log(`VERIFY_FAIL ${problems.join(',')}`);
    process.exit(1);
  }
  const health = await jsonFetch(`${BASE}/health`, {}, 10000);
  if (health.status !== 200 || health.body?.ok !== true) {
    console.log(`VERIFY_FAIL runtime_health_${health.status}`);
    process.exit(1);
  }
  const models = await jsonFetch(`${UPSTREAM}/models`, {}, 10000);
  const modelIds = Array.isArray(models.body?.data) ? models.body.data.map(item => item.id) : [];
  if (models.status !== 200 || !modelIds.includes(artifact.model)) {
    console.log(`VERIFY_FAIL upstream_model_${models.status}`);
    process.exit(1);
  }
  const appKey = readFileSync(APP_KEY_FILE, 'utf8').trim();
  const chat = await jsonFetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: artifact.provider, model: artifact.model, messages: [{ role: 'user', content: 'Reply with exactly: ZC_VERIFY_LIVE_OK' }], max_tokens: 16, temperature: 0 })
  }, 120000);
  const content = String(chat.body?.choices?.[0]?.message?.content ?? '');
  if (chat.status !== 200 || !content.includes('ZC_VERIFY_LIVE_OK')) {
    console.log(`VERIFY_FAIL live_chat_${chat.status}_${snippet(content, 80)}`);
    process.exit(1);
  }
  if (artifact.uds?.skipped !== true) {
    const uds = await udsHealth();
    if (uds.status !== 200 || uds.body?.ok !== true) {
      console.log(`VERIFY_FAIL uds_health_${uds.status}`);
      process.exit(1);
    }
  }
  console.log(`VERIFY provider=${artifact.provider} agents=12/12 tools=28/28 mcp=28 uds=${artifact.uds?.skipped ? 'skipped' : 'ok'} live=ok run=${artifact.runId}`);
}

try {
  if (VERIFY_ONLY) await runVerify();
  else await runFull();
} catch (error) {
  console.error(`MATRIX_FAIL ${String(error?.message ?? error)}`);
  process.exit(1);
}
