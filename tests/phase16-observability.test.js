import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile } from '../src/config/env-loader.js';
import { SystemLogger } from '../src/core/logger.js';
import { PersonaRegistry } from '../src/agents/persona-registry.js';
import { AgentRunner } from '../src/agents/runner.js';

function memoryStore() {
  const data = new Map();
  return {
    async read(key, fallback=[]) { return data.has(key) ? data.get(key) : fallback; },
    async write(key, value) { data.set(key, value); return value; }
  };
}

test('env loader reads .env without overriding an existing process environment value', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-env-'));
  const file = path.join(dir, '.env');
  const previous = process.env.ZC_PHASE16_EXISTING;
  process.env.ZC_PHASE16_EXISTING = 'process-wins';
  await writeFile(file, 'ZC_PHASE16_EXISTING=file-loses\nZC_PHASE16_NEW="loaded value"\n# comment\n', 'utf8');
  const result = loadEnvFile({cwd:dir});
  assert.equal(result.loaded, true);
  assert.equal(process.env.ZC_PHASE16_EXISTING, 'process-wins');
  assert.equal(process.env.ZC_PHASE16_NEW, 'loaded value');
  if (previous === undefined) delete process.env.ZC_PHASE16_EXISTING; else process.env.ZC_PHASE16_EXISTING = previous;
  delete process.env.ZC_PHASE16_NEW;
  await rm(dir, {recursive:true, force:true});
});

test('system logger writes structured JSONL and redacts secrets/payloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-log-'));
  const logger = new SystemLogger({dir, file:'runtime.jsonl', level:'debug', stdout:false, maxBytes:1024*1024, maxFiles:2});
  await logger.info('test.event', {
    requestId:'req-1',
    token:'secret-value',
    content:'private message',
    status:'ok',
    longDiagnostic:'x'.repeat(2001),
    ts:'spoofed timestamp',
    level:'error',
    event:'spoofed.event'
  });
  const raw = await readFile(path.join(dir, 'runtime.jsonl'), 'utf8');
  const row = JSON.parse(raw.trim());
  assert.equal(row.event, 'test.event');
  assert.equal(row.level, 'info');
  assert.notEqual(row.ts, 'spoofed timestamp');
  assert.equal(row.schemaVersion, 1);
  assert.equal(row.token, '[REDACTED]');
  assert.match(row.content, /^\[omitted:/);
  assert.equal(row.longDiagnostic, '[redacted-long-string:2001]');
  assert.equal(row.requestId, 'req-1');
  await rm(dir, {recursive:true, force:true});
});

test('logger retains only the configured number of rotated files', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-log-rotate-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const logger = new SystemLogger({dir, file:'runtime.jsonl', level:'info', stdout:false, maxBytes:1024, maxFiles:2});

  for (let index = 0; index < 6; index += 1) {
    await logger.info('rotation.test', {index, detail:'x'.repeat(700)});
  }

  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['runtime.jsonl', 'runtime.jsonl.1', 'runtime.jsonl.2']);
});

test('logger surfaces file-write failures to stderr without throwing into requests', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-log-failure-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const obstruction = path.join(dir, 'not-a-directory');
  await writeFile(obstruction, 'file');
  const logger = new SystemLogger({dir:path.join(obstruction, 'logs'), stdout:false});
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = chunk => { stderr += String(chunk); return true; };
  try {
    await logger.info('request.started', {requestId:'req-write-failure'});
  } finally {
    process.stderr.write = originalWrite;
  }
  const failure = JSON.parse(stderr.trim());
  assert.equal(failure.event, 'logger.write_failed');
  assert.equal(failure.sourceEvent, 'request.started');
  assert.equal(failure.errorCode, 'ENOTDIR');
});

test('agent/persona boundary emits identity metadata into system logs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-agent-log-'));
  const logger = new SystemLogger({dir, file:'runtime.jsonl', level:'debug', stdout:false});
  const store = memoryStore();
  const personas = new PersonaRegistry(store, logger);
  const registry = { resolve: async () => ({id:'code-guru',name:'Code Guru'}) };
  const runner = new AgentRunner({registry, personas, evidenceGate:{canClaimSuccess:() => false}, logger});
  const prepared = await runner.prepare({agentId:'code-guru', personaId:'code-guru', goal:'inspect architecture'});
  assert.equal(prepared.agent.id, 'code-guru');
  assert.equal(prepared.persona.id, 'code-guru');
  const raw = await readFile(path.join(dir, 'runtime.jsonl'), 'utf8');
  assert.match(raw, /"event":"persona\.resolved"/);
  assert.match(raw, /"event":"agent\.prepared"/);
  assert.match(raw, /"agentId":"code-guru"/);
  assert.match(raw, /"personaId":"code-guru"/);
  await rm(dir, {recursive:true, force:true});
});

// Regression: the payload-redaction rule matches key *names*, so diagnostic
// fields must not be named like payloads. Before this test, providerMessage,
// remoteMessage, messageCount, recentMessages and systemPromptInjected were all
// silently omitted, which hid upstream rejection reasons from the log.
test('logger keeps diagnostic fields while payload fields stay omitted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-log-diag-'));
  const logger = new SystemLogger({dir, file:'runtime.jsonl', level:'debug', stdout:false});
  await logger.warn('provider.failed', {
    providerId: 'groq',
    upstreamReason: 'model not found',            // diagnostic text
    remoteReason: 'mcp tool rejected arguments',  // diagnostic text
    msgCount: 3,                                  // diagnostic count
    recentCount: 2,
    sessionCount: 1,
    contextInjected: true,                        // diagnostic flag
    messages: [{role:'user',content:'private user text'}], // payload
    systemPrompt: 'private system text',          // payload
    apiKey: 'zc_must_be_redacted'                 // secret
  });
  const row = JSON.parse((await readFile(path.join(dir, 'runtime.jsonl'), 'utf8')).trim());
  assert.equal(row.upstreamReason, 'model not found');
  assert.equal(row.remoteReason, 'mcp tool rejected arguments');
  assert.equal(row.msgCount, 3);
  assert.equal(row.recentCount, 2);
  assert.equal(row.sessionCount, 1);
  assert.equal(row.contextInjected, true);
  assert.equal(row.messages, '[omitted:1 items]');
  assert.equal(row.systemPrompt, '[omitted:19 chars]');
  assert.equal(row.apiKey, '[REDACTED]');
  await rm(dir, {recursive:true, force:true});
});
