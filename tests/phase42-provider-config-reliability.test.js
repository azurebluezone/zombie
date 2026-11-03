import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SmartRouter } from '../src/providers/router/smart-router.js';
import { assertSafeOutboundUrl } from '../src/network/outbound-policy.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function memoryStore(initial={}) {
  const data = new Map(Object.entries(initial));
  return { async read(k,d){ return data.has(k) ? data.get(k) : d; }, async write(k,v){ data.set(k,v); } };
}

test('phase42 a shipped placeholder model is named instead of sent upstream', async () => {
  const store = memoryStore({providers:[
    {id:'gemini',enabled:true,priority:4,defaultModel:'REPLACE_WITH_SUPPORTED_GEMINI_MODEL',models:[]},
    {id:'groq',enabled:true,priority:5,defaultModel:'REPLACE_WITH_SUPPORTED_GROQ_MODEL',models:['a-real-model']}
  ]});
  const registry = new ProviderRegistry(store, {});
  // Sending the placeholder upstream produced an opaque provider_http_error about a
  // model the provider never received. The operator needs to be told which line to fix.
  await assert.rejects(() => registry.resolveModel('gemini'), /provider_model_not_configured/);
  await assert.rejects(() => registry.resolveModel('groq'), /provider_model_not_configured/);
  // An explicitly requested model still works even while the default is unset.
  assert.equal(await registry.resolveModel('gemini','gemini-3.8-flash'),'gemini-3.8-flash');
});

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

test('phase42 a placeholder default discovers the real catalog before the probe', async () => {
  let hits = 0;
  const server=http.createServer((req,res)=>{
    hits += 1;
    if (req.url === '/v1/models') {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({object:'list',data:[{id:'discovered-chat'},{id:'discovered-chat-2'}]}));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=await mkdtemp(path.join(os.tmpdir(),'zc42-discover-'));
  let store;
  try {
    store=new SqliteStore(path.join(dir,'runtime.sqlite')); await store.init();
    const port=server.address().port;
    const config={providerApiKeys:{},providerNetworkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true,allowPrivateHosts:['127.0.0.1'],allowHosts:[]}};
    const registry=new ProviderRegistry(store,config);
    await registry.register({id:'placeholder',driver:'openai-compatible',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${port}/v1`,enabled:true,defaultModel:'REPLACE_WITH_SUPPORTED_MODEL',models:[],capabilities:['chat-completions','streaming','model-catalog'],priority:2});
    await assert.rejects(() => registry.resolveModel('placeholder'), /provider_model_not_configured/);
    assert.equal(await registry.resolveModelOrDiscover('placeholder'), 'discovered-chat');
    const stored=(await registry.list()).find(p=>p.id==='placeholder');
    assert.deepEqual(stored.models,['discovered-chat','discovered-chat-2']);
    assert.equal(stored.defaultModel,'discovered-chat');
    assert.equal(hits,1,'the catalog is fetched once, not on every resolve');
  } finally {
    store?.close();
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('phase42 provider env reload reads the file instead of the boot-time process env', async () => {
  const { reloadEnvKeys } = await import('../src/config/env-loader.js');
  const dir=await mkdtemp(path.join(os.tmpdir(),'zc42-env-'));
  const previous={config:process.env.PROVIDER_CONFIG_JSON,key:process.env.PROVIDER_KEY_RELOAD_TEST,port:process.env.PORT};
  try {
    await writeFile(path.join(dir,'.env'),'PROVIDER_CONFIG_JSON=[{"id":"fresh"}]\nPROVIDER_KEY_RELOAD_TEST=fresh-key\nPORT=1234\n','utf8');
    const result=reloadEnvKeys({keys:['PROVIDER_CONFIG_JSON'],prefixes:['PROVIDER_KEY_'],cwd:dir});
    assert.deepEqual(result.updated.sort(),['PROVIDER_CONFIG_JSON','PROVIDER_KEY_RELOAD_TEST']);
    assert.equal(process.env.PROVIDER_KEY_RELOAD_TEST,'fresh-key');
    assert.equal(process.env.PORT,previous.port,'non-provider keys keep the boot value');
  } finally {
    for (const [name,value] of [['PROVIDER_CONFIG_JSON',previous.config],['PROVIDER_KEY_RELOAD_TEST',previous.key],['PORT',previous.port]]) {
      if (value === undefined) delete process.env[name]; else process.env[name]=value;
    }
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

// A provider the operator turned off in the admin console used to come back on the next
// restart, because the boot seed re-declared `enabled: true` and the carry-forward step
// did not preserve the stored value. The seed still wins when it speaks; it just has to
// stop overwriting a decision it never made.
test('phase42 an operator-disabled provider stays disabled when the seed is silent', async () => {
  const { carryForwardProviderState } = await import('../src/startup/provider-bootstrap.js');
  const stored = { id: 'gemini', enabled: false, models: ['gemini-3.8-flash'], defaultModel: 'gemini-3.8-flash' };
  const seedWithoutEnabled = { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', driver: 'gemini' };
  const merged = carryForwardProviderState(stored, seedWithoutEnabled);
  assert.equal(merged.enabled, false, 'the stored disable must survive a silent seed');
});

test('phase42 a seed that declares enabled still wins over the stored value', async () => {
  const { carryForwardProviderState } = await import('../src/startup/provider-bootstrap.js');
  const stored = { id: 'gemini', enabled: false };
  const merged = carryForwardProviderState(stored, { id: 'gemini', enabled: true });
  assert.equal(merged.enabled, true, 'the seed is the authority when it declares the field');
  const mergedOff = carryForwardProviderState({ id: 'groq', enabled: true }, { id: 'groq', enabled: false });
  assert.equal(mergedOff.enabled, false);
});

test('phase42 a first boot with no stored row takes the seed as-is', async () => {
  const { carryForwardProviderState } = await import('../src/startup/provider-bootstrap.js');
  assert.deepEqual(carryForwardProviderState(undefined, { id: 'gemini', enabled: true }), { id: 'gemini', enabled: true });
});
