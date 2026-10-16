import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyModelList, legacyProviderModelList, legacyNormalizeList } from '../src/compatibility/legacy/frontend-contract.js';
import { buildAgentSystemPrompt } from '../src/agents/system-prompt.js';
import { routeMapReport } from '../src/compatibility/route-map.js';
import { ExternalMcpRegistry } from '../src/registry/external-mcp.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { OllamaProvider } from '../src/providers/adapters/ollama.js';
import http from 'node:http';

class MemoryStore {
  constructor(data={}) { this.data=new Map(Object.entries(data)); }
  async read(k,f=[]) { return structuredClone(this.data.get(k) ?? f); }
  async write(k,v) { this.data.set(k,structuredClone(v)); }
}

test('phase39 legacy model envelopes preserve OpenAI-style list shape',()=>{
  const providers=[{id:'ollama-cloud-openai',name:'Ollama',models:['gemma4:31b'],protocol:'openai-compatible'}];
  const masked=legacyModelList({agents:[{id:'code-guru'}],providers});
  const dev=legacyProviderModelList(providers);
  assert.equal(masked.object,'list');
  assert.deepEqual(masked.data.map(x=>x.id),['zombie-mini','zombie-lite','zombie-classic']);
  assert.ok(masked.data.every(x=>x.owned_by==='ZombieCoder'));
  assert.ok(!masked.data.some(x=>x.id==='gemma4:31b'));
  assert.equal(dev.object,'list');
  assert.equal(dev.data[0].provider,'ollama-cloud-openai');
});

test('phase39 system prompt receives only runtime-resolved tool catalog',()=>{
  const prompt=buildAgentSystemPrompt({goal:'inspect',tools:['read_file'],toolCatalog:[{id:'read_file',name:'Read File',status:'VERIFIED',metadata:{toolSchema:{type:'object',required:['path']}}}]});
  assert.match(prompt,/TOOL CATALOG/);
  assert.match(prompt,/read_file/);
  assert.match(prompt,/required/);
  assert.doesNotMatch(prompt,/invent tools/); // contract contains the phrase in the no-catalog branch only
});

test('phase39 route inventory exposes admin route surface and legacy compatibility map',()=>{
  const report=routeMapReport();
  assert.ok(report.current.some(x=>x[1]==='/v1/admin/routes'));
  assert.ok(report.current.some(x=>x[1]==='/v1/admin/providers/sync'));
  assert.ok(report.legacyCompatibility.some(x=>x[1]==='/api/ssot'));
  assert.ok(report.legacyCompatibility.some(x=>x[1]==='/api/input'));
});

test('phase39 external MCP registry does not fake discovery',async()=>{
  const store=new MemoryStore();
  const mcp=new McpRegistry(store);
  const registry=new ExternalMcpRegistry({store,mcpRegistry:mcp,root:'/tmp/no-such-zc39',envObject:{EXTERNAL_MCP_OCR_URL:''}});
  const status=await registry.status();
  assert.deepEqual(status,[]);
});



test('phase39 Ollama OpenAI-compatible and native shapes work against a deterministic local fixture', async()=>{
  const server=http.createServer((req,res)=>{
    let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
      res.setHeader('content-type','application/json');
      if(req.method==='GET' && req.url==='/v1/models') return res.end(JSON.stringify({object:'list',data:[{id:'fixture-model'}]}));
      if(req.method==='POST' && req.url==='/v1/chat/completions') return res.end(JSON.stringify({id:'fixture-openai-1',object:'chat.completion',model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'openai fixture ok'},finish_reason:'stop'}]}));
      if(req.method==='GET' && req.url==='/api/tags') return res.end(JSON.stringify({models:[{name:'fixture-native'}]}));
      if(req.method==='POST' && req.url==='/api/chat') return res.end(JSON.stringify({model:'fixture-native',message:{role:'assistant',content:'native fixture ok'},done:true,done_reason:'stop'}));
      res.statusCode=404; res.end(JSON.stringify({error:'not_found'}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const networkPolicy={allowPlaintextHttp:true,allowPrivateNetwork:true};
  try {
    const openai=new OllamaProvider({id:'fixture-openai',baseUrl:`http://127.0.0.1:${port}/v1`,defaultModel:'fixture-model',mode:'openai-compatible',networkPolicy});
    const native=new OllamaProvider({id:'fixture-native',baseUrl:`http://127.0.0.1:${port}`,defaultModel:'fixture-native',mode:'native',networkPolicy});
    const openModels=await openai.listModels();
    const openRaw=await openai.chatCompletions({model:'fixture-model',messages:[{role:'user',content:'x'}]});
    const nativeModels=await native.listModels();
    const nativeRaw=await native.chatCompletions({model:'fixture-native',messages:[{role:'user',content:'x'}]});
    assert.equal(openModels.data[0].id,'fixture-model');
    assert.equal(openRaw.choices[0].message.content,'openai fixture ok');
    assert.equal(nativeModels.models[0].name,'fixture-native');
    assert.equal(native.toCanonical(nativeRaw).choices[0].message.content,'native fixture ok');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('phase39 normalizer legacy view is provider/model aware',()=>{
  const result=legacyNormalizeList({providers:[{id:'ollama-local',name:'Ollama',models:['qwen'],priority:1}],models:['qwen']});
  assert.equal(result.normalizer,'Haq Mawla Universal Response Normalizer');
  assert.deepEqual(result.models,['qwen']);
});
