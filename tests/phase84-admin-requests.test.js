import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore, SQLITE_SCHEMA } from '../src/storage/sqlite-store.js';
import { RequestLog } from '../src/admin/request-log.js';

async function harness({ maxRows } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-request-log-'));
  const store = new SqliteStore(path.join(dir, 'runtime.sqlite'));
  await store.init();
  const log = new RequestLog({ store, ...(maxRows === undefined ? {} : { maxRows }) });
  await log.init();
  return {
    dir,
    store,
    log,
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

const row = (overrides = {}) => ({
  requestId: 'req_1',
  applicationId: 'app_1',
  operation: 'POST /v1/chat/completions',
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  ok: true,
  outcome: 'observed_unverified',
  agentId: 'code-guru',
  providerId: 'provider-a',
  model: 'model-a',
  stream: false,
  latencyMs: 42,
  ...overrides
});

test('phase84 request log stores metadata and survives a restart', async () => {
  const h = await harness();
  try {
    assert.equal(h.log.recording, true);
    const written = h.log.record(row());
    assert.ok(written.id.startsWith('rl_'));
    // append() is synchronous inside; let the prune chain settle.
    await new Promise(resolve => setImmediate(resolve));

    const restarted = new RequestLog({ store: h.store });
    await restarted.init();
    const list = await restarted.list();
    assert.equal(list.total, 1);
    assert.equal(list.requests[0].requestId, 'req_1');
    assert.equal(list.requests[0].status, 200);
    assert.equal(list.requests[0].ok, true);
    assert.equal(list.requests[0].providerId, 'provider-a');
    assert.equal(list.requests[0].model, 'model-a');
    assert.equal(list.requests[0].latencyMs, 42);
    assert.equal(restarted.recording, true);
  } finally {
    await h.close();
  }
});

test('phase84 disabling recording stops new rows without hiding history', async () => {
  const h = await harness();
  try {
    h.log.record(row({ requestId: 'req_old' }));
    await new Promise(resolve => setImmediate(resolve));
    const settings = await h.log.setRecording(false);
    assert.equal(settings.recording, false);
    assert.equal(h.log.record(row({ requestId: 'req_new' })), null);
    await new Promise(resolve => setImmediate(resolve));

    const list = await h.log.list();
    assert.deepEqual(list.requests.map(item => item.requestId), ['req_old']);
    assert.equal(list.recording, false);

    // The switch is persisted, not just held in memory.
    const restarted = new RequestLog({ store: h.store });
    await restarted.init();
    assert.equal(restarted.recording, false);
    assert.equal(restarted.record(row({ requestId: 'req_after_restart' })), null);
    await restarted.setRecording(true);
    assert.ok(restarted.record(row({ requestId: 'req_reenabled' })));
  } finally {
    await h.close();
  }
});

test('phase84 request list filters status and ok and prunes to maxRows', async () => {
  const h = await harness({ maxRows: 3 });
  try {
    for (let index = 0; index < 6; index += 1) {
      h.log.record(row({
        requestId: `req_${index}`,
        status: index % 2 === 0 ? 200 : 500,
        ok: index % 2 === 0,
        latencyMs: index
      }));
      await new Promise(resolve => setImmediate(resolve));
    }
    const all = await h.log.list();
    assert.equal(all.total, 3, 'the log keeps only the newest maxRows rows');
    assert.deepEqual(all.requests.map(item => item.requestId), ['req_5', 'req_4', 'req_3']);

    const failures = await h.log.list({ ok: false });
    assert.deepEqual(failures.requests.map(item => item.requestId), ['req_5', 'req_3']);
    const success = await h.log.list({ status: 200 });
    assert.deepEqual(success.requests.map(item => item.requestId), ['req_4']);
    const limited = await h.log.list({ limit: 1 });
    assert.deepEqual(limited.requests.map(item => item.requestId), ['req_5']);
  } finally {
    await h.close();
  }
});

test('phase84 requests table mirrors routing metadata into queryable columns', () => {
  const columns = SQLITE_SCHEMA.columnsFor('requests');
  for (const column of ['request_id', 'application_id', 'status', 'ok', 'provider', 'model', 'latency_ms', 'stream']) {
    assert.ok(columns[column], `missing mirror column ${column}`);
  }
  assert.equal(SQLITE_SCHEMA.tables.settings, 'settings');
});
