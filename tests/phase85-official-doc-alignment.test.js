import test from 'node:test';
import assert from 'node:assert/strict';
import { toNativeMessages } from '../src/providers/adapters/ollama.js';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';

// Official Ollama tool-calling docs:
// {"role":"tool","tool_name":"get_temperature","content":"22°C"}
test('phase85 ollama native tool result keeps the tool name the docs require', () => {
  const messages = toNativeMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_temperature', arguments: '{"city":"New York"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_temperature', content: '22°C' }
  ]);
  assert.deepEqual(messages[0].tool_calls, [{
    type: 'function',
    function: { index: 0, name: 'get_temperature', arguments: { city: 'New York' } }
  }]);
  assert.deepEqual(messages[1], { role: 'tool', content: '22°C', tool_name: 'get_temperature' });
  assert.equal('tool_call_id' in messages[1], false, 'native Ollama matches tool results by name, not OpenAI id');
});

// Official Gemini FunctionResponse docs: `response` is a JSON object (Struct).
// A plain string must be wrapped, otherwise generateContent returns HTTP 400.
test('phase85 gemini functionResponse wraps plain-text results and keeps the call id', () => {
  const provider = new GeminiProvider({ apiKey: 'test-only' });
  const payload = provider.payload({
    messages: [
      { role: 'user', content: 'temperature?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_temperature', arguments: '{"city":"New York"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_temperature', content: '"22°C"' }
    ]
  });
  const toolTurn = payload.contents.find(item => item.parts?.some(part => part.functionResponse));
  assert.deepEqual(toolTurn.parts[0].functionResponse, {
    name: 'get_temperature',
    response: { result: '22°C' },
    id: 'call_1'
  });
});

test('phase85 gemini functionResponse passes JSON objects through unchanged', () => {
  const provider = new GeminiProvider({ apiKey: 'test-only' });
  const payload = provider.payload({
    messages: [{ role: 'tool', tool_call_id: 'call_2', name: 'echo', content: '{"ok":true}' }]
  });
  assert.deepEqual(payload.contents[0].parts[0].functionResponse.response, { ok: true });
});
