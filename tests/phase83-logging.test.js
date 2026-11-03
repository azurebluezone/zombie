import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SystemLogger, formatConsoleLine } from '../src/core/logger.js';

test('console formatter is readable and keeps the JSONL envelope out of the terminal', () => {
  const line = formatConsoleLine({
    ts: '2026-11-03T11:22:03.361Z',
    level: 'info',
    event: 'runtime.startup_provider',
    schemaVersion: 1,
    id: 'gemini',
    modelCount: 50,
    defaultModel: 'gemini-3.5-flash-lite'
  });
  assert.match(line, /^11:22:03 ✓ INFO  runtime\.startup_provider +/);
  assert.match(line, /id=gemini/);
  assert.match(line, /modelCount=50/);
  assert.match(line, /defaultModel=gemini-3\.5-flash-lite/);
  assert.equal(line.includes('"ts"'), false);
});

test('SystemLogger writes JSONL to disk and a pretty line to stdout', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-phase83-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logger = new SystemLogger({ dir, file: 'runtime.jsonl', stdout: true, pretty: true });
  const originalWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  try {
    await logger.info('runtime.startup_summary', { providers: 6, models: 114, agents: 12, tools: 20 });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(stdout, /✓ INFO  runtime\.startup_summary +providers=6 models=114 agents=12 tools=20/);
  const row = JSON.parse((await readFile(path.join(dir, 'runtime.jsonl'), 'utf8')).trim());
  assert.equal(row.event, 'runtime.startup_summary');
  assert.equal(row.providers, 6);
  assert.equal(row.schemaVersion, 1);
});
