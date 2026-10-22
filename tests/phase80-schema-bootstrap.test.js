import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, SQLITE_SCHEMA } from '../src/storage/sqlite-store.js';
import { resolveSeedProvider, bootstrapProviders } from '../src/startup/provider-bootstrap.js';

async function tempDb(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'runtime.sqlite');
}

test('a fresh database is created from the declared schema, with typed mirrors', async (t) => {
  const file = await tempDb(t);
  const store = new SqliteStore(file);
  await store.init();
  t.after(() => store.db.close());

  const tables = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const [logical, table] of Object.entries(SQLITE_SCHEMA.tables)) {
    assert.ok(tables.has(table), `table missing after init: ${logical}`);
    const columns = new Map(store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, String(row.type).toUpperCase()]));
    for (const [column, type] of Object.entries(SQLITE_SCHEMA.columnsFor(logical))) {
      // PRAGMA reports the affinity (TEXT/INTEGER), not constraints like PRIMARY KEY.
      assert.equal(columns.get(column), type.split(' ')[0], `${logical}.${column} must be created as ${type}`);
    }
  }
  for (const [logical, columns] of Object.entries(SQLITE_SCHEMA.extraColumns)) {
    const table = SQLITE_SCHEMA.tables[logical];
    const present = new Map(store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, String(row.type).toUpperCase()]));
    for (const [column, type] of Object.entries(columns)) {
      assert.equal(present.get(column), type, `${logical}.${column} must be a mirror column`);
    }
  }
});

test('an older database gains the new mirror columns, keeps rows and typed integers', async (t) => {
  const file = await tempDb(t);
  // The shape a previous release wrote: no tool_boundary/working_directory on
  // agents, no provider/model/ok/latency_ms on model_tests.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  old.exec(`CREATE TABLE model_tests (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  old.prepare(`INSERT INTO model_tests(id,data,created_at,updated_at) VALUES(?,?,?,?)`).run('mt_old', JSON.stringify({ id: 'mt_old', providerId: 'p', model: 'm', ok: true, latencyMs: 12 }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  old.close();

  const store = new SqliteStore(file);
  await store.init();
  t.after(() => store.db.close());

  const modelColumns = new Map(store.db.prepare('PRAGMA table_info(model_tests)').all().map(row => [row.name, String(row.type).toUpperCase()]));
  assert.equal(modelColumns.get('provider'), 'TEXT');
  assert.equal(modelColumns.get('ok'), 'INTEGER');
  assert.equal(modelColumns.get('latency_ms'), 'INTEGER');
  const agentColumns = new Set(store.db.prepare('PRAGMA table_info(agents)').all().map(row => row.name));
  assert.ok(agentColumns.has('tool_boundary'));
  assert.ok(agentColumns.has('working_directory'));

  // The pre-existing row is untouched by the ALTERs.
  const kept = store.db.prepare('SELECT id FROM model_tests WHERE id=?').get('mt_old');
  assert.equal(kept.id, 'mt_old');

  await store.write('model-tests', [{ id: 'mt_new', providerId: 'p2', model: 'm2', ok: false, latencyMs: 3, checkedAt: '2026-01-02T00:00:00.000Z' }]);
  const written = store.db.prepare('SELECT provider, model, ok, latency_ms FROM model_tests WHERE id=?').get('mt_new');
  assert.deepEqual({ ...written }, { provider: 'p2', model: 'm2', ok: 0, latency_ms: 3 });
});

test('a seed can read its base URL from the environment instead of the JSON blob', () => {
  const env = { CUSTOM_OPENAI_BASE_URL: 'https://example.test/v1' };
  const resolved = resolveSeedProvider({ id: 'custom-openai', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL' }, env);
  assert.equal(resolved.baseUrl, 'https://example.test/v1');
  assert.equal(resolved.baseUrlEnv, 'CUSTOM_OPENAI_BASE_URL');
  // An explicit baseUrl is only a fallback: the env var wins when it is present.
  assert.equal(resolveSeedProvider({ id: 'x', baseUrlEnv: 'MISSING', baseUrl: 'https://fallback.test' }, {}).baseUrl, 'https://fallback.test');
  assert.equal(resolveSeedProvider({ id: 'x', baseUrlEnv: 'MISSING' }, {}).baseUrl, '');
});

test('bootstrap registers a seed whose base URL comes from env, and skips a missing one', async () => {
  const previous = process.env.CUSTOM_OPENAI_BASE_URL;
  process.env.CUSTOM_OPENAI_BASE_URL = 'https://example.test/v1';
  const registered = [];
  const registry = {
    list: async () => [],
    register: async (item) => { registered.push(item); return item; },
    remove: async () => false
  };
  const ok = await bootstrapProviders({ registry, config: {}, bootConfig: [{ id: 'custom-openai', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL', priority: 4 }] });
  assert.equal(ok.registered.length, 1);
  assert.equal(registered[0].baseUrl, 'https://example.test/v1');
  assert.equal(registered[0].baseUrlEnv, 'CUSTOM_OPENAI_BASE_URL');

  registered.length = 0;
  const skipped = await bootstrapProviders({ registry, config: {}, bootConfig: [{ id: 'custom-openai', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL_MISSING' }] });
  assert.deepEqual(skipped.registered, []);
  assert.deepEqual(skipped.skipped, [{ id: 'custom-openai', reason: 'base_url_env_missing', baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL_MISSING' }]);
  assert.equal(registered.length, 0);

  if (previous === undefined) delete process.env.CUSTOM_OPENAI_BASE_URL;
  else process.env.CUSTOM_OPENAI_BASE_URL = previous;
});
