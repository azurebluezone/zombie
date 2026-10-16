import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeOutboundUrl } from '../src/network/outbound-policy.js';
import { assertSafeHttpsUrl } from '../src/mcp/security.js';
import { OllamaProvider } from '../src/providers/adapters/ollama.js';
import { isAdminAuthorized } from '../src/auth/admin-auth.js';

test('shared outbound policy allows normal HTTPS provider destination', async () => {
  const result = await assertSafeOutboundUrl('https://localhost/v1', {protocols:['https:'],allowPrivateNetwork:true});
  assert.equal(result.url.protocol, 'https:');
  assert.equal(result.host, 'localhost');
  assert.ok(Array.isArray(result.answers) && result.answers.length > 0);
});

test('provider plaintext HTTP is denied unless explicitly enabled', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('http://example.com', {protocols:['https:']}), /outbound_protocol_forbidden/);
  const result = await assertSafeOutboundUrl('http://localhost:11434', {protocols:['https:'],allowPlaintextHttp:true,allowPrivateNetwork:true});
  assert.equal(result.url.protocol, 'http:');
});

test('provider private destination is denied by default', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('https://127.0.0.1', {protocols:['https:']}), /outbound_private_address_forbidden/);
  await assert.rejects(() => assertSafeOutboundUrl('https://localhost', {protocols:['https:']}), /outbound_private_address_forbidden/);
});

test('MCP policy remains stricter than provider policy', async () => {
  await assert.rejects(() => assertSafeHttpsUrl('http://example.com/mcp'), /outbound_protocol_forbidden/);
  await assert.rejects(() => assertSafeHttpsUrl('https://127.0.0.1/mcp'), /outbound_private_address_forbidden/);
});

test('admin authorization is required for protected admin routes', () => {
  assert.equal(isAdminAuthorized('', 'secret'), false);
  assert.equal(isAdminAuthorized('wrong', 'secret'), false);
  assert.equal(isAdminAuthorized('secret', 'secret'), true);
});

test('provider adapter carries explicit network policy', () => {
  const provider = new OllamaProvider({baseUrl:'http://localhost:11434',networkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
  assert.deepEqual(provider.networkPolicy, {allowPlaintextHttp:true,allowPrivateNetwork:true});
});
