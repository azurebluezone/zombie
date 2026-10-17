#!/usr/bin/env node
/*
 * The zero-dependency guard.
 *
 * This runtime has no dependencies on purpose: `dependencies` and
 * `devDependencies` are empty, there is no lockfile, and there is no
 * `node_modules`. The upside is that there is no lockfile to drift, no
 * dependency tree to age, and nothing to audit except Node itself.
 *
 * The failure this guards against is not subtle, and it already happened once:
 *
 *   2026-10-16 22:11:46  `npx vitest` was run in this directory. npm cached
 *                        vite 8.3.4 and its tree under ~/.npm/_npx.
 *   2026-10-16 22:12:00  vitest ran `tests/phase23-system-session.test.js`,
 *                        which failed, and wrote `node_modules/.vite` and
 *                        `node_modules/.vitest-cache` into this working tree.
 *
 * The test failed for a simple reason: the file imports `node:test`, and vitest
 * cannot run a `node:test` file. The runner for this project is `node --test`
 * (`npm test`). It is never vitest, never jest, never mocha.
 *
 * `node_modules` is gitignored, so nothing reached the repository — the tree
 * was committed clean, 0 files tracked. But the working directory was polluted,
 * and the next person to see `node_modules` would reasonably conclude that
 * dependencies had been added to a project whose whole design is that it has
 * none.
 *
 * So the rule is absolute: any `node_modules`, any lockfile, or any declared
 * dependency is a failure. It is checked by tests/phase76-zero-deps.test.js as
 * part of the normal suite, and it can be run on its own:
 *
 *   node scripts/check-zero-deps.mjs
 *
 * Exit 0 when clean, exit 1 when polluted.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..');

/** Every field that would mean a dependency was declared. */
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Every lockfile an installer could leave behind. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];

/** The only test runner this project uses. */
export const TEST_RUNNER = 'node --test';

/** Any script whose command names another runner is a mistake. */
export const FORBIDDEN_RUNNERS = ['vitest', 'jest', 'mocha', 'ava', 'tape'];

async function exists(target) {
  try { await readdir(target); return true; }
  catch (error) { return error?.code !== 'ENOENT'; }
}

/**
 * @returns {Promise<{ok:boolean, root:string, problems:string[], notes:string[]}>}
 */
export async function checkZeroDeps(root = DEFAULT_ROOT) {
  const problems = [];
  const notes = [];

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    problems.push('package.json is missing or is not valid JSON');
  }

  if (manifest) {
    for (const field of DEPENDENCY_FIELDS) {
      const declared = manifest[field];
      if (declared && typeof declared === 'object' && Object.keys(declared).length) {
        problems.push(`package.json declares ${field}: ${Object.keys(declared).join(', ')}`);
      }
    }
    const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    if (scripts.test !== TEST_RUNNER) {
      problems.push(`package.json "test" is ${JSON.stringify(scripts.test ?? null)}, expected ${JSON.stringify(TEST_RUNNER)}`);
    }
    for (const [name, command] of Object.entries(scripts)) {
      const text = String(command ?? '');
      for (const runner of FORBIDDEN_RUNNERS) {
        if (new RegExp(`(^|[^a-z])${runner}([^a-z]|$)`, 'i').test(text)) {
          problems.push(`script "${name}" names ${runner}: ${text}`);
        }
      }
    }
    notes.push(`package.json version ${manifest.version ?? 'unknown'}`);
  }

  for (const lock of LOCKFILES) {
    if (await exists(path.join(root, lock))) {
      problems.push(`${lock} exists — an install ran here; this project has nothing to install`);
    }
  }

  const modules = path.join(root, 'node_modules');
  if (await exists(modules)) {
    const entries = await readdir(modules).catch(() => []);
    const sample = entries.slice(0, 8).join(', ');
    problems.push(
      `node_modules exists — ${entries.length} entry/ies${sample ? `: ${sample}${entries.length > 8 ? ', …' : ''}` : ' (empty)'}`
    );
  } else {
    notes.push('node_modules is absent');
    notes.push('no lockfile');
  }

  return { ok: problems.length === 0, root, problems, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await checkZeroDeps(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT);
  if (result.ok) {
    console.log(`zero-dependency guard: clean (${result.root})`);
    for (const note of result.notes) console.log(`  · ${note}`);
    process.exit(0);
  }
  console.error(`zero-dependency guard: FAILED (${result.root})`);
  for (const problem of result.problems) console.error(`  ✗ ${problem}`);
  console.error('');
  console.error(`This project has no dependencies and uses ${TEST_RUNNER} as its only test runner.`);
  console.error('If a stray cache appeared, it is not used by anything:');
  console.error('  rm -rf node_modules    # cache only; the runtime never reads it');
  process.exit(1);
}
