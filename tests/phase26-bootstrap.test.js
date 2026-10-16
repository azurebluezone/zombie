import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoundedContext } from '../src/context/context-budget.js';
import { providerModelKey, mergeProviderCatalog } from '../src/providers/sync.js';
import { parseProviderBootConfig } from '../src/startup/provider-bootstrap.js';

test('provider model identity is scoped by provider id', () => {
  assert.equal(providerModelKey('p1','model-x'),'p1:model-x');
  assert.notEqual(providerModelKey('p1','model-x'),providerModelKey('p2','model-x'));
});

test('provider catalog merges models without cross-provider collision', () => {
  const out=mergeProviderCatalog([], {providers:[{id:'p1',baseUrl:'https://p1.test'},{id:'p2',baseUrl:'https://p2.test'}],models:[{providerId:'p1',id:'same'},{providerId:'p2',id:'same'}]});
  assert.deepEqual(out.find(x=>x.id==='p1').models,['same']);
  assert.deepEqual(out.find(x=>x.id==='p2').models,['same']);
});

test('provider boot config rejects non-array JSON', () => {
  assert.throws(()=>parseProviderBootConfig('{"id":"x"}'),/must_be_array/);
});

test('context budget keeps recent messages and bounds archive', () => {
  const r=buildBoundedContext({userInput:'find auth bug',recent:Array.from({length:10},(_,i)=>({role:'user',content:'recent '+i})),archive:Array.from({length:100},(_,i)=>({role:'user',content:i===50?'auth bug important':'noise '+i})),maxBytes:64*1024});
  assert.equal(r.recent.length,10);
  assert.ok(r.archive.some(x=>String(x.content).includes('auth bug')));
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=64*1024);
});
