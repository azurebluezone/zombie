import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopExecutor } from '../src/execution/tool-loop.js';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { EvidenceGate } from '../src/evidence/gate.js';

function prepared() {
  return { contract: { goal: 'say ok', expectedOutcome: 'the word ok' }, consent: { allowed: true } };
}

function memoryStore() {
  const data = new Map();
  return { async read(key, fallback = []) { return data.has(key) ? structuredClone(data.get(key)) : fallback; }, async write(key, value) { data.set(key, structuredClone(value)); } };
}

function providerFailure(id, { chunksBeforeFailure = 0, statusCode = 429 } = {}) {
  return {
    id,
    capabilities: { chatCompletions: true, streaming: true, functionCalling: false },
    streamChunk: raw => raw,
    async streamChat(input, onRaw) {
      for (let i = 0; i < chunksBeforeFailure; i += 1) {
        onRaw({ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] });
      }
      const error = new Error('provider_http_error');
      error.statusCode = statusCode;
      error.providerBody = { error: { message: 'quota exceeded for this model' } };
      throw error;
    }
  };
}

function healthyProvider(id, calls) {
  return {
    id,
    capabilities: { chatCompletions: true, streaming: true, functionCalling: false },
    streamChunk: raw => raw,
    async streamChat(input, onRaw) {
      calls.push(id);
      onRaw({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok from the fallback provider' }, finish_reason: null }] });
      onRaw({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
  };
}

function buildLoop({ providers, candidates, logs }) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  return new ToolLoopExecutor({
    providers: {
      async resolve(id) { const provider = byId.get(id); if (!provider) throw new Error('provider_not_found'); return provider; },
      async resolveModel() { return 'tiny'; }
    },
    router: {
      async route() {
        return {
          routeId: 'route_phase52',
          providerId: candidates[0].providerId,
          model: candidates[0].model,
          publicModel: 'zombie-mini',
          candidates,
          requiredCapabilities: ['chat-completions'],
          reason: 'explicit_model_alias',
          status: 'selected'
        };
      }
    },
    executionAdapter: { async execute() { return { ok: true }; } },
    normalizer: new CanonicalResponseNormalizer(),
    evidenceGate: new EvidenceGate({ store: memoryStore() }),
    logger: { async info(event, payload) { logs.push({ event, payload }); }, async warn(event, payload) { logs.push({ event, payload }); } }
  });
}

const loopInput = () => ({ goal: 'say ok', messages: [{ role: 'system', content: 'ZombieCoder test system prompt.' }, { role: 'user', content: 'say ok' }] });

test('phase52 streaming tool loop falls back to the next candidate when the first provider fails before any output', async () => {
  const logs = [];
  const calls = [];
  const loop = buildLoop({
    providers: [providerFailure('dead-provider', { statusCode: 429 }), healthyProvider('alive-provider', calls)],
    candidates: [{ providerId: 'dead-provider', model: 'tiny' }, { providerId: 'alive-provider', model: 'tiny' }],
    logs
  });
  const chunks = [];
  const events = [];
  const result = await loop.stream({
    prepared: prepared(),
    applicationId: 'app-a',
    input: loopInput(),
    onChunk: chunk => chunks.push(chunk),
    onEvent: event => events.push(event)
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.providerId, 'alive-provider', 'the loop must continue on the next candidate');
  assert.equal(result.response.choices[0].message.content, 'ok from the fallback provider');
  assert.equal(chunks.length, 2, 'the client must receive the answer from the fallback provider');
  // A token must travel on exactly one channel. The runtime event channel is a
  // progress marker only; mirroring the chunk there made clients that listened on
  // both channels receive every token twice (measured live, see phase72).
  const streamChunkEvents = events.filter(event => event.type === 'stream_chunk');
  assert.equal(streamChunkEvents.length, 2, 'one progress marker per delivered chunk');
  for (const event of streamChunkEvents) {
    assert.equal(event.chunk, undefined, 'a token must not be mirrored on the runtime event channel');
  }
  assert.equal(calls.length, 1, 'the healthy provider is used exactly once');

  const fallbackLog = logs.find(entry => entry.event === 'tool_loop.stream_candidate_failed');
  assert.ok(fallbackLog, 'the fallback must be recorded in the runtime log');
  assert.equal(fallbackLog.payload.providerId, 'dead-provider');
  assert.equal(fallbackLog.payload.statusCode, 429);
  assert.equal(fallbackLog.payload.upstreamReason, 'quota exceeded for this model');
  assert.ok(logs.some(entry => entry.event === 'execution.lifecycle.provider_fallback'), 'the lifecycle must record the provider failure');

  // The response stays masked even though a different provider answered.
  const body = JSON.stringify(result.response);
  for (const token of ['dead-provider', 'alive-provider', 'tiny']) {
    assert.ok(!body.includes(token), `the masked response must not contain ${token}`);
  }
  assert.equal(result.response.provider, 'ZombieCoder');
});

test('phase52 streaming tool loop never replays a round that already delivered output', async () => {
  const logs = [];
  const calls = [];
  const loop = buildLoop({
    providers: [providerFailure('dead-provider', { chunksBeforeFailure: 1 }), healthyProvider('alive-provider', calls)],
    candidates: [{ providerId: 'dead-provider', model: 'tiny' }, { providerId: 'alive-provider', model: 'tiny' }],
    logs
  });
  const chunks = [];
  await assert.rejects(
    () => loop.stream({ prepared: prepared(), applicationId: 'app-a', input: loopInput(), onChunk: chunk => chunks.push(chunk) }),
    /provider_http_error/
  );
  assert.equal(calls.length, 0, 'a partially streamed round must not be retried on another provider');
  assert.equal(chunks.length, 1, 'the partial chunk already reached the client');
  assert.equal(logs.some(entry => entry.event === 'tool_loop.stream_candidate_failed'), false);
});

test('phase52 streaming tool loop reports the last provider error when every candidate fails', async () => {
  const logs = [];
  const loop = buildLoop({
    providers: [providerFailure('dead-one'), providerFailure('dead-two', { statusCode: 503 })],
    candidates: [{ providerId: 'dead-one', model: 'tiny' }, { providerId: 'dead-two', model: 'tiny' }],
    logs
  });
  await assert.rejects(() => loop.stream({ prepared: prepared(), applicationId: 'app-a', input: loopInput() }), /provider_http_error/);
  assert.equal(logs.filter(entry => entry.event === 'tool_loop.stream_candidate_failed').length, 1, 'only the last-candidate failure is final');
  assert.equal(logs.filter(entry => entry.event === 'execution.lifecycle.provider_fallback').length, 1);
});
