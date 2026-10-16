import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContext } from '../src/context/compiler.js';
import { EvidenceGate } from '../src/evidence/gate.js';

class MemoryStore {
  constructor(){ this.data=new Map(); }
  async read(key,fallback=[]){ return structuredClone(this.data.get(key) ?? fallback); }
  async write(key,value){ this.data.set(key,structuredClone(value)); }
}

test('phase37 compiled context carries bounded session evidence',()=>{
  const compiled=compileContext({
    goal:'continue chat',
    userInput:'What did the provider observe?',
    recent:[{role:'user',content:'hello'}],
    evidence:[
      {source:'provider:ollama-cloud-openai',status:'observed',confidence:'direct-response',summary:'Provider returned a response; this is not execution verification',observedAt:new Date().toISOString()},
      {source:'provider:old',status:'observed',confidence:'direct-response',summary:'old',observedAt:new Date().toISOString()}
    ],
    sessionId:'sess_test',
    maxBytes:64*1024
  });
  assert.equal(compiled.facts.sessionId,'sess_test');
  assert.equal(compiled.evidence.length,2);
  assert.equal(compiled.evidence[0].source,'provider:ollama-cloud-openai');
});

test('phase37 provider observation can be persisted against a session context',async()=>{
  const store=new MemoryStore();
  const gate=new EvidenceGate({store,maxItems:20});
  const observedAt=new Date().toISOString();
  const item=await gate.record({
    contextId:'sess_123',
    source:'provider:mock-runtime',
    status:'observed',
    confidence:'direct-response',
    summary:'Provider returned a response; this is not execution verification',
    observedAt
  });
  assert.equal(item.contextId,'sess_123');
  const rows=await store.read('evidence',[]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'observed');
  assert.equal(gate.canClaimSuccess(rows),false);
});
