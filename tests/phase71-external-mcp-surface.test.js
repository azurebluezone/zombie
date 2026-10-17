import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveTlsOptions, assertSafeMcpUrl } from '../src/mcp/security.js';
import { assertSupportedTransport, MCP_TRANSPORTS } from '../src/mcp/client.js';
import { buildExternalToolSurface, safeFunctionName, boundaryEndpointIds } from '../src/mcp/external-surface.js';
import { McpRegistry, redactEndpoint } from '../src/mcp/registry.js';

const fakeStore = (seed = {}) => {
  const data = { ...seed };
  return { read: async (k, d) => (k in data ? data[k] : d), write: async (k, v) => { data[k] = v; }, _data: data };
};

test('a self-signed endpoint can be trusted with a CA instead of disabling verification', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-tls-'));
  const caFile = path.join(dir, 'ca.pem');
  await writeFile(caFile, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');

  const fromFile = await resolveTlsOptions({ caFile }, { env: {} });
  assert.match(fromFile.ca, /BEGIN CERTIFICATE/);
  assert.equal(fromFile.rejectUnauthorized, true, 'a CA must not disable verification');

  const global = await resolveTlsOptions({}, { env: { MCP_TLS_CA_FILE: caFile } });
  assert.match(global.ca, /BEGIN CERTIFICATE/);

  const inline = await resolveTlsOptions({ ca: 'INLINE', caFile }, { env: {} });
  assert.equal(inline.ca, 'INLINE', 'a per-endpoint CA wins over a file');

  const insecure = await resolveTlsOptions({ rejectUnauthorized: false }, { env: {} });
  assert.equal(insecure.rejectUnauthorized, false);
  assert.equal(insecure.insecure, true, 'skipping verification must be reported, not silent');

  await assert.rejects(() => resolveTlsOptions({ caFile: path.join(dir, 'missing.pem') }, { env: {} }), /mcp_tls_ca_unreadable/);
});

test('an explicitly allowlisted host may use a non-standard HTTPS port', async () => {
  const allowed = await assertSafeMcpUrl('https://127.0.0.1:8443/mcp', { allowHosts: ['127.0.0.1'], allowPrivateNetwork: true });
  assert.equal(allowed.url.port, '8443');
  assert.ok(allowed.tls);

  // Without an explicit allowlist the blanket "standard port only" default stays.
  await assert.rejects(
    () => assertSafeMcpUrl('https://127.0.0.1:8443/mcp', { allowHosts: [], allowPrivateNetwork: true }),
    /outbound_nonstandard_https_port_forbidden/
  );
});

test('a transport the client cannot speak fails closed with an actionable code', () => {
  assert.deepEqual([...MCP_TRANSPORTS], ['http', 'sse', 'grpc']);
  assert.equal(assertSupportedTransport({ transport: 'http' }), 'http');
  assert.equal(assertSupportedTransport({ transport: 'sse' }), 'sse');
  assert.equal(assertSupportedTransport({}), 'http', 'a record without a transport is HTTP');
  assert.throws(() => assertSupportedTransport({ transport: 'grpc' }), /mcp_transport_grpc_requires_bridge/);
  assert.throws(() => assertSupportedTransport({ transport: 'carrier-pigeon' }), /mcp_transport_unsupported/);
});

test('discovered external tools become OpenAI-safe definitions bound to their qualified name', () => {
  const endpoints = [
    {
      id: 'facebook-ads',
      enabled: true,
      status: 'discovered',
      tools: [{ name: 'ads.report/get', description: 'ads report', inputSchema: { type: 'object', properties: { since: { type: 'string' } } }, qualifiedName: 'facebook-ads.ads.report/get' }]
    }
  ];
  const surface = buildExternalToolSurface({ endpoints });
  assert.equal(surface.definitions.length, 1);
  const name = surface.definitions[0].function.name;
  assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/, 'the offered name must be a legal function name');
  assert.equal(name, safeFunctionName('facebook-ads', 'ads.report/get'));
  assert.deepEqual(surface.bindings[name], { qualifiedName: 'facebook-ads.ads.report/get', executionTarget: 'mcp' });
  assert.equal(surface.entries[0].qualifiedName, 'facebook-ads.ads.report/get');
  assert.deepEqual(surface.endpointIds, ['facebook-ads']);
});

