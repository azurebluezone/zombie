import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createStore } from '../src/storage/storage.js';
import { PersonaRegistry } from '../src/agents/persona-registry.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { DEFAULT_AGENTS } from '../src/agents/index.js';

test('phase 19: all requested file agents exist in default registry', async () => {
  assert.equal(DEFAULT_AGENTS.length, 12);
  for (const id of [
    'bug-hunter','code-guru','customer-experience-specialist','doc-king',
    'ecommerce-operations-analyst','perf-wizard','qa-tyrant','security-hero',
    'team-heart','planner','researcher','integrator'
  ]) assert.ok(DEFAULT_AGENTS.some(a => a.id === id), id);
});

test('phase 19: database persona overrides file fallback per agent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zombie-persona-'));
  const store = await createStore({dataDir:dir, sqlitePath:path.join(dir,'runtime.sqlite')});
  const personas = new PersonaRegistry(store);
  const before = await personas.resolve('bug-hunter');
  assert.equal(before.id, 'bug-hunter');
  assert.equal(before.source, undefined);

  await personas.register({id:'bug-hunter', name:'DB Bug Hunter', role:'debugging', expertise:'db', priority:1, persona:'DB persona'});
  const after = await personas.resolve('bug-hunter');
  assert.equal(after.name, 'DB Bug Hunter');
  assert.equal(after.persona, 'DB persona');

  const list = await personas.list();
  assert.equal(list.length, 12);
  store.close();
  await fs.rm(dir, {recursive:true, force:true});
});

test('phase 19: missing database persona falls back to file default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zombie-persona-fallback-'));
  const store = await createStore({dataDir:dir, sqlitePath:path.join(dir,'runtime.sqlite')});
  const personas = new PersonaRegistry(store);
  await store.write('personas', []);
  const result = await personas.resolve('team-heart');
  assert.equal(result.id, 'team-heart');
  assert.match(result.persona, /Team Heart/);
  store.close();
  await fs.rm(dir, {recursive:true, force:true});
});

test('phase 19: agent registry resolves the expanded defaults', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zombie-agent-reg-'));
  const store = await createStore({dataDir:dir, sqlitePath:path.join(dir,'runtime.sqlite')});
  const registry = new AgentRegistry(store);
  const result = await registry.resolve('ecommerce-operations-analyst');
  assert.equal(result.id, 'ecommerce-operations-analyst');
  assert.ok(result.capabilities.includes('ecommerce'));
  store.close();
  await fs.rm(dir, {recursive:true, force:true});
});
