import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { bootstrapProviders, parseProviderBootConfig } from '../src/startup/provider-bootstrap.js';
import { OllamaProvider } from '../src/providers/adapters/ollama.js';

const silentLogger = { info: async()=>{}, warn: async()=>{} };

function server() {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({method:req.method, url:req.url, authorization:req.headers.authorization ?? null});
    if (req.url === '/v1/models') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({object:'list', data:[{id:'mock-model'}]}));
    }
    if (req.url === '/api/tags') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({models:[{name:'mock-native'}]}));
    }
    if (req.url === '/api/chat') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({model:'mock-native',message:{role:'assistant',content:'ok'},done:true}));
    }
    res.writeHead(404); res.end();
  });
  return {srv, seen};
}

test('phase36 provider bootstrap upserts env configuration into SQLite and survives restart', async()=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),'zc36-'));
  const file = path.join(dir,'runtime.sqlite');
  try {
    const store = new SqliteStore(file); await store.init();
    const config = {providerApiKeys:{},providerNetworkPolicy:{}};
    const registry = new ProviderRegistry(store, config);
    const first = await bootstrapProviders({registry,config,logger:silentLogger,bootConfig:[{id:'boot-provider',name:'Boot Provider',baseUrl:'https://example.invalid/v1',defaultModel:'model-a',enabled:true}]});
    assert.equal(first.registered[0].id,'boot-provider');
    assert.equal((await store.read('providers',[])).find(p=>p.id==='boot-provider').defaultModel,'model-a');

    const secondRegistry = new ProviderRegistry(store, config);
    await bootstrapProviders({registry:secondRegistry,config,logger:silentLogger,bootConfig:[{id:'boot-provider',name:'Boot Provider',baseUrl:'https://example.invalid/v1',defaultModel:'model-b',enabled:true}]});
    const persisted = await store.read('providers',[]);
    assert.equal(persisted.filter(p=>p.id==='boot-provider').length,1);
    assert.equal(persisted.find(p=>p.id==='boot-provider').defaultModel,'model-b');
    assert.equal(JSON.stringify(persisted).includes('apiKey'), false);
    store.close();
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('phase36 native Ollama adapter sends bearer key to native cloud-shaped endpoints', async()=>{
  const {srv,seen}=server();
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const port=srv.address().port;
  try {
    const provider = new OllamaProvider({id:'ollama-cloud-native',baseUrl:`http://127.0.0.1:${port}`,apiKey:'test-key',defaultModel:'mock-native',mode:'native',networkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
    const models=await provider.listModels();
    assert.equal(models.models[0].name,'mock-native');
    await provider.chatCompletions({messages:[{role:'user',content:'hi'}]});
    assert.deepEqual(seen.slice(0,2).map(x=>x.authorization),['Bearer test-key','Bearer test-key']);
  } finally { srv.close(); }
});

test('phase36 documented Ollama cloud OpenAI and native boot shapes parse cleanly',()=>{
  const raw=[
    {id:'ollama-cloud-openai',driver:'ollama',mode:'openai-compatible',baseUrl:'https://ollama.com/v1',defaultModel:'model',enabled:false},
    {id:'ollama-cloud-native',driver:'ollama',mode:'native',baseUrl:'https://ollama.com',defaultModel:'model',enabled:false}
  ];
  const parsed=parseProviderBootConfig(JSON.stringify(raw));
  assert.equal(parsed[0].baseUrl,'https://ollama.com/v1');
  assert.equal(parsed[1].mode,'native');
});