test('only a discovered endpoint with tools contributes, and the cap is honoured', () => {
  const endpoints = [
    { id: 'dead', enabled: true, status: 'error', tools: [] },
    { id: 'registered', enabled: true, status: 'registered', tools: [] },
    { id: 'off', enabled: false, status: 'discovered', tools: [{ name: 'x', qualifiedName: 'off.x' }] },
    { id: 'live', enabled: true, status: 'discovered', tools: [{ name: 'a', qualifiedName: 'live.a' }, { name: 'b', qualifiedName: 'live.b' }] }
  ];
  const surface = buildExternalToolSurface({ endpoints });
  assert.deepEqual(surface.entries.map((e) => e.qualifiedName), ['live.a', 'live.b']);

  const capped = buildExternalToolSurface({ endpoints, maxTools: 1 });
  assert.equal(capped.entries.length, 1);
  assert.equal(capped.dropped[0].reason, 'external_tool_cap');
});

test('an agent boundary filters which external endpoints are offered', () => {
  const endpoints = [
    { id: 'ocr', enabled: true, status: 'discovered', tools: [{ name: 'read', qualifiedName: 'ocr.read' }] },
    { id: 'tts', enabled: true, status: 'discovered', tools: [{ name: 'speak', qualifiedName: 'tts.speak' }] }
  ];
  const cx = boundaryEndpointIds('customer-experience-specialist');
  assert.ok(Array.isArray(cx) && cx.includes('ocr') && cx.includes('tts'));
  const restricted = buildExternalToolSurface({ endpoints, allowedEndpointIds: ['ocr'] });
  assert.deepEqual(restricted.entries.map((e) => e.qualifiedName), ['ocr.read']);
  // An agent with no declared boundary keeps the whole discovered set.
  assert.equal(boundaryEndpointIds('code-guru'), null);
  assert.equal(buildExternalToolSurface({ endpoints, allowedEndpointIds: null }).entries.length, 2);
});

test('two endpoints exposing the same tool name do not collide', () => {
  const endpoints = [
    { id: 'a', enabled: true, status: 'discovered', tools: [{ name: 'ping', qualifiedName: 'a.ping' }] },
    { id: 'a_b', enabled: true, status: 'discovered', tools: [{ name: 'ping', qualifiedName: 'a_b.ping' }] }
  ];
  const surface = buildExternalToolSurface({ endpoints });
  const names = surface.definitions.map((d) => d.function.name);
  assert.equal(new Set(names).size, names.length, 'offered names must be unique');
  assert.equal(Object.keys(surface.bindings).length, 2);
});

test('the endpoint record keeps the transport and TLS decision without echoing the CA', async () => {
  const store = fakeStore();
  const registry = new McpRegistry(store, { networkPolicy: { allowHttp: true, allowPrivateNetwork: true } });
  const endpoint = await registry.register({ id: 'grpc-ads', url: 'https://127.0.0.1:8443/mcp', allowHosts: ['127.0.0.1'], transport: 'grpc', caFile: '/etc/ssl/internal.pem', rejectUnauthorized: false });
  assert.equal(endpoint.transport, 'grpc');
  assert.equal(endpoint.caFile, '/etc/ssl/internal.pem');
  assert.equal(endpoint.rejectUnauthorized, false);

  await assert.rejects(() => registry.register({ id: 'bad', url: 'https://127.0.0.1:8443/mcp', allowHosts: ['127.0.0.1'], transport: 'carrier-pigeon' }), /mcp_transport_invalid/);

  const redacted = redactEndpoint({ ...endpoint, ca: 'SECRET-PEM' });
  assert.equal(redacted.ca, undefined, 'the CA body must not be echoed back');
  assert.equal(redacted.hasCa, true);
  // A CA supplied as a file path is still a CA: the flag must not depend on the
  // inline form.
  assert.equal(redactEndpoint(endpoint).hasCa, true);
});
