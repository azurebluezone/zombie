import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireRuntimeLock, createRuntimeIdentity } from '../src/runtime/identity.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'zc-phase56-lock-'));
}

const identity = (overrides = {}) => ({ runtimeId: 'runtime-10001', instanceId: 'inst-1', pid: process.pid, host: '127.0.0.1', port: 10001, ...overrides });

// PID 99999999 is above the default max on Linux, so it can never be alive.
const DEAD_PID = 99999999;

test('phase56 acquire then release leaves no lock behind', async t => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await acquireRuntimeLock(dir, createRuntimeIdentity({ port: 10001 }));
  const lockPath = path.join(dir, 'runtime-runtime-10001.lock');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  await release();
  await assert.rejects(() => readFile(lockPath, 'utf8'));
  const releaseAgain = await acquireRuntimeLock(dir, createRuntimeIdentity({ port: 10001 }));
  await releaseAgain();
});

test('phase56 a lock owned by a live process still fails closed', async t => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'runtime-runtime-10001.lock'), JSON.stringify(identity({ pid: process.pid })));
  await assert.rejects(() => acquireRuntimeLock(dir, identity()), error => {
    assert.equal(error.message, 'runtime_instance_already_locked:runtime-10001');
    assert.equal(error.holderPid, process.pid);
    return true;
  });
});

test('phase56 a lock left behind by a crashed runtime is recovered', async t => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, 'runtime-runtime-10001.lock');
  await writeFile(lockPath, JSON.stringify(identity({ pid: DEAD_PID, instanceId: 'dead-instance', acquiredAt: '2026-01-01T00:00:00.000Z' })));
  const warnings = [];
  const release = await acquireRuntimeLock(dir, identity(), { logger: { warn: (event, fields) => { warnings.push({ event, fields }); return Promise.resolve(); } } });
  const written = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(written.pid, process.pid, 'the new runtime must own the lock');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'runtime.lock.stale_recovered');
  assert.equal(warnings[0].fields.previousPid, DEAD_PID);
  assert.equal(warnings[0].fields.previousInstanceId, 'dead-instance');
  await release();
});

test('phase56 an unreadable lock fails closed because the owner is unknown', async t => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'runtime-runtime-10001.lock'), 'not-json');
  await assert.rejects(() => acquireRuntimeLock(dir, identity()), /runtime_instance_already_locked:runtime-10001/);
});
