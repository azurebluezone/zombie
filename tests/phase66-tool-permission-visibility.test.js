import test from 'node:test';
import assert from 'node:assert/strict';
import { allowlistExclusions, warnAboutAllowlistExclusions } from '../src/startup/allowlist-guard.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { CapabilityConfigResolver } from '../src/registry/config-resolver.js';

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { async read(key, fallback) { return data.has(key) ? data.get(key) : fallback; }, async write(key, value) { data.set(key, value); } };
}

const recorder = () => {
  const events = [];
  return {
    events,
    async info(event, data) { events.push({ level: 'info', event, data }); },
    async warn(event, data) { events.push({ level: 'warn', event, data }); }
  };
};

// Adding a tool to the registry and forgetting ZOMBIECODER_TOOLS produced a runtime that
// refused the tool as `tool_not_permitted`, which reads exactly like a missing grant.
// Both halves of that are tested here: the guard that makes the exclusion visible, and the
// executor that now keeps the reason instead of discarding it.

test('phase66 an empty allowlist means no list-based restriction', () => {
  assert.deepEqual(allowlistExclusions('', ['read_file', 'note_store']), { configured: false, listedCount: 0, excluded: [] });
  assert.deepEqual(allowlistExclusions(undefined, ['read_file']).configured, false);
  assert.deepEqual(allowlistExclusions('  ,  ,', ['read_file']).configured, false);
});

test('phase66 a runnable tool missing from the allowlist is named', () => {
  const result = allowlistExclusions('read_file,list_directory', ['read_file', 'list_directory', 'note_store', 'write_file']);
  assert.equal(result.configured, true);
  assert.equal(result.listedCount, 2);
  assert.deepEqual(result.excluded, ['note_store', 'write_file']);
});

test('phase66 the exclusion is reported at boot, and a complete list is silent', async () => {
  const logger = recorder();
  const warned = await warnAboutAllowlistExclusions({
    allowList: 'read_file',
    runnableToolIds: ['read_file', 'note_store'],
    logger
  });
  assert.deepEqual(warned.excluded, ['note_store']);
  const event = logger.events.find((e) => e.event === 'tool.config_allowlist_excludes_runnable_tools');
  assert.ok(event, 'the exclusion must be logged');
  assert.equal(event.level, 'warn');
  assert.deepEqual(event.data.excluded, ['note_store']);
  assert.equal(event.data.envKey, 'ZOMBIECODER_TOOLS');

  const quiet = recorder();
  await warnAboutAllowlistExclusions({ allowList: 'read_file,note_store', runnableToolIds: ['read_file', 'note_store'], logger: quiet });
  assert.equal(quiet.events.length, 0, 'a complete allowlist must not warn');

  const unconfigured = recorder();
  await warnAboutAllowlistExclusions({ allowList: '', runnableToolIds: ['read_file', 'note_store'], logger: unconfigured });
  assert.equal(unconfigured.events.length, 0, 'an empty allowlist must not warn');
});

test('phase66 a refusal keeps its reason instead of reporting a bare "not permitted"', async () => {
  const store = memoryStore({ applications: [{ id: 'app_1', capabilities: {} }] });
  // The exact trap: the application is fine, but the tool is absent from the allowlist.
  const envObject = { ZOMBIECODER_TOOLS: 'read_file,list_directory' };
  const policy = new ToolPolicy(store, { configResolver: new CapabilityConfigResolver({ store, envObject }), accessMode: 'unrestricted' });
  const logger = recorder();
  const adapter = new ToolExecutionAdapter({ registry: { resolve: async () => ({ id: 'note_store' }) }, policy, logger });

  await assert.rejects(
    () => adapter.assertPermitted('app_1', 'note_store'),
    (error) => {
      assert.equal(error.message, 'tool_not_permitted', 'the public error contract is unchanged');
      assert.equal(error.reason, 'tool_disabled_by_configuration', 'but the reason is preserved');
      return true;
    }
  );
  const denial = logger.events.find((e) => e.event === 'tool.permission_denied');
  assert.ok(denial, 'the denial must be logged with its reason');
  assert.equal(denial.data.reason, 'tool_disabled_by_configuration');
  assert.equal(denial.data.settingSource, 'environment-list');
});

test('phase66 a permitted tool passes and a missing policy is not a refusal', async () => {
  const store = memoryStore({ applications: [{ id: 'app_1', capabilities: {} }] });
  const policy = new ToolPolicy(store, { configResolver: new CapabilityConfigResolver({ store, envObject: {} }), accessMode: 'unrestricted' });
  const logger = recorder();
  const adapter = new ToolExecutionAdapter({ registry: { resolve: async () => ({ id: 'read_file' }) }, policy, logger });
  await adapter.assertPermitted('app_1', 'read_file');
  assert.equal(logger.events.length, 0);

  const noPolicy = new ToolExecutionAdapter({ registry: { resolve: async () => ({ id: 'read_file' }) } });
  await noPolicy.assertPermitted('app_1', 'read_file');
});
