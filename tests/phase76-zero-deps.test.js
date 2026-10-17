import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkZeroDeps, DEFAULT_ROOT, DEPENDENCY_FIELDS, LOCKFILES, TEST_RUNNER, FORBIDDEN_RUNNERS } from '../scripts/check-zero-deps.mjs';

/*
 * phase76 — this project has no dependencies, and that is enforced, not assumed.
 *
 * On 2026-10-16 a `npx vitest` was run in this directory. Vitest cannot run a
 * `node:test` file, so the test it was pointed at failed, and it left
 * `node_modules/.vite` and `node_modules/.vitest-cache` behind. `node_modules` is
 * gitignored so the repository stayed clean, but the working tree was polluted —
 * and the next person to see `node_modules` would reasonably conclude that
 * dependencies had been added to a project whose whole design is that it has
 * none.
 *
 * These tests make that conclusion impossible: the rule is checked on every run.
 */

// A writable scratch directory, kept off the repository so a synthetic mess can
// never look like the real thing.
async function scratch() {
  const base = path.join(os.tmpdir(), 'opencode');
  await mkdir(base, { recursive: true }).catch(() => {});
  return mkdtemp(path.join(base, 'zc-zero-deps-'));
}

test('phase76 the repository itself is clean', async () => {
  const result = await checkZeroDeps(DEFAULT_ROOT);
  assert.equal(
    result.ok,
    true,
    `the zero-dependency rule is broken:\n  ${result.problems.join('\n  ')}\n` +
      'This project has no dependencies; if a cache appeared, remove node_modules and use `node --test`.'
  );
  assert.deepEqual(result.problems, []);
});

test('phase76 package.json declares no dependency field at all', async () => {
  const manifest = JSON.parse(await readFile(path.join(DEFAULT_ROOT, 'package.json'), 'utf8'));
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    const keys = value && typeof value === 'object' ? Object.keys(value) : [];
    assert.deepEqual(keys, [], `package.json must not declare ${field}`);
  }
});

test('phase76 the only test runner is node --test', async () => {
  const manifest = JSON.parse(await readFile(path.join(DEFAULT_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, TEST_RUNNER);
  for (const [name, command] of Object.entries(manifest.scripts)) {
    for (const runner of FORBIDDEN_RUNNERS) {
      assert.equal(
        new RegExp(`(^|[^a-z])${runner}([^a-z]|$)`, 'i').test(String(command)),
        false,
        `script "${name}" must not use ${runner}: ${command}`
      );
    }
  }
  // The runner the whole suite is executed with, stated once.
  assert.deepEqual([...FORBIDDEN_RUNNERS].sort(), ['ava', 'jest', 'mocha', 'tape', 'vitest']);
});

test('phase76 the guard passes a synthetic clean root', async () => {
  const root = await scratch();
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: TEST_RUNNER } }));
  const result = await checkZeroDeps(root);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.ok(result.notes.includes('node_modules is absent'));
});

test('phase76 the guard catches a dependency, a lockfile and a node_modules', async () => {
  const root = await scratch();
  // Exactly the shape of the 2026-10-16 incident: a stray cache, no real package.
  await mkdir(path.join(root, 'node_modules', '.vitest-cache'), { recursive: true });
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'x',
    version: '1.0.0',
    scripts: { test: 'vitest run' },
    dependencies: { 'left-pad': '1.3.0' }
  }));

  const result = await checkZeroDeps(root);
  assert.equal(result.ok, false, 'a polluted root must not pass');

  const joined = result.problems.join('\n');
  assert.match(joined, /declares dependencies: left-pad/, 'the declared dependency is reported');
  assert.match(joined, /package-lock\.json exists/, 'the lockfile is reported');
  assert.match(joined, /node_modules exists/, 'the node_modules directory is reported');
  assert.match(joined, /"test" is "vitest run"/, 'the wrong test runner is reported');
  assert.match(joined, /script "test" names vitest/, 'the wrong runner named in a script is reported');
  // Five, and each one is a distinct way to break the rule: a declared dependency,
  // a lockfile, a node_modules, a "test" script that is not `node --test`, and a
  // script that names a forbidden runner.
  assert.equal(result.problems.length, 5);

  // A root that is otherwise clean but runs the wrong runner is still a failure.
  const wrongRunner = await scratch();
  await writeFile(path.join(wrongRunner, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'vitest run' } }));
  const wrong = await checkZeroDeps(wrongRunner);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.problems.length, 2, 'the mismatch and the named runner are both reported');
});

test('phase76 every lockfile an installer could leave is checked', async () => {
  for (const lock of LOCKFILES) {
    const root = await scratch();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: TEST_RUNNER } }));
    await writeFile(path.join(root, lock), '');
    const result = await checkZeroDeps(root);
    assert.equal(result.ok, false, `${lock} must be detected`);
    assert.match(result.problems.join('\n'), new RegExp(lock.replace('.', '\\.')));
  }
});

test('phase76 an empty node_modules is still a failure', async () => {
  const root = await scratch();
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: TEST_RUNNER } }));
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  const result = await checkZeroDeps(root);
  assert.equal(result.ok, false, 'an empty node_modules was created by something; say so');
  assert.match(result.problems.join('\n'), /node_modules exists/);
});
