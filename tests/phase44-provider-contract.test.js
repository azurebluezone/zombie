import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { SmartRouter } from '../src/providers/router/smart-router.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';
import { ProviderExecutionAdapter } from '../src/execution/provider-adapter.js';
import { legacyModelList } from '../src/compatibility/legacy/frontend-contract.js';
import { mergeProviderCatalog } from '../src/providers/sync.js';

function memoryStore(initial={}) {
  const data = new Map(Object.entries(initial));
  return { async read(k,d){ return structuredClone(data.has(k) ? data.get(k) : d); }, async write(k,v){ data.set(k,structuredClone(v)); } };
}

const localPolicy = {allowPlaintextHttp:true,allowPrivateNetwork:true,allowPrivateHosts:['127.0.0.1'],allowHosts:[],maxResponseBytes:1_000_000};

test('phase44 OpenAI-compatible stream normalization preserves delta fields and Bengali fragments', () => {
  const normalizer = new CanonicalResponseNormalizer();
  const a = normalizer.normalize({id:'chunk-1',object:'chat.completion.chunk',created:7,choices:[{index:0,delta:{content:'বাংলা জো'},finish_reason:null}]},{model:'real-upstream',providerId:'fixture'});
  const b = normalizer.normalize({id:'chunk-2',object:'chat.completion.chunk',choices:[{index:0,delta:{content:'ড়া 👨‍👩‍👧‍👦'},finish_reason:null}]},{model:'real-upstream',providerId:'fixture'});
  assert.equal(a.object,'chat.completion.chunk');
  assert.equal(a.choices[0].delta.content + b.choices[0].delta.content, 'বাংলা জোড়া 👨‍👩‍👧‍👦');
  assert.equal(a.id,'chunk-1');
  assert.equal(a.choices[0].message, undefined);
});

test('phase44 ZombieCoder public catalog hides upstream IDs and routes aliases by provider priority/model mapping', async () => {
  const providers = { list: async () => [
    {id:'second',enabled:true,priority:2,models:['real-b'],defaultModel:'real-b',modelAliases:{'zombie-mini':'real-b'},capabilities:['chat-completions','streaming','function-calling']},
    {id:'first',enabled:true,priority:1,models:['real-a','real-classic'],defaultModel:'real-a',modelAliases:{'zombie-mini':'real-a','zombie-classic':'real-classic'},capabilities:['chat-completions','streaming','function-calling']}
  ]};
  const router = new SmartRouter({providers});
  const route = await router.route({model:'zombie-mini'});
  assert.equal(route.providerId,'first');
  assert.equal(route.model,'real-a');
  assert.equal(route.publicModel,'zombie-mini');
  const catalog = legacyModelList({providers:await providers.list()});
  assert.deepEqual(catalog.data.map(x=>x.id),['zombie-mini','zombie-lite','zombie-classic']);
  assert.ok(catalog.data.every(x=>x.owned_by==='ZombieCoder'));
  assert.ok(!JSON.stringify(catalog).includes('real-a'));
});

test('phase44 registry clamps priority to 1..10 and persists alias mapping without persisting apiKey', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'zc44-reg-'));
  let store;
  try {
    store=new SqliteStore(path.join(dir,'runtime.sqlite')); await store.init();
    const registry=new ProviderRegistry(store,{providerApiKeys:{fixture:'env-secret'},providerNetworkPolicy:localPolicy});
    const item=await registry.register({id:'fixture',name:'Fixture',baseUrl:'https://example.invalid/v1',apiKey:'must-not-persist',priority:99,defaultModel:'model-a',modelAliases:{'Zombie-Mini':'model-a'}});
    assert.equal(item.priority,10);
    assert.equal(item.modelAliases['zombie-mini'],'model-a');
    const persisted=await store.read('providers',[]);
    assert.equal('apiKey' in persisted[0],false);
    assert.equal(JSON.stringify(persisted).includes('must-not-persist'),false);
  } finally { store?.close(); await rm(dir,{recursive:true,force:true}); }
});

