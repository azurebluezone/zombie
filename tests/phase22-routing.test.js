import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartRouter } from '../src/providers/router/smart-router.js';
import { maskCanonicalResponse, createAgentProviderIdentity } from '../src/providers/masking/provider-mask.js';
import { parseCanonicalToolCalls, stripUnsupportedTools } from '../src/tools/parser.js';
import { ProviderExecutionAdapter } from '../src/execution/provider-adapter.js';
import { EvidenceGate } from '../src/evidence/gate.js';

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { async read(k,d){ return data.has(k) ? data.get(k) : d; }, async write(k,v){ data.set(k,v); } };
}

function fakeProvider(id, response, capabilities={chatCompletions:true,streaming:true,functionCalling:true}) {
  return { id, capabilities, async chatCompletions(){ return response; }, toCanonical(x){return x;} };
}

test('phase22 smart router selects by capability then priority', async () => {
  const store=memoryStore({providers:[
    {id:'slow',enabled:true,priority:20,models:['m'],capabilities:['chat-completions']},
    {id:'fast',enabled:true,priority:5,models:['m'],capabilities:['chat-completions','function-calling']}
  ]});
  const providers={list:()=>store.read('providers',[])};
  const router=new SmartRouter({providers});
  const route=await router.route({model:'m',tools:[{type:'function',function:{name:'x'}}]});
  assert.equal(route.providerId,'fast');
  assert.deepEqual(route.requiredCapabilities,['function-calling','chat-completions']);
});

test('phase22 provider fallback tries the next eligible provider after failure', async () => {
  const store=memoryStore({providers:[
    {id:'first',enabled:true,priority:1,models:['m']},
    {id:'second',enabled:true,priority:2,models:['m']}
  ]});
  const providers={
    list:()=>store.read('providers',[]),
    resolve:async id=> id==='first' ? {id,capabilities:{chatCompletions:true},chatCompletions:async()=>{throw new Error('temporary_failure')}} : fakeProvider(id,{choices:[{message:{role:'assistant',content:'ok'}}]}),
    resolveModel:async()=> 'm'
  };
  const adapter=new ProviderExecutionAdapter({providers,normalizer:{normalize:(x)=>x}});
  const prepared={consent:{allowed:true},contract:{goal:'do it',expectedOutcome:'response'}};
  const result=await adapter.execute({prepared,input:{messages:[{role:'user',content:'x'}]}});
  assert.equal(result.providerId,'second');
  assert.equal(result.verified,false);
  assert.equal(result.response.provider,'ZombieCoder');
});

test('phase22 masking removes provider identity and exposes only ZombieCoder identity', () => {
  const raw={id:'x',object:'chat.completion',model:'real-model',provider:'real-provider',choices:[{message:{role:'assistant',content:'hello'}}]};
  const masked=maskCanonicalResponse(raw,{agentId:'code-guru'});
  assert.equal(masked.provider,'ZombieCoder');
  assert.equal(masked.model,'zombiecoder/code-guru');
  assert.equal('real-provider' in masked,false);
  assert.equal(createAgentProviderIdentity({agentId:'bug-hunter'}).provider,'ZombieCoder');
});

test('phase22 canonical tool parser extracts only tool calls and parses JSON arguments', () => {
  const calls=parseCanonicalToolCalls({choices:[{message:{tool_calls:[{id:'1',type:'function',function:{name:'read_file',arguments:'{"path":"a.txt"}'}}]}}]});
  assert.deepEqual(calls[0],{id:'1',type:'function',name:'read_file',arguments:{path:'a.txt'}});
});

test('phase22 unsupported function calling strips tools before provider request', () => {
  const result=stripUnsupportedTools({messages:[],tools:[{type:'function',function:{name:'x'}}]},{chatCompletions:true,functionCalling:false});
  assert.equal(result.stripped,true);
  assert.equal(result.input.tools,undefined);
});

test('phase22 observed provider response cannot claim verified success', () => {
  const gate=new EvidenceGate({store:memoryStore()});
  const observed=[{source:'provider:x',status:'observed',confidence:'direct-response',observedAt:new Date().toISOString(),summary:'response received'}];
  assert.equal(gate.canClaimSuccess(observed),false);
  const verified=[{source:'test:x',status:'verified',confidence:'direct-test',observedAt:new Date().toISOString(),summary:'test passed'}];
  assert.equal(gate.canClaimSuccess(verified),true);
});
