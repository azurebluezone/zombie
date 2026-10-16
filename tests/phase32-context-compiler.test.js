import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContext, validateCompiledContext } from '../src/context/compiler.js';

test('phase32 compiler keeps recent messages bounded and selects relevant SSOT/syllabus/memory', () => {
  const result = compileContext({
    goal: 'fix Laravel checkout port and working directory',
    recent: Array.from({length: 20}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: `message-${i}`})),
    memory: [
      {content:'old unrelated marketing note'},
      {content:'Laravel checkout working directory is /srv/shop/current'},
      {content:'database stock is authoritative'}
    ],
    ssot: {path:'/srv/shop/.zombiecoder/SSOT.md', content:'# Project SSOT\n\n- Root: /srv/shop\n\n## Detected Technologies\n- Laravel\n\n## Project Structure\n- app/\n- routes/\n\n## Checkout\n- checkout flow lives in app/Http/Controllers\n\n## Unrelated\n- legacy notes'},
    syllabus: {content:'# Agent Knowledge Syllabus\n\n## Laravel Checkout\n- Source: project\n- Summary: checkout validation and stock evidence\n\n## Marketing\n- Source: old\n- Summary: ads'},
    projectRoot:'/srv/shop', workingDirectory:'/srv/shop/current', maxBytes: 64 * 1024
  });
  assert.equal(result.recent.length, 10);
  assert.equal(result.facts.workingDirectory, '/srv/shop/current');
  assert.ok(result.ssot.sections.some(x => /checkout/i.test(x.title)));
  assert.ok(result.syllabus.some(x => /laravel checkout/i.test(x.topic)));
  assert.ok(result.memory.some(x => /working directory/i.test(x.content)));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.equal(validateCompiledContext(result), true);
});

test('phase32 compiler rejects a working directory outside project root', () => {
  assert.throws(() => compileContext({goal:'test', projectRoot:'/srv/shop', workingDirectory:'/srv/shop-old'}), /outside_project/);
});

test('phase32 compiler fails closed when its compiled package is invalid', () => {
  assert.throws(() => validateCompiledContext({}), /compiled_context/);
});
