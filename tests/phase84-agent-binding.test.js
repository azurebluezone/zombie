import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentModelBindings } from '../src/config/env.js';
import { legacyModelList } from '../src/compatibility/legacy/frontend-contract.js';
import { SmartRouter } from '../src/providers/router/smart-router.js';
import { maskCanonicalResponse } from '../src/providers/masking/provider-mask.js';

const binding = {agent: 'code-guru', provider: 'ollama-selfhosted', model: 'zombie-classic'};

test('phase84 a public agent model requires the zombiecoder/<agent> shape', () => {
  const parsed = parseAgentModelBindings(JSON.stringify({'zombiecoder/code-guru': binding}));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.bindings['zombiecoder/code-guru'], binding);
  assert.match(parseAgentModelBindings('{"code-guru":{"model":"zombie-classic"}}').errors[0], /public model/);
  assert.match(parseAgentModelBindings('{"zombiecoder/code-guru":{}}').errors[0], /model is required/);
  assert.match(parseAgentModelBindings('nope').errors[0], /not valid JSON/);
});

test('phase84 /v1/models lists the bound agent model before the generic aliases', () => {
  const list = legacyModelList({
    agents: [{id: 'code-guru'}],
    providers: [{id: 'ollama-selfhosted', enabled: true, models: ['qwen2.5:1.5b'], defaultModel: 'qwen2.5:1.5b', modelAliases: {'zombie-classic': 'qwen2.5:1.5b'}}],
    bindings: {'zombiecoder/code-guru': binding}
  });
  assert.equal(list.data[0].id, 'zombiecoder/code-guru');
  assert.ok(list.data.some(model => model.id === 'zombie-classic'));
});

test('phase84 the router echoes the bound public model, not the provider alias', async () => {
  const providers = {
    async list() {
      return [{
        id: 'ollama-selfhosted',
        enabled: true,
        models: ['qwen2.5:1.5b'],
        defaultModel: 'qwen2.5:1.5b',
        modelAliases: {'zombie-classic': 'qwen2.5:1.5b'},
        capabilities: ['chat-completions', 'streaming', 'function-calling'],
        priority: 1
      }];
    }
  };
  const router = new SmartRouter({providers});
  const route = await router.route({
    provider: 'ollama-selfhosted',
    model: 'zombie-classic',
    meta: {agentModelBinding: {publicModel: 'zombiecoder/code-guru'}}
  });
  assert.equal(route.providerId, 'ollama-selfhosted');
  assert.equal(route.model, 'qwen2.5:1.5b');
  assert.equal(route.publicModel, 'zombiecoder/code-guru');
});

test('phase84 masking keeps a bound agent model and drops the upstream model', () => {
  const masked = maskCanonicalResponse({
    id: 'chatcmpl-1',
    model: 'qwen2.5:1.5b',
    provider: 'ollama-selfhosted',
    choices: [{index: 0, message: {role: 'assistant', content: 'OK'}, finish_reason: 'stop'}]
  }, {agentId: 'code-guru', configuredModel: 'zombiecoder/code-guru'});
  assert.equal(masked.model, 'zombiecoder/code-guru');
  assert.equal(masked.provider, 'ZombieCoder');
  assert.equal(JSON.stringify(masked).includes('qwen2.5'), false);
  assert.equal(JSON.stringify(masked).includes('ollama-selfhosted'), false);
});
