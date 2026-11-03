import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeInstallEnv } from '../scripts/install-env.mjs';
import { startWebSearchServer } from '../scripts/web-search-mcp-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('phase86 install.sh is valid bash and keeps the end-to-end order', async () => {
  const script = await readFile(path.join(ROOT, 'install.sh'), 'utf8');
  execFileSync('bash', ['-n', path.join(ROOT, 'install.sh')]);
  for (const marker of [
    'git clone',
    'ZC_NODE_MAJOR=24',
    'scripts/install-env.mjs',
    'deploy/caddy/Caddyfile.runtime',
    'scripts/build-runtime.mjs',
    '/health',
    'external-mcp/sync',
    'INSTALL_OK'
  ]) assert.ok(script.includes(marker), `install.sh is missing ${marker}`);
});

test('phase86 install-env preserves provider keys and disables a dead llama.cpp provider', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-install-env-'));
  try {
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, '.env.example'), [
      'ADMIN_TOKEN=replace-with-a-long-random-admin-token',
      'RUNTIME_SECRET=replace-with-a-long-random-runtime-secret',
      'PROVIDER_CONFIG_JSON=[]',
      'CORS_ALLOW_ORIGINS=',
      ''
    ].join('\n'));
    await writeFile(path.join(dir, '.env'), [
      'ADMIN_TOKEN=existing-admin-token',
      'RUNTIME_SECRET=existing-runtime-secret',
      'PROVIDER_KEY_GEMINI=key-must-survive',
      'OLLAMA_BASE_URL=http://127.0.0.1:11434/v1',
      'PROVIDER_CONFIG_JSON=[{"id":"llama-cpu","enabled":true,"priority":1},{"id":"ollama-selfhosted","enabled":true,"defaultModel":"REPLACE_WITH_OLLAMA_MODEL","models":[]}]',
      'CORS_ALLOW_ORIGINS=http://127.0.0.1:8088',
      ''
    ].join('\n'));

    const result = await writeInstallEnv({
      root: dir,
      ollamaUrl: 'http://127.0.0.1:11434/v1',
      ollamaModel: 'qwen2.5:1.5b',
      llamaCppOk: false,
      webSearchPort: 8091,
      adminUiPort: 8088,
      caddyHttpsPort: 9443,
      adminHttpsPort: 9444
    });
    const env = await readFile(path.join(dir, '.env'), 'utf8');
    assert.match(env, /^PROVIDER_KEY_GEMINI=key-must-survive$/m);
    assert.match(env, /^ADMIN_TOKEN=existing-admin-token$/m);
    assert.match(env, /^WEB_SEARCH_ENDPOINT=http:\/\/127\.0\.0\.1:8091\/search$/m);
    assert.match(env, /^EXTERNAL_MCP_WEB_SEARCH_URL=http:\/\/127\.0\.0\.1:8091\/mcp$/m);
    assert.match(env, /^MCP_ALLOW_HTTP=true$/m);
    assert.match(env, /^MCP_ALLOW_PRIVATE_NETWORK=true$/m);
    assert.match(env, /^ZC_CADDY_HTTPS_PORT=9443$/m);
    const providers = JSON.parse(env.match(/^PROVIDER_CONFIG_JSON=(.*)$/m)[1]);
    const llama = providers.find(item => item.id === 'llama-cpu');
    const ollama = providers.find(item => item.id === 'ollama-selfhosted');
    assert.equal(llama.enabled, false, 'a dead llama.cpp must not stay routable');
    assert.equal(ollama.defaultModel, 'qwen2.5:1.5b');
    assert.deepEqual(ollama.models, ['qwen2.5:1.5b']);
    assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.ok(result.changed.includes('PROVIDER_CONFIG_JSON'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('phase86 web-search transport serves SearXNG JSON and MCP over one process', async () => {
  const calls = [];
  const search = async (query, options) => {
    calls.push({ query, options });
    return {
      query,
      results: [{ title: 'Node.js', url: 'https://nodejs.org/en', content: 'JavaScript runtime' }],
      count: 1,
      backends: { wikipedia: { status: 200, count: 1 } }
    };
  };
  const server = await startWebSearchServer({ host: '127.0.0.1', port: 0, search });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`).then(r => r.json());
    assert.equal(health.ok, true);
    assert.deepEqual(health.tools, ['web_search']);

    const searched = await fetch(`${base}/search?q=Node.js&limit=3`).then(r => r.json());
    assert.equal(searched.results[0].url, 'https://nodejs.org/en');
    assert.equal(calls[0].query, 'Node.js');

    const initResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'phase86', version: '1' } } })
    });
    assert.equal(initResponse.status, 200);
    const session = initResponse.headers.get('mcp-session-id');
    assert.ok(session);
    const init = await initResponse.json();
    assert.equal(init.result.protocolVersion, '2025-11-25');

    const headers = { 'content-type': 'application/json', 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' };
    const listed = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    }).then(r => r.json());
    assert.equal(listed.result.tools[0].name, 'web_search');

    const called = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'Node.js' } } })
    }).then(r => r.json());
    assert.equal(called.result.isError, false);
    assert.match(called.result.content[0].text, /https:\/\/nodejs\.org/);
    assert.equal(called.result.structuredContent.count, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('phase86 external MCP declaration and Caddy edge exist', async () => {
  const servers = JSON.parse(await readFile(path.join(ROOT, 'external-mcp/servers.json'), 'utf8'));
  const webSearch = servers.servers.find(item => item.id === 'web-search');
  assert.ok(webSearch, 'web-search must be declared');
  assert.equal(webSearch.urlEnv, 'EXTERNAL_MCP_WEB_SEARCH_URL');
  assert.equal(webSearch.transport, 'http');

  const caddyfile = await readFile(path.join(ROOT, 'deploy/caddy/Caddyfile.runtime'), 'utf8');
  assert.match(caddyfile, /https:\/\/localhost:\{\$ZC_CADDY_HTTPS_PORT:9443\}/);
  assert.match(caddyfile, /https:\/\/localhost:\{\$ZC_ADMIN_HTTPS_PORT:9444\}/);
  assert.match(caddyfile, /tls internal/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:\{\$ZC_RUNTIME_PORT:9999\}/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:\{\$ZC_ADMIN_UI_PORT:8088\}/);
});

test('phase86 matrix falls back to Ollama and requires a real web_search result', async () => {
  const script = await readFile(path.join(ROOT, 'scripts/agent-mcp-matrix.mjs'), 'utf8');
  assert.match(script, /MATRIX_PROVIDER_ID/);
  assert.match(script, /ollama-selfhosted/);
  assert.match(script, /provider: PROVIDER/);
  assert.match(script, /providerId === PROVIDER/);
  assert.match(script, /https\?:\\\/\\\/\\S\+/);
  assert.ok(existsSync(path.join(ROOT, 'scripts/verify-round4.mjs')), 'the round-4 gate must exist');
});
