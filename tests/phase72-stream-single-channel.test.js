import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopExecutor } from '../src/execution/tool-loop.js';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { EvidenceGate } from '../src/evidence/gate.js';

/*
 * phase72 — a token must travel on exactly ONE channel.
 *
 * Measured live before this fix (autoToolLoop:true, 7 tokens):
 *   7 `data:` frames  -> "ALPHA BRAVO CHARLIE"
 *   7 `stream_chunk` runtime events -> "ALPHA BRAVO CHARLIE"   (identical mirror)
 *
 * A client that concatenated both channels, or listened on the runtime channel,
 * received every token twice. The `data:` frame is the token channel (the OpenAI
 * contract); runtime events are lifecycle/progress only. These tests pin that so
 * the mirror cannot come back unnoticed.
 */

function prepared() {
  return { contract: { goal: 'say the phrase', expectedOutcome: 'the phrase' }, consent: { allowed: true } };
}

function memoryStore() {
  const data = new Map();
  return {
    async read(key, fallback = []) { return data.has(key) ? structuredClone(data.get(key)) : fallback; },
    async write(key, value) { data.set(key, structuredClone(value)); }
  };
}

function buildLoop({ provider, logs = [] }) {
  return new ToolLoopExecutor({
    providers: {
      async resolve() { return provider; },
      async resolveModel() { return 'tiny'; }
    },
    router: {
      async route() {
        return {
          routeId: 'route_phase72',
          providerId: provider.id,
          model: 'tiny',
          publicModel: 'zombie-mini',
          candidates: [{ providerId: provider.id, model: 'tiny' }],
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

const loopInput = () => ({
  goal: 'say the phrase',
  messages: [{ role: 'system', content: 'ZombieCoder test system prompt.' }, { role: 'user', content: 'say the phrase' }]
});

const textOf = chunk => chunk?.choices?.[0]?.delta?.content ?? '';

test('phase72 a streamed token is delivered on the data channel and nowhere else', async () => {
  const tokens = ['ALPHA ', 'BRAVO ', 'CHARLIE'];
  const provider = {
    id: 'token-provider',
    capabilities: { chatCompletions: true, streaming: true, functionCalling: false },
    streamChunk: raw => raw,
    async streamChat(input, onRaw) {
      for (const token of tokens) {
        onRaw({ choices: [{ index: 0, delta: { role: 'assistant', content: token }, finish_reason: null }] });
      }
      onRaw({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
  };

  const chunks = [];
  const events = [];
  const result = await buildLoop({ provider }).stream({
    prepared: prepared(),
    applicationId: 'app-a',
    input: loopInput(),
    onChunk: chunk => chunks.push(chunk),
    onEvent: event => events.push(event)
  });

  assert.equal(result.status, 'completed');

  // 1. The token channel carries the answer exactly once.
  const dataText = chunks.map(textOf).join('');
  assert.equal(dataText, 'ALPHA BRAVO CHARLIE');

  // 2. No runtime event repeats that text, on any field.
  const runtimeText = JSON.stringify(events);
  assert.ok(!runtimeText.includes('ALPHA'), 'the runtime event channel must not repeat the answer');
  assert.ok(!runtimeText.includes('BRAVO'), 'the runtime event channel must not repeat the answer');

  // 3. The progress marker still fires (one per delivered chunk) but carries no payload.
  const markers = events.filter(event => event.type === 'stream_chunk');
  assert.equal(markers.length, chunks.length, 'one progress marker per delivered chunk');
  for (const marker of markers) {
    assert.equal(marker.chunk, undefined, 'the progress marker must not carry the chunk');
    assert.equal(typeof marker.round, 'number');
  }

  // 4. The anti-regression check itself: the two channels must not agree on content.
  const markerText = markers.map(marker => textOf(marker.chunk)).join('');
  assert.equal(markerText, '', 'concatenating the runtime channel must yield no text');
});

test('phase72 the non-streaming fallback also keeps the token on one channel', async () => {
  const provider = {
    id: 'silent-stream-provider',
    capabilities: { chatCompletions: true, streaming: true, functionCalling: false },
    streamChunk: raw => raw,
    // A 200 stream that emits no chunks forces the non-streaming fallback path.
    async streamChat() {},
    async chatCompletions() {
      return { choices: [{ index: 0, message: { role: 'assistant', content: 'FALLBACK ANSWER' }, finish_reason: 'stop' }] };
    },
    toCanonical(raw) { return raw; }
  };

  const chunks = [];
  const events = [];
  const result = await buildLoop({ provider }).stream({
    prepared: prepared(),
    applicationId: 'app-a',
    input: loopInput(),
    onChunk: chunk => chunks.push(chunk),
    onEvent: event => events.push(event)
  });

  assert.equal(result.status, 'completed');
  assert.equal(chunks.map(textOf).join(''), 'FALLBACK ANSWER');
  assert.ok(!JSON.stringify(events).includes('FALLBACK'), 'the runtime channel must not repeat the fallback answer');

  const markers = events.filter(event => event.type === 'stream_chunk');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].fallback, 'non-streaming-provider-response', 'the fallback reason survives without the chunk');
  assert.equal(markers[0].chunk, undefined);
});
