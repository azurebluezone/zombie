import test from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiSchema, toGeminiParameters, resolvePointer, GEMINI_SCHEMA_SUPPORT } from '../src/providers/adapters/gemini-schema.js';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';

const REJECTED = new Set(GEMINI_SCHEMA_SUPPORT.rejected);

function collectKeys(node, acc = new Set()) {
  if (Array.isArray(node)) { for (const item of node) collectKeys(item, acc); return acc; }
  if (!node || typeof node !== 'object') return acc;
  for (const [key, value] of Object.entries(node)) { acc.add(key); collectKeys(value, acc); }
  return acc;
}

test('phase53 resolvePointer walks local JSON pointers', () => {
  const root = { $defs: { node: { type: 'object' } }, properties: { a: { type: 'string' } } };
  assert.equal(resolvePointer(root, '#'), root);
  assert.deepEqual(resolvePointer(root, '#/$defs/node'), { type: 'object' });
  assert.deepEqual(resolvePointer(root, '#/properties/a'), { type: 'string' });
  assert.equal(resolvePointer(root, '#/$defs/missing'), undefined);
  assert.equal(resolvePointer(root, 'https://example.com/x'), undefined);
});

test('phase53 inlines $ref so the referenced structure still reaches the model', () => {
  const schema = {
    type: 'object',
    properties: { node: { $ref: '#/$defs/node' } },
    $defs: { node: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }
  };
  const out = toGeminiSchema(schema);
  assert.equal('$ref' in out.properties.node, false, '$ref must never be sent to gemini');
  assert.equal('$defs' in out, false, '$defs has no gemini equivalent and is now unused');
  assert.equal(out.properties.node.type, 'object');
  assert.deepEqual(out.properties.node.properties, { value: { type: 'string' } });
  assert.deepEqual(out.properties.node.required, ['value']);
});

test('phase53 follows a $ref chain and merges sibling keywords', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/one', description: 'local description' } },
    $defs: { one: { $ref: '#/$defs/two' }, two: { type: 'string', enum: ['x'] } }
  };
  const out = toGeminiSchema(schema);
  assert.equal(out.properties.a.type, 'string');
  assert.deepEqual(out.properties.a.enum, ['x']);
  assert.equal(out.properties.a.description, 'local description');
});

test('phase53 stops on a recursive schema and keeps the shape only', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      children: { type: 'array', items: { $ref: '#' } }
    }
  };
  const out = toGeminiSchema(schema);
  const keys = collectKeys(out);
  assert.equal(keys.has('$ref'), false, 'a recursive schema must not send $ref');
  const child = out.properties.children.items;
  assert.equal(child.type, 'object', 'the cycle collapses to the shape');
  assert.equal(JSON.stringify(out).length < 4000, true, 'expansion must stay bounded');
  // exactly one level of expansion: children.items.children collapses to a shape
  assert.equal(child.properties.children.items.type, 'object');
});

test('phase53 collapses a repeated type (the provider rejects a list)', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: {
      a: { type: ['string', 'null'] },
      b: { type: ['string', 'number'] },
      c: { type: ['null'] }
    }
  });
  assert.deepEqual(out.properties.a, { type: 'string', nullable: true });
  assert.deepEqual(out.properties.b, { anyOf: [{ type: 'string' }, { type: 'number' }] });
  assert.deepEqual(out.properties.c, {}, 'a null-only property keeps no type');
});

test('phase53 rewrites const as enum and keeps the original enum untouched', () => {
  const out = toGeminiSchema({ type: 'object', properties: { mode: { type: 'string', const: 'fast' }, pick: { type: 'string', enum: ['a', 'b'] } } });
  assert.deepEqual(out.properties.mode, { type: 'string', enum: ['fast'] });
  assert.deepEqual(out.properties.pick, { type: 'string', enum: ['a', 'b'] });
});

