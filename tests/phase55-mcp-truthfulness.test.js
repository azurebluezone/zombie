import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateToolArguments } from '../src/mcp/schema.js';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('phase55 undeclared arguments are rejected when the schema forbids them', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
  validateToolArguments({ inputSchema: schema }, { path: 'a.txt' });
  assert.throws(() => validateToolArguments({ inputSchema: schema }, { path: 'a.txt', overwrite: true }), /mcp_tool_argument_unknown:overwrite/);
});

test('phase55 a permissive schema still accepts extra arguments', () => {
  const open = { type: 'object', properties: { query: { type: 'string' } } };
  validateToolArguments({ inputSchema: open }, { query: 'x', extra: 1 });
  const allowed = { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: true };
  validateToolArguments({ inputSchema: allowed }, { query: 'x', extra: 1 });
});

test('phase55 every native tool schema forbids undeclared arguments at the boundary', () => {
  const createFile = COMMON_TOOLS.find(tool => tool.id === 'create_file');
  assert.equal(createFile.metadata.toolSchema.additionalProperties, false);
  assert.throws(
    () => validateToolArguments({ inputSchema: createFile.metadata.toolSchema }, { path: 'a.txt', content: 'x', mode: 'fast' }),
    /mcp_tool_argument_unknown:mode/
  );
});

test('phase55 the mcp compatibility surface never advertises a server endpoint', async t => {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase55-mcp-'));
  const adminToken = 'phase55-admin-token';
  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false', HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: adminToken, LOCAL_AUTH_BYPASS: 'false',
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
  const admin = { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` };

  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(mcp.status, 501, 'the runtime must not pretend to serve MCP');
  const mcpBody = await mcp.json();
  assert.equal(mcpBody.error.code, 'mcp_server_not_implemented');
  assert.equal(mcpBody.role, 'mcp-client');
  assert.deepEqual(mcpBody.supported_protocol_versions, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

  const config = await (await fetch(`${base}/api/config/mcp`)).json();
  assert.equal(config.role, 'mcp-client');
  assert.equal(config.server.implemented, false);
  assert.equal(config.transport.url, null);
  assert.equal(config.transport.implemented, false);
  assert.equal(JSON.stringify(config).includes('/mcp'), false, 'no mcp server url may be advertised');
  assert.deepEqual(config.server.supported_protocol_versions, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

  const clients = await (await fetch(`${base}/api/mcp-clients`)).json();
  assert.equal(clients.server_implemented, false);
  assert.equal(clients.server_url, null);
  assert.equal(clients.protocol_version, '2025-11-25');
  assert.deepEqual(clients.supported_protocol_versions, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.coreModules.mcpServer, false);
  assert.equal(health.coreModules.mcpClient, true);

  const bogus = await fetch(`${base}/v1/admin/tools/permissions`, { method: 'POST', headers: admin, body: JSON.stringify({ applicationId: 'app_phase55', toolId: 'not_a_real_tool' }) });
  assert.equal(bogus.status, 400);
  assert.deepEqual(await bogus.json(), { error: { message: 'tool_not_found', type: 'invalid_request_error', param: null, code: 'tool_not_found' }, toolId: 'not_a_real_tool' });

  const real = await fetch(`${base}/v1/admin/tools/permissions`, { method: 'POST', headers: admin, body: JSON.stringify({ applicationId: 'app_phase55', toolId: 'create_file' }) });
  assert.equal(real.status, 201);
  const granted = await real.json();
  assert.equal(granted.permission.toolId, 'create_file');

  const missing = await fetch(`${base}/v1/admin/tools/permissions`, { method: 'POST', headers: admin, body: JSON.stringify({ applicationId: 'app_phase55' }) });
  assert.equal(missing.status, 400, 'a missing toolId must not create a dead permission row');
});
