#!/usr/bin/env node
// Release check for the docs+push contract.
//
// Runs the round-4 gate (installer, TLS, MCP, web_search, matrix, tests), checks
// that the documentation carries the verified numbers, then proves the pushed
// remote branch is exactly the local HEAD and the worktree is clean. A green
// local test run alone would not prove the push landed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 100000,
    ...options
  }).trim();
}

function fail(code, message, detail = '') {
  console.error(`RELEASE_FAIL ${message}`);
  if (detail) console.error(detail.slice(-3000));
  process.exit(code);
}

let gate;
try {
  gate = run(process.execPath, ['scripts/verify-round4.mjs']);
} catch (error) {
  fail(1, 'round4_gate_failed', `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
}
if (!gate.includes('ROUND4_OK')) fail(1, 'round4_gate_not_ok', gate);
const gateTests = Number(gate.match(/\btests=(\d+)\b/)?.[1] ?? 0);
if (!Number.isFinite(gateTests) || gateTests < 452) fail(1, 'round4_gate_tests_below_baseline', gate);

const docs = {
  status: readFileSync(path.join(ROOT, 'docs/PROJECT_STATUS.md'), 'utf8'),
  readme: readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
  changelog: readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
};
const missing = [];
if (!/round 4/i.test(docs.status)) missing.push('PROJECT_STATUS round-4 marker');
if (!docs.status.includes('452')) missing.push('PROJECT_STATUS 452');
if (!docs.readme.includes('452 tests')) missing.push('README 452 tests');
if (!/round 4/i.test(docs.changelog)) missing.push('CHANGELOG round-4 marker');
if (!docs.changelog.includes('452')) missing.push('CHANGELOG 452');
if (missing.length) fail(2, 'docs_stale', missing.join('\n'));

try {
  run('git', ['fetch', '--quiet', 'origin', 'main']);
} catch (error) {
  fail(3, 'git_fetch_failed', `${error.stderr ?? ''}\n${error.message}`);
}
const head = run('git', ['rev-parse', 'HEAD']);
const remote = run('git', ['rev-parse', 'origin/main']);
if (head !== remote) fail(4, 'remote_not_at_local_head', `local=${head}\nremote=${remote}`);

const dirty = run('git', ['status', '--porcelain']);
if (dirty) fail(5, 'worktree_dirty', dirty);

console.log(`RELEASE_OK head=${head.slice(0, 7)} remote=origin/main clean=1 gate=ROUND4_OK tests=${gateTests} docs=provider-fix`);