test('phase53 drops only keywords the provider rejects, never properties or required', () => {
  const createFile = COMMON_TOOLS.find(tool => tool.id === 'create_file');
  const out = toGeminiSchema(createFile.metadata.toolSchema);
  assert.deepEqual(out, {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content']
  });
});

test('phase53 infers a missing type from properties or items', () => {
  const out = toGeminiSchema({ properties: { a: { type: 'string' } } });
  assert.equal(out.type, 'object');
  const arrayOut = toGeminiSchema({ items: { type: 'string' }, minItems: 1 });
  assert.equal(arrayOut.type, 'array');
});

test('phase53 turns a boolean schema into an empty schema', () => {
  assert.deepEqual(toGeminiSchema({ type: 'object', properties: { a: true } }).properties.a, {});
});

test('phase53 turns a draft-07 tuple `items` list into a single schema', () => {
  const out = toGeminiSchema({ type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } });
  assert.deepEqual(out.properties.pair.items, { anyOf: [{ type: 'string' }, { type: 'number' }] });
  const single = toGeminiSchema({ type: 'object', properties: { one: { type: 'array', items: [{ type: 'string' }] } } });
  assert.deepEqual(single.properties.one.items, { type: 'string' });
});

test('phase53 drops a nested rejected keyword at any depth', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: {
      list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } },
      tuple: { type: 'array', prefixItems: [{ type: 'string' }], uniqueItems: true }
    }
  });
  const keys = collectKeys(out);
  for (const key of keys) assert.equal(REJECTED.has(key), false, `${key} must not reach gemini`);
  assert.equal(out.properties.tuple.type, 'array');
});

test('phase53 every native tool schema translates to a provider-accepted keyword set', () => {
  for (const tool of COMMON_TOOLS) {
    const schema = tool.metadata?.toolSchema;
    if (!schema) continue;
    const out = toGeminiParameters(schema);
    const keys = collectKeys(out);
    for (const key of keys) assert.equal(REJECTED.has(key), false, `${tool.id}: ${key} is rejected by gemini`);
    assert.equal(Array.isArray(out.type), false, `${tool.id}: type must not be a list`);
    if (schema.properties && Object.keys(schema.properties).length) {
      assert.ok(out.properties, `${tool.id}: properties must survive translation`);
    }
  }
});

test('phase53 the gemini payload carries the translated tool schema', () => {
  const provider = new GeminiProvider({ apiKey: 'test-only' });
  const createFile = COMMON_TOOLS.find(tool => tool.id === 'create_file');
  const payload = provider.payload({
    messages: [{ role: 'user', content: 'create notes.txt' }],
    tools: [{ type: 'function', function: { name: 'create_file', description: 'Create a file', parameters: createFile.metadata.toolSchema } }]
  });
  const declaration = payload.tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'create_file');
  assert.deepEqual(declaration.parameters.properties, { path: { type: 'string' }, content: { type: 'string' } });
  assert.deepEqual(declaration.parameters.required, ['path', 'content']);
  assert.equal('additionalProperties' in declaration.parameters, false);
});

test('phase53 the gemini payload never contains $ref or a repeated type for MCP-style schemas', () => {
  const provider = new GeminiProvider({ apiKey: 'test-only' });
  const parameters = {
    type: 'object',
    properties: {
      target: { $ref: '#/$defs/target' },
      mode: { type: ['string', 'null'], const: 'safe' }
    },
    $defs: { target: { type: 'object', properties: { id: { type: ['string', 'null'] } } } }
  };
  const payload = provider.payload({ messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'probe', parameters } }] });
  const sent = payload.tools[0].functionDeclarations[0].parameters;
  assert.equal(JSON.stringify(sent).includes('$ref'), false);
  assert.equal(JSON.stringify(sent).includes('$defs'), false);
  assert.deepEqual(sent.properties.target, { type: 'object', properties: { id: { type: 'string', nullable: true } } });
  assert.deepEqual(sent.properties.mode, { type: 'string', nullable: true, enum: ['safe'] });
});
