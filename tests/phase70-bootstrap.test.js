import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/bootstrap.sh exists for a reinstalled OS. Its whole value is in what it promises
// NOT to do, so that is what is pinned here: it must parse, it must never touch an existing
// .env, it must not discard local work, and running it on a healthy machine must change
// nothing at all.

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SCRIPT = path.join(REPO, 'scripts', 'bootstrap.sh');
const script = readFileSync(SCRIPT, 'utf8');

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// The script's own header explains the destructive commands it refuses to run ("it will not
// run git reset/clean"), so a naive search for those words matches the promise itself. Look
// only at executable lines: comments stripped, blank lines dropped.
const code = script
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('phase70 the bootstrap script parses', () => {
  assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' }));
});

test('phase70 it refuses to touch an existing .env', () => {
  // The copy must be guarded by "does it already exist", and nothing may overwrite it.
  assert.match(code, /if \[\[ -f "\$ROOT\/\.env" \]\]/, 'the .env check must come first');
  assert.match(code, /left untouched/, 'and it must say so');
  assert.doesNotMatch(code, />\s*"\$ROOT\/\.env"/, 'nothing may redirect into .env');
  assert.doesNotMatch(code, /cp\s+-f\s+"\$ROOT\/\.env\.example"\s+"\$ROOT\/\.env"/, 'the copy must not force');
});

test('phase70 it never discards local work', () => {
  assert.doesNotMatch(code, /git\s+reset/, 'git reset would throw away uncommitted work');
  assert.doesNotMatch(code, /git\s+clean/, 'git clean would throw away untracked work');
  assert.doesNotMatch(code, /rm\s+-rf/, 'a bootstrap script has no business force-removing anything');
  assert.doesNotMatch(code, /--force/, 'no forced git operations');
});

test('phase70 it does not decide the execution mode for the operator', () => {
  // Tool execution is a deliberate operator switch; an installer must not flip it.
  assert.doesNotMatch(code, /ZOMBIECODER_EXECUTION_MODE=tools-enabled/, 'the installer must not enable tool execution');
});

test('phase70 it stays on loopback and does not configure a proxy', () => {
  assert.doesNotMatch(code, /nginx/i, 'the proxy path belongs to setup-os-runtime.sh, not here');
  assert.match(code, /binds 127\.0\.0\.1 only/, 'it must tell the operator that it binds loopback');
});

test('phase70 running it on a healthy machine changes nothing', { timeout: 120000 }, () => {
  const envFile = path.join(REPO, '.env');
  if (!existsSync(envFile)) {
    // The promise is about an existing .env; without one there is nothing to protect.
    assert.ok(script.includes('.env.example'), 'the script should still know about .env.example');
    return;
  }

  const before = { hash: digest(envFile), mtime: statSync(envFile).mtimeMs };

  const output = execFileSync('bash', [SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ZC_SKIP_SYSTEM: '1', ZC_NO_START: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const after = { hash: digest(envFile), mtime: statSync(envFile).mtimeMs };

  assert.equal(after.hash, before.hash, '.env content must be byte-identical');
  assert.equal(after.mtime, before.mtime, '.env must not even be rewritten');
  assert.match(output, /\[ok\]\s+\.env exists — left untouched/, 'it must report that it left .env alone');
  assert.match(output, /bootstrap finished/, 'and it must reach the end');
});
