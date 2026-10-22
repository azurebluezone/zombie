import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This runtime lives on a USB stick; losing power mid-write is an expected
// failure, not an exotic one. Two cheap guarantees are pinned here: every
// acknowledged commit reaches the platter (synchronous=FULL under WAL), and a
// running database can be copied without cp-style torn writes.

test('phase63 SQLite commits are durable under WAL', async () => {
  const store = await readFile(path.join(root, 'src/storage/sqlite-store.js'), 'utf8');
  assert.match(store, /PRAGMA journal_mode=WAL/);
  assert.match(store, /PRAGMA synchronous=FULL/, 'WAL defaults to NORMAL and can lose the last commits on power loss');
});

test('phase63 backup produces a consistent copy while the database is open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-backup-'));
  const dbPath = path.join(dir, 'runtime.sqlite');
  const outDir = path.join(dir, 'out');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('CREATE TABLE evidence (id TEXT PRIMARY KEY, data TEXT)');
    const insert = db.prepare('INSERT INTO evidence(id, data) VALUES (?, ?)');
    for (let i = 0; i < 25; i++) insert.run(`e${i}`, JSON.stringify({ i, ok: true }));
  } finally {
    // Deliberately left open: the backup must work against a live file.
  }

  try {
    const run = spawnSync('bash', [path.join(root, 'scripts/backup-runtime.sh'), dbPath, outDir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const line = run.stdout.split('\n').find(l => l.startsWith('{'));
    assert.ok(line, `backup printed a JSON summary: ${run.stdout}`);
    const summary = JSON.parse(line);
    assert.equal(summary.integrity, 'ok');
    assert.ok(summary.tables >= 1);

    const copy = new DatabaseSync(summary.out, { readOnly: true });
    const count = copy.prepare('SELECT count(*) AS n FROM evidence').get();
    const integrity = copy.prepare('PRAGMA integrity_check').get();
    copy.close();
    assert.equal(Number(count.n), 25, 'all committed rows are in the copy');
    assert.equal(integrity.integrity_check, 'ok');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
