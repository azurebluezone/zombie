import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SmartRouter } from '../src/providers/router/smart-router.js';
import { assertSafeOutboundUrl } from '../src/network/outbound-policy.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function memoryStore(initial={}) {
  const data = new Map(Object.entries(initial));
  return { async read(k,d){ return data.has(k) ? data.get(k) : d; }, async write(k,v){ data.set(k,v); } };
}

test('phase42 Gemini native protocol maps to runtime chat-completions contract', async () => {
  const providers = { list: async () => [
    {id:'gemini',driver:'gemini',enabled:true,priority:10,defaultModel:'gemini-test',models:['gemini-test'],capabilities:['generate-content','streaming','function-calling','model-catalog']},
    {id:'strict-native',driver:'native-other',enabled:true,priority:1,capabilities:['generate-content']}
  ]};
  const router = new SmartRouter({providers});
  const route = await router.route({provider:'gemini',model:'gemini-test'});
  assert.equal(route.providerId,'gemini');
  assert.ok(route.requiredCapabilities.includes('chat-completions'));
  await assert.rejects(() => router.route({provider:'strict-native'}), /no_provider_route_available/);
});

test('phase42 outbound private destinations remain denied unless exact private host is explicitly opted in', async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl('http://127.0.0.1:11435/v1/models', {protocols:['http:'],allowPlaintextHttp:true,allowPrivateNetwork:false}),
    /outbound_private_address_forbidden/
  );
  const safe = await assertSafeOutboundUrl('http://127.0.0.1:11435/v1/models', {
    protocols:['http:'], allowPlaintextHttp:true, allowPrivateNetwork:true, allowPrivateHosts:['127.0.0.1']
  });
  assert.equal(safe.host,'127.0.0.1');
});

test('phase42 Ollama model refresh works against an actual local HTTP endpoint with exact private-host opt-in', async () => {
  const seen=[];
  const server=http.createServer((req,res)=>{
    seen.push(req.url);
    if(req.url==='/v1/models') {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({object:'list',data:[{id:'qwen2'},{id:'llama3'}]}));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=await mkdtemp(path.join(os.tmpdir(),'zc42-'));
  let store;
  try {
    store=new SqliteStore(path.join(dir,'runtime.sqlite')); await store.init();
    const port=server.address().port;
    const config={providerApiKeys:{},providerNetworkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true,allowPrivateHosts:['127.0.0.1'],allowHosts:[]}};
    const registry=new ProviderRegistry(store,config);
    await registry.register({id:'ollama-local',driver:'ollama',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${port}/v1`,enabled:true,models:[],capabilities:['chat-completions','streaming','function-calling','model-catalog'],priority:1});
    const updated=await registry.refreshModels('ollama-local');
    assert.deepEqual(updated.models,['qwen2','llama3']);
    assert.equal(updated.defaultModel,'qwen2');
    assert.deepEqual(seen,['/v1/models']);
  } finally {
    store?.close();
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('phase42 local-host exception does not disable global allowHosts enforcement', async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl('https://example.com/v1/models', {allowHosts:['other.example']}),
    /outbound_host_not_allowlisted/
  );
});

test('phase42 Gemini adapter sends native generateContent request and canonicalizes the real HTTP response shape', async () => {
  let seen;
  const server=http.createServer((req,res)=>{
    let raw=''; req.setEncoding('utf8'); req.on('data',c=>raw+=c); req.on('end',()=>{
      seen={url:req.url,apiKey:req.headers['x-goog-api-key'],body:JSON.parse(raw)};
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({responseId:'fixture-response',modelVersion:'gemini-fixture',candidates:[{content:{role:'model',parts:[{text:'fixture answer'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2,totalTokenCount:5}}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    const provider=new GeminiProvider({
      baseUrl:`http://127.0.0.1:${port}/v1beta`,apiKey:'test-key',defaultModel:'gemini-fixture',
      networkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true,allowPrivateHosts:['127.0.0.1']}
    });
    const raw=await provider.chatCompletions({messages:[{role:'user',content:'hello'}]});
    const canonical=provider.toCanonical(raw);
    assert.equal(seen.url,'/v1beta/models/gemini-fixture:generateContent');
    assert.equal(seen.apiKey,'test-key');
    assert.equal(seen.body.contents[0].parts[0].text,'hello');
    assert.equal(canonical.choices[0].message.content,'fixture answer');
    assert.equal(canonical.usage.total_tokens,5);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
