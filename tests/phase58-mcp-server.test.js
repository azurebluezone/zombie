import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMcpServerMessage, mcpServerToolCatalog, negotiateProtocolVersion } from '../src/mcp/server.js';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// Protocol unit tests (no server needed)
// ---------------------------------------------------------------------------

test('phase58 the advertised catalog equals the runnable catalog', () => {
  const catalog = mcpServerToolCatalog(COMMON_TOOLS);
  const names = catalog.map(tool => tool.name);
  // Executable native tools are exposed...
  for (const expected of ['runtime_echo', 'read_file', 'write_file', 'run_terminal_command', 'git_status']) {
    assert.ok(names.includes(expected), `expected ${expected} to be advertised`);
  }
  // ...and the tools that leave the machine are advertised now that they exist.
  for (const expected of ['web_search', 'fetch_web_page']) {
    assert.ok(names.includes(expected), `expected ${expected} to be advertised`);
  }
  // A name the runtime does not ship must never be advertised.
  for (const hidden of ['delegate_subagent', 'public_api', 'tts', 'ocr', 'facebook_ads']) {
    assert.equal(names.includes(hidden), false, `${hidden} must not be advertised`);
  }
  for (const tool of catalog) assert.ok(tool.inputSchema && typeof tool.inputSchema.type === 'string', `${tool.name} needs an inputSchema`);
  assert.equal(catalog.length, COMMON_TOOLS.filter(t => t.entry && (t.status === 'ENABLED' || t.status === 'VERIFIED')).length);
});

test('phase58 protocol version negotiation honours known versions and falls back to latest', () => {
  assert.equal(negotiateProtocolVersion('2025-06-18'), '2025-06-18');
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateProtocolVersion('1999-01-01'), '2025-11-25');
  assert.equal(negotiateProtocolVersion(undefined), '2025-11-25');
});

test('phase58 initialize answers with capabilities and a session id', async () => {
  const outcome = await handleMcpServerMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { tools: COMMON_TOOLS });
  assert.equal(outcome.body.id, 1);
  assert.equal(outcome.body.result.protocolVersion, '2025-06-18');
  assert.equal(outcome.body.result.capabilities.tools.listChanged, false);
  assert.equal(outcome.body.result.serverInfo.name, 'zombiecoder-runtime');
  assert.match(outcome.sessionId, /^mcp-/);
});

test('phase58 notifications never carry a response body', async () => {
  const initialized = await handleMcpServerMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { tools: COMMON_TOOLS });
  assert.equal(initialized.body, null);
  const unknownNotification = await handleMcpServerMessage({ jsonrpc: '2.0', method: 'notifications/progress' }, { tools: COMMON_TOOLS });
  assert.equal(unknownNotification.body, null);
});

test('phase58 malformed envelopes and unknown methods return JSON-RPC errors', async () => {
  const invalid = await handleMcpServerMessage({ id: 2, method: 'initialize' }, { tools: [] });
  assert.equal(invalid.body.error.code, -32600);
  const missing = await handleMcpServerMessage({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' }, { tools: [] });
  assert.equal(missing.body.error.code, -32601);
  const unknownTool = await handleMcpServerMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } }, { tools: COMMON_TOOLS, executeTool: async () => ({}) });
  assert.equal(unknownTool.body.error.code, -32602);
});

test('phase58 tools/call maps success through and tool failures to isError', async () => {
  const ok = await handleMcpServerMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } },
    { tools: COMMON_TOOLS, executeTool: async () => ({ content: [{ type: 'text', text: 'hello' }] }) }
  );
  assert.deepEqual(ok.body.result, { content: [{ type: 'text', text: 'hello' }], isError: false });

  const failed = await handleMcpServerMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } },
    { tools: COMMON_TOOLS, executeTool: async () => { throw new Error('tool_not_permitted:tool_not_permitted'); } }
  );
  assert.equal(failed.body.result.isError, true);
  assert.match(failed.body.result.content[0].text, /tool_not_permitted/);
});

// ---------------------------------------------------------------------------
// End-to-end test against a live runtime started with MCP_SERVER_ENABLED=true
// ---------------------------------------------------------------------------

