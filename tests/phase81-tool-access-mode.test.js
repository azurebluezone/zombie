import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolPolicy } from '../src/tools/policy.js';
import { McpPermissions } from '../src/mcp/permissions.js';

function memoryStore() {
  const map = new Map();
  return {
    async read(key, fallback) { return map.has(key) ? map.get(key) : fallback; },
    async write(key, value) { map.set(key, value); }
  };
}

// `null` means "no explicit configuration", which is the state a fresh install
// is in. `false` is the operator switching that one tool off.
const setting = (enabled) => ({
  async toolSetting() { return { enabled, source: enabled === null ? 'unconfigured' : 'explicit' }; }
});

test('permissioned mode still requires an explicit grant', async () => {
  const policy = new ToolPolicy(memoryStore(), { accessMode: 'permissioned', configResolver: setting(null) });
  const denied = await policy.decision('app_1', 'read_file');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'tool_not_permitted');

  await policy.grant({ applicationId: 'app_1', toolId: 'read_file' });
  const allowed = await policy.decision('app_1', 'read_file');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'allowed');
});

test('unrestricted mode removes the grant gate but not the configuration switch', async () => {
  const policy = new ToolPolicy(memoryStore(), { accessMode: 'unrestricted', configResolver: setting(null) });
  const open = await policy.decision('app_1', 'read_file');
  assert.equal(open.allowed, true);
  assert.equal(open.reason, 'allowed_by_access_mode');

  const disabled = new ToolPolicy(memoryStore(), { accessMode: 'unrestricted', configResolver: setting(false) });
  const blocked = await disabled.decision('app_1', 'read_file');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'tool_disabled_by_configuration');
});

test('MCP permissions follow the same access mode', async () => {
  const closed = new McpPermissions(memoryStore(), { accessMode: 'permissioned' });
  assert.equal(await closed.allowed('app_1', 'mcp.demo.echo'), false);
  await closed.grant({ applicationId: 'app_1', qualifiedName: 'mcp.demo.echo' });
  assert.equal(await closed.allowed('app_1', 'mcp.demo.echo'), true);

  const open = new McpPermissions(memoryStore(), { accessMode: 'unrestricted' });
  assert.equal(await open.allowed('app_1', 'mcp.demo.echo'), true);
});
