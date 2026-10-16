import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// The chat page shipped with a stream handler written for event shapes the runtime
// never emits (`type:'round'`, `type:'tool'`). Every tool loop therefore rendered an
// empty rounds/tools chip even while a tool really ran, and the page reported a
// green "ok" for a run the evidence gate had left unverified. These tests pin the
// contract between the two files.

test('phase61 the chat page handles the tool-loop events the runtime emits', async () => {
  const page = await read('public/chat.html');
  const loop = await read('src/execution/tool-loop.js');
  const server = await read('src/server.js');

  const emitted = new Set([...loop.matchAll(/onEvent\?\.\(\{\s*type:\s*'([a-z_]+)'/g)].map(m => m[1]));
  const serverEmitted = new Set([...server.matchAll(/type:'([a-z_]+)'/g)].map(m => m[1]));

  // The runtime really does emit these; if that changes, this test should fail.
  assert.equal(emitted.has('tool_result'), true, 'the tool loop emits tool_result');
  assert.equal(emitted.has('tool_error'), true, 'the tool loop emits tool_error');
  assert.equal(serverEmitted.has('complete'), true, 'the server emits a terminal complete event');

  // ...so the page must consume them.
  for (const type of ['tool_result', 'tool_error', 'complete']) {
    assert.equal(page.includes(`'${type}'`), true, `chat.html must handle the ${type} event`);
  }

  // And it must not still be waiting for a shape nothing produces.
  assert.equal(page.includes("j.type === 'round'"), false);
  assert.equal(page.includes("j.type === 'tool'"), false);
});

test('phase61 the chat page can actually ask for an agentic run', async () => {
  const page = await read('public/chat.html');
  // Without these the page was a plain chat: no agent was named and the runtime was
  // never asked to run the tool loop, so the "give an agent a task" journey did not
  // exist in any UI.
  assert.match(page, /request\.autoToolLoop = true/);
  assert.match(page, /request\.consent = true/);
  assert.match(page, /request\.agent = agent/);
  // Tools are opt-in, so a first-time user cannot trigger file edits by accident.
  assert.match(page, /let toolsOn = false/);
});

test('phase61 the chat page does not claim success for an unverified run', async () => {
  const page = await read('public/chat.html');
  // A finished run is not a verified run. The evidence gate withholds success
  // unless something verified it, and the page must show that honestly.
  assert.match(page, /loop\.verified === true/);
  assert.match(page, /awaiting verification/);
  // The green "ok" chip must be reachable only when no loop ran at all.
  const okIndex = page.indexOf("chip ok\">ok<");
  const loopIndex = page.indexOf('if (loop) {');
  assert.ok(loopIndex > 0 && okIndex > loopIndex, 'the ok chip must sit in the else branch');
});
