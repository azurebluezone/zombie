import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../src/providers/registry.js';
import { bootstrapProviders } from '../src/startup/provider-bootstrap.js';

// The wording "local" made a real, OpenAI-compatible endpoint read as a throwaway
// toy to anyone skimming the config. It was removed, but a deployment that is
// already running still has the old names in .env and in the database. These tests
// pin the compatibility layer that keeps those deployments working.

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { async read(k, d) { return data.has(k) ? data.get(k) : d; }, async write(k, v) { data.set(k, v); } };
}

function captureLogger() {
  const entries = [];
  return { entries, info: async (event, payload) => entries.push({ event, payload }), warn: async (event, payload) => entries.push({ event, payload }) };
}

test('phase59 the legacy provider key variable still authenticates the renamed provider', async () => {
  const { resolveProviderApiKeys } = await import('../src/config/env.js');
  // A deployment that only has the old variable name is not left unauthenticated.
  const legacy = resolveProviderApiKeys({ PROVIDER_KEY_OLLAMA_LOCAL: 'legacy-secret' });
  assert.equal(legacy['ollama-selfhosted'], 'legacy-secret');
  assert.equal(legacy['ollama-local'], undefined);
  // The explicit new name wins when both are present, whichever order they load in.
  const a = resolveProviderApiKeys({ PROVIDER_KEY_OLLAMA_SELFHOSTED: 'new-secret', PROVIDER_KEY_OLLAMA_LOCAL: 'legacy-secret' });
  const b = resolveProviderApiKeys({ PROVIDER_KEY_OLLAMA_LOCAL: 'legacy-secret', PROVIDER_KEY_OLLAMA_SELFHOSTED: 'new-secret' });
  assert.equal(a['ollama-selfhosted'], 'new-secret');
  assert.equal(b['ollama-selfhosted'], 'new-secret');
  // Unrelated providers are untouched by the alias pass.
  const other = resolveProviderApiKeys({ PROVIDER_KEY_GROQ: 'g', PROVIDER_KEY_GEMINI: 'm' });
  assert.equal(other.groq, 'g');
  assert.equal(other.gemini, 'm');
});

test('phase59 the legacy auth bypass variable still enables the loopback bypass', async () => {
  const savedLoopback = process.env.LOOPBACK_AUTH_BYPASS;
  const savedLegacy = process.env.LOCAL_AUTH_BYPASS;
  const savedLoader = process.env.ENV_LOADER_ENABLED;
  try {
    delete process.env.LOOPBACK_AUTH_BYPASS;
    process.env.LOCAL_AUTH_BYPASS = 'true';
    process.env.ENV_LOADER_ENABLED = 'false';
    // A fresh module instance so the module-level config is recomputed.
    const legacyOnly = await import(`../src/config/env.js?case=legacy-only`);
    assert.equal(legacyOnly.config.loopbackAuthBypass, true);
    assert.equal(legacyOnly.config.localAuthBypass, undefined);

    process.env.LOOPBACK_AUTH_BYPASS = 'false';
    const explicitWins = await import(`../src/config/env.js?case=explicit-wins`);
    assert.equal(explicitWins.config.loopbackAuthBypass, false);
  } finally {
    if (savedLoopback === undefined) delete process.env.LOOPBACK_AUTH_BYPASS; else process.env.LOOPBACK_AUTH_BYPASS = savedLoopback;
    if (savedLegacy === undefined) delete process.env.LOCAL_AUTH_BYPASS; else process.env.LOCAL_AUTH_BYPASS = savedLegacy;
    if (savedLoader === undefined) delete process.env.ENV_LOADER_ENABLED; else process.env.ENV_LOADER_ENABLED = savedLoader;
  }
});

test('phase59 boot retires a stored provider id the seed no longer declares', async () => {
  const store = memoryStore({ providers: [{
    id: 'ollama-local', name: 'Ollama Local', baseUrl: 'http://127.0.0.1:11434/v1',
    driver: 'ollama', protocol: 'openai-compatible', enabled: true, priority: 1,
    models: [], defaultModel: '', capabilities: ['chat-completions']
  }] });
  const registry = new ProviderRegistry(store, {});
  const logger = captureLogger();
  await bootstrapProviders({ registry, config: {}, logger, bootConfig: [{
    id: 'ollama-selfhosted', name: 'Ollama Self-Hosted', baseUrl: 'http://127.0.0.1:11434/v1',
    driver: 'ollama', protocol: 'openai-compatible', enabled: true, priority: 1, capabilities: ['chat-completions']
  }] });
  // No phantom row: the renamed provider is the only one the console will list.
  assert.deepEqual((await registry.list()).map(p => p.id), ['ollama-selfhosted']);
  assert.equal(logger.entries.some(e => e.event === 'provider.legacy_id_retired'), true);
});

test('phase59 boot leaves a legacy provider id alone while the seed still declares it', async () => {
  const store = memoryStore({ providers: [{
    id: 'ollama-local', name: 'Operator Named This', baseUrl: 'http://127.0.0.1:11434/v1',
    driver: 'ollama', protocol: 'openai-compatible', enabled: true, priority: 1,
    models: [], defaultModel: '', capabilities: ['chat-completions']
  }] });
  const registry = new ProviderRegistry(store, {});
  const logger = captureLogger();
  // The operator's own PROVIDER_CONFIG_JSON still names it: that is a deliberate
  // configuration, not a leftover from the rename.
  await bootstrapProviders({ registry, config: {}, logger, bootConfig: [{
    id: 'ollama-local', name: 'Operator Named This', baseUrl: 'http://127.0.0.1:11434/v1',
    driver: 'ollama', protocol: 'openai-compatible', enabled: true, priority: 1, capabilities: ['chat-completions']
  }] });
  assert.deepEqual((await registry.list()).map(p => p.id), ['ollama-local']);
  assert.equal(logger.entries.some(e => e.event === 'provider.legacy_id_retired'), false);
});
