import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/env.js';
import { compileContext } from '../src/context/compiler.js';
import { buildAgentSystemPrompt, COMPILED_CONTEXT_PROMPT_CHARS } from '../src/agents/system-prompt.js';

// The compiled context is embedded in the system prompt as JSON. If the compiler is
// allowed to produce more than the prompt can carry, `clean()` cuts the JSON at a
// character limit and the model is handed a document that does not parse. That is what
// a 192 KB budget did to a long conversation: 59,783 bytes compiled, cut at 24,000
// characters, invalid JSON.
const longConversation = () => Array.from({ length: 60 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `padding text ${i} `.repeat(60)
}));

test('phase64 the compiled context budget stays inside what the prompt can carry', () => {
  assert.ok(
    config.compiledContextBytes <= COMPILED_CONTEXT_PROMPT_CHARS,
    `COMPILED_CONTEXT_BYTES (${config.compiledContextBytes}) must not exceed the prompt cap (${COMPILED_CONTEXT_PROMPT_CHARS})`
  );
});

test('phase64 a long conversation still compiles to valid JSON inside the budget', () => {
  const compiled = compileContext({
    goal: 'x',
    recent: longConversation(),
    ssot: null,
    syllabus: null,
    memory: [],
    maxBytes: config.compiledContextBytes,
    recentLimit: 60
  });
  const json = JSON.stringify(compiled);
  assert.ok(
    Buffer.byteLength(json, 'utf8') <= config.compiledContextBytes,
    `compiled context exceeded its own budget: ${Buffer.byteLength(json, 'utf8')}`
  );
  assert.doesNotThrow(() => JSON.parse(json));
});

test('phase64 the prompt never truncates the compiled context it was given', () => {
  const compiled = compileContext({
    goal: 'x',
    recent: longConversation(),
    ssot: null,
    syllabus: null,
    memory: [],
    maxBytes: config.compiledContextBytes,
    recentLimit: 60
  });
  const prompt = buildAgentSystemPrompt({
    constitution: [],
    agent: { id: 'code-guru' },
    persona: { persona: 'test' },
    goal: 'x',
    compiledContext: compiled,
    route: { candidates: [{ nativeFunctionCalling: true }] },
    tools: [],
    toolCatalog: []
  });
  const block = prompt.slice(prompt.indexOf('COMPILED CONTEXT (JSON)'));
  assert.equal(block.includes('[truncated]'), false, 'the compiled context must arrive whole');
  // And the JSON inside the prompt is still parseable.
  const body = block.slice('COMPILED CONTEXT (JSON)\n'.length).split('\n\n')[0];
  assert.doesNotThrow(() => JSON.parse(body));
});

test('phase64 a smaller budget keeps the newest messages, not the oldest', () => {
  const compiled = compileContext({
    goal: 'x',
    recent: longConversation(),
    ssot: null,
    syllabus: null,
    memory: [],
    maxBytes: 8 * 1024,
    recentLimit: 60
  });
  assert.ok(compiled.recent.length > 0);
  const last = compiled.recent[compiled.recent.length - 1];
  assert.match(String(last.content), /padding text 59/);
});
