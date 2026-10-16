import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelIds } from '../src/providers/model-catalog.js';
import { ProviderExecutionAdapter } from '../src/execution/provider-adapter.js';

class Store {
  constructor(data = {}) { this.data = new Map(Object.entries(data)); }
  async read(k, fallback = []) { return structuredClone(this.data.has(k) ? this.data.get(k) : fallback); }
  async write(k, value) { this.data.set(k, structuredClone(value)); }
}

test('model catalog accepts OpenAI-compatible data and removes duplicates', () => {
  const ids = extractModelIds({data:[{id:'llama3.1:8b'},{id:'qwen2.5:3b'},{id:'llama3.1:8b'}]});
  assert.deepEqual(ids, ['llama3.1:8b','qwen2.5:3b']);
});

test('model catalog accepts Ollama-style models field', () => {
  const ids = extractModelIds({models:[{name:'llama3.1:8b'}]});
  assert.deepEqual(ids, ['llama3.1:8b']);
});

test('provider execution never crosses consent boundary', async () => {
  const adapter = new ProviderExecutionAdapter({
    providers: { resolve: async () => { throw new Error('provider_should_not_be_called'); } },
    normalizer: null
  });
  await assert.rejects(
    () => adapter.execute({prepared:{contract:{goal:'run model'},consent:{allowed:false}},input:{}}),
    /execution_consent_required/
  );
});
