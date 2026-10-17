import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContext } from '../src/context/compiler.js';

// A real SSOT looks like this: a short "Detected Technologies" section, and one very
// large file listing. The listing is what made the prompt balloon — an ordinary query
// word that happens to appear in a filename ("evidence" matching src/context/evidence.js)
// pulled the whole thing in.
const LISTING = Array.from({ length: 200 }, (_, i) => `- src/module-${i}/file-${i}.js`).join('\n');
const CHECKOUT = Array.from({ length: 40 }, (_, i) => `- checkout rule ${i} lives in app/Http/Controllers/Checkout${i}.php`).join('\n');

const SSOT = [
  '# Project SSOT',
  '',
  '## Detected Technologies',
  '- Node.js',
  '',
  '## Project Structure',
  '- src/context/evidence.js',
  LISTING,
  '',
  '## Checkout',
  CHECKOUT,
  '',
  '## Unrelated',
  '- legacy notes'
].join('\n');

const compile = (goal) => compileContext({ goal, ssot: { content: SSOT }, maxBytes: 64 * 1024 });
const size = (c) => Buffer.byteLength(JSON.stringify(c), 'utf8');
const section = (c, re) => c.ssot.sections.find((s) => re.test(s.title));

test('phase62 a body-only match cannot drag a whole listing into the prompt', () => {
  const c = compile('evidence');
  const structure = section(c, /project structure/i);
  assert.ok(structure, 'the section is still selected — the match is real, just weak');
  assert.ok(
    structure.content.length <= 800,
    `a body-only match must stay inside its budget, got ${structure.content.length} chars`
  );
});

test('phase62 repeating a query word does not inflate how much context is injected', () => {
  // The score used to count a word once per occurrence, so pasting a word repeatedly
  // bought the section a bigger budget. Relevance must not depend on repetition.
  const once = compile('evidence');
  const repeated = compile('evidence '.repeat(20));
  assert.equal(size(repeated), size(once));
  assert.deepEqual(
    repeated.ssot.sections.map((s) => s.title),
    once.ssot.sections.map((s) => s.title)
  );
});

test('phase62 a title match keeps the full section budget', () => {
  const c = compile('fix the checkout validation');
  const checkout = section(c, /checkout/i);
  assert.ok(checkout, 'a title match selects the section');
  assert.equal(checkout.content.length, CHECKOUT.length, 'a title match is not truncated');
});

test('phase62 an unrelated query does not select the listing at all', () => {
  const c = compile('zzz');
  assert.equal(section(c, /project structure/i), undefined);
});

test('phase62 the sections the caller always wants survive any query', () => {
  const c = compile('zzz');
  assert.ok(section(c, /project ssot/i));
  assert.ok(section(c, /detected technologies/i));
});