test('phase58 the runtime serves MCP on /mcp when explicitly enabled', async t => {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase58-mcp-'));
  const dataDir = path.join(dir, 'data');
  const adminToken = 'phase58-admin-token';
  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false', HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: adminToken, LOCAL_AUTH_BYPASS: 'false',
    MCP_SERVER_ENABLED: 'true',
    PROVIDER_CONFIG_JSON: JSON.stringify([{ id: 'fixture-provider', name: 'Fixture', baseUrl: 'http://127.0.0.1:9/v1', driver: 'openai-compatible', protocol: 'openai-compatible', models: ['fixture-model'], defaultModel: 'fixture-model', enabled: false }]),
    DATA_DIR: dataDir, SQLITE_PATH: path.join(dataDir, 'runtime.sqlite'), LOG_DIR: path.join(dir, 'logs'), LOG_TO_STDOUT: 'false',
    UDS_ENABLED: 'false', PROVIDER_CATALOG_SYNC_ON_START: 'false', ZOMBIECODER_EXECUTION_MODE: 'tools-enabled', EXTERNAL_MCP_URLS: '', PROJECT_ROOTS: ''
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'probe.txt'), 'mcp-server-ok', 'utf8');

  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) assert.fail(`runtime exited ${child.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'runtime did not start');
  const base = `http://127.0.0.1:${port}`;

  // The endpoint advertises itself now that it is enabled.
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.coreModules.mcpServer, true);
  const config = await (await fetch(`${base}/api/config/mcp`)).json();
  assert.equal(config.server.implemented, true);
  assert.equal(config.transport.implemented, true);
  assert.match(config.transport.url, /\/mcp$/);

  // Unauthenticated calls are refused: MCP tool execution is never anonymous.
  const anon = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(anon.status, 401);

  // Provision an application to act as the MCP client.
  const created = await fetch(`${base}/v1/admin/applications`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'phase58-mcp-client' }) });
  assert.equal(created.status, 201);
  const { application, apiKey } = await created.json();
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, accept: 'application/json, text/event-stream' };
  const call = (body, headers = auth) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });

  // initialize -> a protocol response plus an Mcp-Session-Id.
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'phase58', version: '1' } } });
  assert.equal(init.status, 200);
  assert.ok(init.headers.get('mcp-session-id'), 'initialize must return an Mcp-Session-Id');
  const initBody = await init.json();
  assert.equal(initBody.result.protocolVersion, '2025-11-25');
  assert.equal(initBody.result.serverInfo.name, 'zombiecoder-runtime');
  const sessionId = init.headers.get('mcp-session-id');

  // notifications/initialized -> 202 with no body.
  const notified = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified.status, 202);

  // tools/list -> the runnable catalog.
  const listed = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const toolNames = listed.result.tools.map(tool => tool.name);
  assert.ok(toolNames.includes('read_file'));
  assert.ok(toolNames.includes('web_search'), 'a runnable web tool is part of the catalog now');

  // A tool without a grant is refused, matching the chat tool loop.
  const denied = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'probe.txt' } } })).json();
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /tool_not_permitted/);

  // Grant then re-run: the same call now returns file content.
  const granted = await fetch(`${base}/v1/admin/tools/permissions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ applicationId: application.id, toolId: 'read_file' }) });
  assert.equal(granted.status, 201);
  const read = await (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'probe.txt' } } })).json();
  assert.equal(read.result.isError, false);
  assert.match(JSON.stringify(read.result.content), /mcp-server-ok/);

  // The session header round-trips on a later request.
  const ping = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) });
  assert.equal(ping.status, 200);
  assert.deepEqual((await ping.json()).result, {});
});

test('phase58 when the flag is off the endpoint stays honest (501)', async t => {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase58-off-'));
  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false', HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: 'phase58-off-token', LOCAL_AUTH_BYPASS: 'false',
    PROVIDER_CONFIG_JSON: JSON.stringify([{ id: 'fixture-provider', name: 'Fixture', baseUrl: 'http://127.0.0.1:9/v1', driver: 'openai-compatible', protocol: 'openai-compatible', models: ['fixture-model'], defaultModel: 'fixture-model', enabled: false }]),
    DATA_DIR: path.join(dir, 'data'), SQLITE_PATH: path.join(dir, 'data', 'runtime.sqlite'), LOG_DIR: path.join(dir, 'logs'), LOG_TO_STDOUT: 'false',
    UDS_ENABLED: 'false', PROVIDER_CATALOG_SYNC_ON_START: 'false', ZOMBIECODER_EXECUTION_MODE: 'chat-only', EXTERNAL_MCP_URLS: '', PROJECT_ROOTS: ''
  };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) assert.fail(`runtime exited ${child.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'runtime did not start');
  const base = `http://127.0.0.1:${port}`;
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(mcp.status, 501);
  assert.equal((await mcp.json()).error, 'mcp_server_not_implemented');
});
