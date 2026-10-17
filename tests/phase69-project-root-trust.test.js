import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectContextStore } from '../src/context/project-context.js';
import { AutoSetupService } from '../src/context/auto-setup.js';
import { SSOTService } from '../src/context/ssot.js';
import { SyllabusService } from '../src/context/syllabus.js';
import { ProjectMemoryService } from '../src/context/memory.js';

// The bug these tests pin: the HTTP layer authorized a project root through the agent's
// persisted tool-access scope and resolved it with `allowAnyRoot`, then handed the resolved
// path to services that re-checked it against the runtime's configured `PROJECT_ROOTS`.
// A global agent — which the scope says may name any root on the host — was refused with
// `project_root_not_allowed` for a folder it had just been granted. One authorization
// decision, two disagreeing checks.

function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'zc-root-trust-'));
  const allowed = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { base, allowed, outside };
}

test('phase69 a root outside the allowlist is refused until it is trusted', () => {
  const { base, allowed, outside } = fixture();
  try {
    const store = new ProjectContextStore({ defaultRoot: allowed, allowedRoots: [allowed] });
    assert.throws(() => store.root(outside), /project_root_not_allowed/);

    assert.equal(store.trustRoot(outside), realpathSync(outside));
    assert.equal(store.root(outside), realpathSync(outside));
    // Trusting is additive: the roots that were already allowed keep working.
    assert.equal(store.root(allowed), realpathSync(allowed));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('phase69 trusting a path that does not exist fails closed', () => {
  const { base, allowed } = fixture();
  try {
    const store = new ProjectContextStore({ defaultRoot: allowed, allowedRoots: [allowed] });
    assert.throws(() => store.trustRoot(path.join(base, 'missing')), /project_root_not_found/);
    // An empty value is "no root named", not a root to trust.
    assert.equal(store.trustRoot(''), null);
    assert.equal(store.trustRoot(null), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('phase69 with no allowlist configured nothing is refused and nothing needs trusting', () => {
  const { base, outside } = fixture();
  try {
    const store = new ProjectContextStore({ defaultRoot: base, allowedRoots: null });
    assert.equal(store.trustRoot(outside), null, 'nothing is restricted, so there is nothing to trust');
    assert.equal(store.root(outside), outside);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('phase69 the services that refused the root can now read and write it', async () => {
  const { base, allowed, outside } = fixture();
  try {
    const store = new ProjectContextStore({ defaultRoot: allowed, allowedRoots: [allowed] });
    const ssot = new SSOTService({ contextStore: store });
    const syllabus = new SyllabusService({ contextStore: store });
    const memory = new ProjectMemoryService({ contextStore: store });
    const autoSetup = new AutoSetupService({ contextStore: store, ssot, syllabus, memory });

    // This is the exact call the chat path makes first, and the one that threw.
    assert.throws(() => store.root(outside), /project_root_not_allowed/);

    // What the HTTP layer does once the agent scope has authorized the root.
    const resolved = store.root(outside, { allowAnyRoot: true });
    store.trustRoot(resolved);

    const ensured = await autoSetup.ensure(resolved);
    assert.equal(ensured.root, realpathSync(outside));
    assert.ok(readFileSync(path.join(outside, '.zombiecoder', 'SSOT.md'), 'utf8').startsWith('# Project SSOT'));

    const read = await ssot.read(resolved);
    assert.match(read.content, /# Project SSOT/);

    await syllabus.append(resolved, { topic: 'trusted root', summary: 'wrote through a trusted root', status: 'verified' });
    assert.match((await syllabus.read(resolved)).content, /trusted root/);

    const entry = await memory.append(resolved, { content: 'a trusted root accepts memory', kind: 'note' });
    assert.equal(entry.content, 'a trusted root accepts memory');
    assert.equal((await memory.recent(resolved, 5)).length, 1);

    // The original allowlist is untouched by any of this.
    assert.equal(store.root(allowed), realpathSync(allowed));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
