import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

test('server-side PHP integration client passes PHP syntax validation', () => {
  execFileSync('php', ['-l', path.resolve('integration/php/ZombieCoderClient.php')], {stdio:'pipe'});
  assert.ok(true);
});
