import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectContextStore } from '../src/context/project-context.js';
import { EntityDoor } from '../src/entities/entity-door.js';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { PersonaRegistry } from '../src/agents/persona-registry.js';

class MemStore { constructor(){this.m=new Map();} async read(k,d=[]){return this.m.get(k) ?? d;} async write(k,v){this.m.set(k,v);} }

test('project context reads SSOT, syllabus and memory with missing-file warnings', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'zc-phase8-')); const c=new ProjectContextStore(); await c.ensure(root);
  const ssot=await c.readSSOT(root), syllabus=await c.readSyllabus(root), memory=await c.readMemory(root);
  assert.match(ssot.content,/Project SSOT/); assert.match(syllabus.content,/Agent Knowledge Syllabus/); assert.deepEqual(memory.entries,[]);
  assert.match(await readFile(c.memoryPath(root),'utf8'),/\[\]/);
});

test('entity door normalizes and bounds entities', () => {
  const door=new EntityDoor({maxEntries:2}); const r=door.resolve({entities:['a',{id:'b',type:'file'},'c']});
  assert.equal(r.count,2); assert.equal(r.truncated,true); assert.equal(r.entities[1].type,'file');
});

test('canonical normalizer handles OpenAI, Gemini, Anthropic and text', () => {
  const n=new CanonicalResponseNormalizer();
  assert.equal(n.normalize({choices:[{message:{role:'assistant',content:'ok'}}]},{model:'m',providerId:'p'}).choices[0].message.content,'ok');
  assert.equal(n.normalize({candidates:[{content:{parts:[{text:'hi'}]}}]},{model:'m',providerId:'p'}).choices[0].message.content,'hi');
  assert.equal(n.normalize({content:[{type:'text',text:'yo'}]},{model:'m',providerId:'p'}).choices[0].message.content,'yo');
  assert.equal(n.normalize({text:'raw'},{model:'m',providerId:'p'}).choices[0].message.content,'raw');
});

test('persona registry exposes core fallback and persists custom persona', async () => {
  const s=new MemStore(); const r=new PersonaRegistry(s); const list=await r.list();
  assert.equal(list.length,12); assert.ok(list.some(x=>x.id==='code-guru'));
  await r.register({id:'custom-agency',name:'Custom Agency',role:'custom',persona:'Evidence only'});
  assert.equal((await r.resolve('custom-agency')).name,'Custom Agency');
});
