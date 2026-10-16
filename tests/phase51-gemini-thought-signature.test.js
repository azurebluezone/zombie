import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { assembleStreamToolCalls, assembleStreamAssistant } from '../src/execution/tool-loop.js';

const SIG = 'CtsBAQw51sc_signature_blob';

test('phase51 gemini adapter carries the thought signature out of a tool call', () => {
  const provider = new GeminiProvider({ apiKey: 'test-only' });
  const raw = {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ functionCall: { name: 'create_file', args: { path: 'a.txt' }, id: 'call_1' }, thoughtSignature: SIG }] }
    }]
  };
  const canonical = provider.toCanonical(raw);
  const call = canonical.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, 'create_file');
  assert.equal(call.thoughtSignature, SIG);

  const chunk = provider.streamChunk(raw);
  assert.equal(chunk.choices[0].delta.tool_calls[0].thoughtSignature, SIG);
});

test('phase51 gemini adapter replays the signature on the assistant turn', () => {
  const provider = new GeminiProvider({ apiKey: 'test-only' });
  const payload = provider.payload({
    messages: [
      { role: 'user', content: 'create a.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', thoughtSignature: SIG, function: { name: 'create_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'create_file', content: '{"ok":true}' }
    ]
  });
  const modelTurn = payload.contents.find(c => c.role === 'model');
  assert.ok(modelTurn, 'assistant turn must be sent back to gemini');
  assert.equal(modelTurn.parts[0].thoughtSignature, SIG);
  assert.equal(modelTurn.parts[0].functionCall.name, 'create_file');
  assert.equal('thoughtSignature' in modelTurn.parts[0].functionCall, false, 'the signature belongs to the part, not to functionCall');
});

test('phase51 normalizer keeps the signature on messages and stream deltas', () => {
  const normalizer = new CanonicalResponseNormalizer();
  const message = normalizer.normalize({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', thoughtSignature: SIG, function: { name: 'create_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, { model: 'm', providerId: 'p' });
  assert.equal(message.choices[0].message.tool_calls[0].thoughtSignature, SIG);

  const delta = normalizer.normalize({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', thoughtSignature: SIG, function: { name: 'create_file', arguments: '{}' } }] }, finish_reason: null }] }, { model: 'm', providerId: 'p' });
  assert.equal(delta.choices[0].delta.tool_calls[0].thoughtSignature, SIG);
});

test('phase51 streamed tool call assembly carries the signature into the assistant turn', () => {
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', thoughtSignature: SIG, function: { name: 'create_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: null }] }
  ];
  const calls = assembleStreamToolCalls(chunks);
  assert.equal(calls[0].thoughtSignature, SIG);
  const assistant = assembleStreamAssistant(chunks);
  assert.equal(assistant.tool_calls[0].thoughtSignature, SIG);
  // The replay sanitiser must not drop the echo token either.
  assert.equal('index' in assistant, true);
});
