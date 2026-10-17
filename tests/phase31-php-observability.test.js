import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SystemLogger } from '../src/core/logger.js';

test('logger preserves request/trace correlation and redacts credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-phase31-log-'));
  const logger = new SystemLogger({dir, file:'runtime.jsonl', level:'info', stdout:false});
  await logger.child({requestId:'req-31', traceId:'trace-31', applicationId:'app-31'}).info('integration.test', {authorization:'Bearer secret', outcome:'verified'});
  const row = JSON.parse((await readFile(path.join(dir, 'runtime.jsonl'), 'utf8')).trim());
  assert.equal(row.requestId, 'req-31');
  assert.equal(row.traceId, 'trace-31');
  assert.equal(row.applicationId, 'app-31');
  assert.equal(row.authorization, '[REDACTED]');
  assert.equal(row.outcome, 'verified');
  await rm(dir, {recursive:true, force:true});
});

/**
 * `php` is not part of this project's runtime. The runtime has zero dependencies
 * and never shells out to an interpreter; PHP is only used to syntax-check the two
 * integration clients, and a PHP host checks them itself when it loads them.
 *
 * So when the machine has no `php`, the honest answer is "not tested here", not a
 * failure. A suite that is red for a reason nobody on it can act on is a suite
 * people learn to ignore — and the next real failure hides inside that noise.
 *
 * Set ZC_REQUIRE_PHP=1 wherever PHP is expected (CI, or a machine that installs
 * php-cli) and its absence becomes a failure instead of a skip: the skip must not
 * be able to hide a regression where PHP does exist.
 */
function phpBinary() {
  const probe = spawnSync('php', ['--version'], { stdio: 'pipe' });
  return probe.error || probe.status !== 0 ? null : 'php';
}

const PHP = phpBinary();
const REQUIRE_PHP = /^(1|true|yes)$/i.test(String(process.env.ZC_REQUIRE_PHP ?? ''));
const PHP_CLIENTS = ['integration/php/ZombieCoderClient.php', 'integration/php/ZombieCoderAdminClient.php'];

test('phase31 both PHP integration clients are present and non-trivial', async () => {
  // This half needs no interpreter, so a rename or an accidental truncation is
  // caught on every machine — including one without php, where the syntax check
  // below will be skipped.
  for (const file of PHP_CLIENTS) {
    const source = await readFile(path.resolve(file), 'utf8');
    assert.ok(source.trim().length > 500, `${file} is suspiciously small (${source.trim().length} chars)`);
    assert.match(source, /<\?php/, `${file} must open as PHP`);
    assert.match(source, /\$/, `${file} contains no PHP variable — is this the right file?`);
  }
});

test('phase31 PHP integration clients pass PHP syntax validation', (t) => {
  if (!PHP) {
    const reason = 'NOT_TESTED: no php binary on this host — install php-cli, or set ZC_REQUIRE_PHP=1 to make its absence a failure';
    if (REQUIRE_PHP) assert.fail(reason);
    t.skip(reason);
    return;
  }
  for (const file of PHP_CLIENTS) {
    let stderr = '';
    try {
      execFileSync(PHP, ['-l', path.resolve(file)], { stdio: 'pipe' });
    } catch (error) {
      stderr = String(error.stderr ?? error.stdout ?? error.message);
      assert.fail(`php -l rejected ${file}:\n${stderr}`);
    }
  }
});
