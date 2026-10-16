import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { discoverMcpTools, MCP_PROTOCOL_VERSIONS, LATEST_MCP_PROTOCOL_VERSION } from '../src/mcp/client.js';

async function withMcpServer(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { return await run(port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function reader(handler) {
  return (req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => handler({ req, res, body: raw.trim() ? JSON.parse(raw) : null, headers: req.headers }));
  };
}

function endpoint(port) {
  return { url: `http://127.0.0.1:${port}/rpc`, allowHosts: ['127.0.0.1'], networkPolicy: { allowHttp: true, allowPrivateNetwork: true } };
}

function fakeServer({ protocolVersion, seen }) {
  return reader(({ req, res, body }) => {
    seen.push({ method: body?.method ?? null, protocolHeader: req.headers['mcp-protocol-version'] ?? null, requested: body?.params?.protocolVersion ?? null });
    res.setHeader('content-type', 'application/json');
    if (body?.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } }));
      return;
    }
    if (body?.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
    if (body?.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] } }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method_not_found' } }));
  });
}

test('phase54 the newest protocol version is requested first', () => {
  assert.equal(LATEST_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS[0]);
  assert.ok(MCP_PROTOCOL_VERSIONS.includes('2025-11-25'));
  assert.ok(MCP_PROTOCOL_VERSIONS.includes('2025-06-18'));
  assert.ok(MCP_PROTOCOL_VERSIONS.includes('2025-03-26'));
  assert.ok(MCP_PROTOCOL_VERSIONS.includes('2024-11-05'));
});

test('phase54 a server answering the newest version negotiates without a downgrade', async () => {
  const seen = [];
  await withMcpServer(fakeServer({ protocolVersion: LATEST_MCP_PROTOCOL_VERSION, seen }), async port => {
    const result = await discoverMcpTools(endpoint(port));
    assert.equal(result.protocolVersion, LATEST_MCP_PROTOCOL_VERSION);
    assert.equal(result.requestedProtocolVersion, LATEST_MCP_PROTOCOL_VERSION);
    assert.equal(result.versionNegotiated, false);
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, 'echo');
  });
  assert.equal(seen[0].requested, LATEST_MCP_PROTOCOL_VERSION, 'initialize must ask for the newest version');
  assert.equal(seen[0].protocolHeader, LATEST_MCP_PROTOCOL_VERSION);
});

test('phase54 an older server version is honoured and reused for every later request', async () => {
  const seen = [];
  await withMcpServer(fakeServer({ protocolVersion: '2024-11-05', seen }), async port => {
    const result = await discoverMcpTools(endpoint(port));
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.requestedProtocolVersion, LATEST_MCP_PROTOCOL_VERSION);
    assert.equal(result.versionNegotiated, true);
  });
  const afterInit = seen.filter(entry => entry.method !== 'initialize');
  assert.equal(afterInit.length >= 2, true);
  for (const entry of afterInit) assert.equal(entry.protocolHeader, '2024-11-05', `${entry.method} must use the negotiated version`);
});

test('phase54 an unknown server version fails closed instead of talking a foreign protocol', async () => {
  const seen = [];
  await withMcpServer(fakeServer({ protocolVersion: '2099-01-01', seen }), async port => {
    await assert.rejects(() => discoverMcpTools(endpoint(port)), error => {
      assert.match(String(error.message), /mcp_protocol_version_unsupported:2099-01-01/);
      assert.equal(error.mcpCode, 'mcp_protocol_version_unsupported:2099-01-01');
      return true;
    });
  });
  assert.equal(seen.some(entry => entry.method === 'tools/list'), false, 'no further request may be sent');
});
