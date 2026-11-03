import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalResponseNormalizer, normalizeFinishReason } from '../src/providers/normalizer/canonical-response.js';
import { isPublicModelName, maskCanonicalResponse, maskModelName, maskRouteForPublic } from '../src/providers/masking/provider-mask.js';
import { isSupportedProtocolVersion } from '../src/mcp/server.js';

// ---------------------------------------------------------------------------
// Normalizer: terminal reasons must be OpenAI-compatible and must never hide a
// tool call. This was observed live against Gemini and Ollama Cloud native:
// both returned a valid functionCall together with finish_reason "stop".
// ---------------------------------------------------------------------------

test('phase83 gemini functionCall with finishReason STOP becomes finish_reason tool_calls', () => {
  const canonical = new CanonicalResponseNormalizer().normalize({
    candidates: [{
      content: { parts: [{ functionCall: { name: 'echo', args: { value: '7' } } }] },
      finishReason: 'STOP'
    }]
  }, { model: 'gemini-2.5-flash', providerId: 'gemini' });

  const choice = canonical.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls[0].function.name, 'echo');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { value: '7' });
});

test('phase83 openai-shaped tool call with finish_reason stop is corrected', () => {
  const canonical = new CanonicalResponseNormalizer().normalize({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"7"}' } }]
      },
      finish_reason: 'stop'
    }]
  }, { model: 'gpt-oss:20b', providerId: 'ollama' });

  assert.equal(canonical.choices[0].finish_reason, 'tool_calls');
});

test('phase83 streaming tool-call delta with finish_reason stop is corrected', () => {
  const canonical = new CanonicalResponseNormalizer().normalize({
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"7"}' } }] },
      finish_reason: 'stop'
    }]
  }, { model: 'gpt-oss:20b', providerId: 'ollama' });

  assert.equal(canonical.choices[0].finish_reason, 'tool_calls');
  assert.equal(canonical.choices[0].delta.tool_calls[0].function.name, 'echo');
});

test('phase83 provider terminal reasons map to the OpenAI enum', () => {
  assert.equal(normalizeFinishReason('STOP'), 'stop');
  assert.equal(normalizeFinishReason('MAX_TOKENS'), 'length');
  assert.equal(normalizeFinishReason('max_output_tokens'), 'length');
  assert.equal(normalizeFinishReason('SAFETY'), 'content_filter');
  assert.equal(normalizeFinishReason('PROHIBITED_CONTENT'), 'content_filter');
  assert.equal(normalizeFinishReason('end_turn'), 'stop');
  assert.equal(normalizeFinishReason('tool_use'), 'tool_calls');
  assert.equal(normalizeFinishReason(null), null, 'an unfinished chunk stays null');
  assert.equal(normalizeFinishReason(null, true), 'tool_calls');
  assert.equal(normalizeFinishReason('STOP', true), 'tool_calls');
});

test('phase83 anthropic tool_use blocks are no longer dropped', () => {
  const canonical = new CanonicalResponseNormalizer().normalize({
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { value: '7' } }
    ],
    stop_reason: 'tool_use'
  }, { model: 'claude-test', providerId: 'anthropic' });

  const choice = canonical.choices[0];
  assert.equal(choice.message.content, 'checking');
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.tool_calls[0].function.name, 'echo');
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { value: '7' });
});

// ---------------------------------------------------------------------------
// Masking: only runtime-issued aliases may appear in a public payload.
// ---------------------------------------------------------------------------

test('phase83 maskModelName refuses real upstream model names', () => {
  for (const real of ['gpt-oss:20b', 'gemini-2.5-flash', 'qwen2.5:1.5b', 'openai/gpt-oss-20b', 'deepseek-v4-pro:0813']) {
    assert.equal(maskModelName({ agentId: 'code-guru', configuredName: real }), 'zombiecoder/code-guru', `${real} leaked`);
  }
  assert.equal(maskModelName({ agentId: 'bug-hunter', configuredName: 'zombie-mini' }), 'zombie-mini');
  assert.equal(maskModelName({ agentId: 'bug-hunter', configuredName: 'zombiecoder/bug-hunter' }), 'zombiecoder/bug-hunter');
  assert.equal(isPublicModelName('zombie-lite'), true);
  assert.equal(isPublicModelName('gemini-2.5-flash'), false);
});

test('phase83 maskCanonicalResponse never echoes a configured real model', () => {
  const masked = maskCanonicalResponse({
    id: 'chatcmpl-2',
    object: 'chat.completion',
    model: 'gpt-oss:20b',
    provider: 'ollama-cloud',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
  }, { agentId: 'qa-tyrant', configuredModel: 'gpt-oss:20b' });

  assert.equal(masked.model, 'zombiecoder/qa-tyrant');
  assert.equal(masked.provider, 'ZombieCoder');
  const text = JSON.stringify(masked);
  assert.equal(text.includes('gpt-oss'), false, 'the upstream model leaked into the response');
  assert.equal(text.includes('ollama-cloud'), false, 'the upstream provider leaked into the response');
});

test('phase83 maskRouteForPublic drops an invalid public model instead of leaking the route model', () => {
  const masked = maskRouteForPublic({
    routeId: 'route_2',
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
    publicModel: 'gemini-2.5-flash',
    candidates: [{ providerId: 'gemini', model: 'gemini-2.5-flash' }]
  }, { publicModel: 'gemini-2.5-flash' });

  assert.equal(masked.model, null);
  assert.equal(masked.publicModel, null);
  assert.equal(JSON.stringify(masked).includes('gemini'), false);

  const alias = maskRouteForPublic({ publicModel: 'zombie-mini', candidates: [] });
  assert.equal(alias.model, 'zombie-mini');
});

test('phase83 MCP protocol versions are checked against the supported set', () => {
  assert.equal(isSupportedProtocolVersion('2025-11-25'), true);
  assert.equal(isSupportedProtocolVersion('2024-11-05'), true);
  assert.equal(isSupportedProtocolVersion('1999-01-01'), false);
  assert.equal(isSupportedProtocolVersion(undefined), false);
});