test('phase44 Gemini model discovery strips resource prefix and authentication header is sent', async () => {
  let seenAuth='';
  const server=http.createServer((req,res)=>{
    seenAuth=req.headers['x-goog-api-key'] ?? '';
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({models:[{name:'models/gemini-fixture',displayName:'Fixture'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const provider=new GeminiProvider({baseUrl:`http://127.0.0.1:${server.address().port}/v1beta`,apiKey:'fixture-key',networkPolicy:localPolicy});
    const raw=await provider.listModels();
    assert.equal(seenAuth,'fixture-key');
    assert.equal(raw.data[0].id,'gemini-fixture');
    const payload=provider.payload({messages:[{role:'system',content:'system contract'},{role:'user',content:'hi'}],max_tokens:123,top_p:0.4,tools:[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}}],tool_choice:'required'});
    assert.equal(payload.systemInstruction.parts[0].text,'system contract');
    assert.equal(payload.contents.length,1);
    assert.equal(payload.generationConfig.maxOutputTokens,123);
    assert.equal(payload.generationConfig.topP,0.4);
    assert.equal(payload.toolConfig.functionCallingConfig.mode,'ANY');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('phase44 provider model refresh verifies a reachable authenticated model endpoint and persists IDs', async () => {
  let auth='';
  const server=http.createServer((req,res)=>{
    auth=req.headers.authorization ?? '';
    res.writeHead(auth==='Bearer fixture-key'?200:401,{'content-type':'application/json'});
    res.end(auth==='Bearer fixture-key'?JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}):JSON.stringify({error:'unauthorized'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=await mkdtemp(path.join(os.tmpdir(),'zc44-refresh-'));
  let store;
  try {
    store=new SqliteStore(path.join(dir,'runtime.sqlite')); await store.init();
    const registry=new ProviderRegistry(store,{providerApiKeys:{fixture:'fixture-key'},providerNetworkPolicy:localPolicy});
    await registry.register({id:'fixture',driver:'openai-compatible',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,enabled:true,models:[],priority:1});
    const updated=await registry.refreshModels('fixture');
    assert.equal(auth,'Bearer fixture-key');
    assert.deepEqual(updated.models,['model-a','model-b']);
    assert.equal(updated.defaultModel,'model-a');
    assert.deepEqual((await store.read('providers',[])).find(p=>p.id==='fixture').models,['model-a','model-b']);
  } finally { store?.close(); await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});


test('phase44 provider catalog sync never persists secrets from existing records or remote catalogs', () => {
  const merged=mergeProviderCatalog([{id:'fixture',name:'Fixture',baseUrl:'https://old.example/v1',apiKey:'old-secret',priority:20}], {
    providers:[{id:'fixture',name:'Updated Fixture',baseUrl:'https://new.example/v1',apiKey:'remote-secret',priority:2}],
    models:[{providerId:'fixture',id:'model-a'}]
  });
  assert.equal(merged[0].name,'Updated Fixture');
  assert.equal(merged[0].priority,2);
  assert.equal(merged[0].models.includes('model-a'),true);
  assert.equal('apiKey' in merged[0],false);
  assert.equal(JSON.stringify(merged).includes('secret'),false);
});


test('phase44 streaming falls back to non-streaming response when a provider emits no usable chunks', async () => {
  const providers = {
    list: async () => [{id:'fixture',enabled:true,priority:1,models:['real-model'],defaultModel:'real-model',capabilities:['chat-completions','streaming']}],
    resolve: async () => ({
      id:'fixture', capabilities:{chatCompletions:true,streaming:true},
      async streamChat(_input,_onChunk) { return; },
      async chatCompletions() { return {id:'complete-1',object:'chat.completion',model:'real-model',choices:[{index:0,message:{role:'assistant',content:'fallback answer'},finish_reason:'stop'}]}; }
    }),
    resolveModel: async (_id,model) => model || 'real-model'
  };
  const adapter = new ProviderExecutionAdapter({providers,normalizer:new CanonicalResponseNormalizer()});
  const chunks=[];
  const result=await adapter.stream({prepared:{consent:{allowed:true},contract:{goal:'answer'}},input:{model:'real-model',messages:[{role:'user',content:'hello'}]},onChunk:chunk=>chunks.push(chunk)});
  assert.equal(result.status,'completed_unverified');
  assert.equal(chunks.length,1);
  assert.equal(chunks[0].choices[0].delta.content,'fallback answer');
});


test('phase44 registry migrates legacy priorities into persistent 1..10 slots while preserving relative order', async () => {
  const store=memoryStore({providers:[
    {id:'legacy-a',name:'A',baseUrl:'https://a.example/v1',enabled:true,priority:100,models:['a']},
    {id:'legacy-b',name:'B',baseUrl:'https://b.example/v1',enabled:true,priority:200,models:['b']}
  ]});
  const registry=new ProviderRegistry(store,{providerApiKeys:{},providerNetworkPolicy:{}});
  const providers=await registry.list();
  assert.equal(providers.find(p=>p.id==='legacy-a').priority,1);
  assert.equal(providers.find(p=>p.id==='legacy-b').priority,2);
  assert.deepEqual((await store.read('providers',[])).map(p=>p.priority),[1,2]);
});


test('phase44 stream failover tries the next provider only before any chunk was emitted', async () => {
  const calls=[];
  const providers={
    list:async()=>[
      {id:'first',enabled:true,priority:1,models:['model-a'],defaultModel:'model-a',capabilities:['chat-completions','streaming']},
      {id:'second',enabled:true,priority:2,models:['model-b'],defaultModel:'model-b',capabilities:['chat-completions','streaming']}
    ],
    resolve:async id=>({id,capabilities:{chatCompletions:true,streaming:true},async streamChat(_input,onChunk){calls.push(id); if(id==='first') throw new Error('connection_refused'); onChunk({id:'c2',object:'chat.completion.chunk',choices:[{index:0,delta:{content:'backup'},finish_reason:null}]}); },async chatCompletions(){throw new Error('unexpected_nonstream_fallback');}}),
    resolveModel:async (_id,model)=>model
  };
  const adapter=new ProviderExecutionAdapter({providers,normalizer:new CanonicalResponseNormalizer()});
  const chunks=[];
  const result=await adapter.stream({prepared:{consent:{allowed:true},contract:{goal:'stream'}},input:{messages:[{role:'user',content:'hi'}]},onChunk:chunk=>chunks.push(chunk)});
  assert.equal(result.providerId,'second');
  assert.deepEqual(calls,['first','second']);
  assert.equal(chunks[0].choices[0].delta.content,'backup');
});

test('phase44 stream does not replay through another provider after partial output', async () => {
  const calls=[];
  const providers={
    list:async()=>[
      {id:'first',enabled:true,priority:1,models:['model-a'],defaultModel:'model-a',capabilities:['chat-completions','streaming']},
      {id:'second',enabled:true,priority:2,models:['model-b'],defaultModel:'model-b',capabilities:['chat-completions','streaming']}
    ],
    resolve:async id=>({id,capabilities:{chatCompletions:true,streaming:true},async streamChat(_input,onChunk){calls.push(id); onChunk({id:'partial',object:'chat.completion.chunk',choices:[{index:0,delta:{content:'partial'},finish_reason:null}]}); throw new Error('connection_lost'); },async chatCompletions(){throw new Error('unexpected_nonstream_fallback');}}),
    resolveModel:async (_id,model)=>model
  };
  const adapter=new ProviderExecutionAdapter({providers,normalizer:new CanonicalResponseNormalizer()});
  await assert.rejects(()=>adapter.stream({prepared:{consent:{allowed:true},contract:{goal:'stream'}},input:{messages:[{role:'user',content:'hi'}]},onChunk:()=>{}}),/connection_lost/);
  assert.deepEqual(calls,['first']);
});
