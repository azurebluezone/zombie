import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry } from '../src/registry/catalog.js';
import { normalizeManifest, canResolveManifest } from '../src/registry/manifest.js';

class MemoryStore {
  constructor() { this.data = new Map(); }
  async read(name, fallback=[]) { return this.data.has(name) ? this.data.get(name) : fallback; }
  async write(name, value) { this.data.set(name, value); }
}

test('registry manifest has stable extension contract', () => {
  const m = normalizeManifest({id:'ocr', type:'tool', version:'1.2.0', capabilities:['ocr'], requiresConsent:true});
  assert.equal(m.id, 'ocr');
  assert.equal(m.type, 'tool');
  assert.equal(m.requiresConsent, true);
  assert.equal(m.status, 'REGISTERED');
  assert.equal(canResolveManifest(m), true);
});

test('registry rejects mismatched type and invalid status', () => {
  assert.throws(() => normalizeManifest({id:'x', type:'agent'}, 'tool'), /manifest_type_mismatch/);
  assert.throws(() => normalizeManifest({id:'x', type:'tool', status:'MAGIC'}, 'tool'), /manifest_status_invalid/);
});

test('component registry persists and replaces by stable id', async () => {
  const store = new MemoryStore();
  const registry = new ComponentRegistry(store, {collection:'tools', type:'tool'});
  await registry.register({id:'health', version:'1.0.0'});
  await registry.register({id:'health', version:'1.1.0'});
  const list = await registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].version, '1.1.0');
  assert.equal((await registry.resolve('health')).id, 'health');
});

test('disabled or deprecated components do not resolve', async () => {
  const store = new MemoryStore();
  const registry = new ComponentRegistry(store, {collection:'skills', type:'skill'});
  await registry.register({id:'old-skill', status:'DEPRECATED'});
  await assert.rejects(() => registry.resolve('old-skill'), /skill_not_found_or_disabled/);
});
