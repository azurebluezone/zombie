import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { ExecutionAdapter } from '../src/execution/execution-adapter.js';
import { ToolLoopExecutor, assembleStreamToolCalls, assembleStreamAssistant } from '../src/execution/tool-loop.js';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { EvidenceGate } from '../src/evidence/gate.js';
import { SessionService } from '../src/session/service.js';
import { SessionStateStore } from '../src/session/state.js';

class Store {
  constructor(data = {}) { this.data = new Map(Object.entries(data)); }
  async read(k, fallback = []) { return structuredClone(this.data.has(k) ? this.data.get(k) : fallback); }
  async write(k, value) { this.data.set(k, structuredClone(value)); }
}

function startProviderServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) raw += chunk;
        const result = await handler(req.url, raw ? JSON.parse(raw) : {});
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, {'content-type':'application/json'});
        res.end(JSON.stringify({error:error.message}));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({server, port:server.address().port}));
    server.on('error', reject);
  });
}

function prepared() {
  return {contract:{goal:'calculate 2+3', expectedOutcome:'answer is 5'}, consent:{allowed:true}};
}

test('automatic loop executes a registered tool, injects its result, and performs a second provider turn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase15-tool-'));
  const provider = await startProviderServer(async (url, input) => {
    assert.equal(url, '/v1/chat/completions');
    const hasToolResult = input.messages.some(m => m.role === 'tool');
    if (!hasToolResult) return {id:'r1',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'sum_numbers',arguments:'{"a":2,"b":3}'}}]},finish_reason:'tool_calls'}]};
    const toolMessage = input.messages.find(m => m.role === 'tool');
    assert.match(toolMessage.content, /"sum":5/);
    return {id:'r2',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'5'},finish_reason:'stop'}]};
  });
  try {
    await writeFile(path.join(dir, 'sum.mjs'), `export async function execute(args) { return {sum:Number(args.a)+Number(args.b)}; }\n`);
    const store = new Store();
    const providers = new ProviderRegistry(store, {ollamaBaseUrl:`http://127.0.0.1:${provider.port}/v1`,providerNetworkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
    await providers.register({id:'fixture-provider',baseUrl:`http://127.0.0.1:${provider.port}/v1`,driver:'openai-compatible',defaultModel:'fixture'});
    const tools = new ToolRegistry(store);
    await tools.register({id:'sum-tool',name:'Sum',status:'ENABLED',entry:'./sum.mjs',metadata:{toolSchema:{type:'object',required:['a','b'],properties:{a:{type:'number'},b:{type:'number'}}}}});
    const toolExecution = new ToolExecutionAdapter({registry:tools,toolRoot:dir});
    const executionAdapter = new ExecutionAdapter({provider:{execute:async()=>{throw new Error('direct provider path not expected');}},tool:toolExecution,mcp:{execute:async()=>{throw new Error('mcp path not expected');}}});
    const evidenceGate = new EvidenceGate({store});
    const sessions = new SessionService(store);
    const session = await sessions.create({applicationId:'app-a'});
    const sessionState = new SessionStateStore({store,sessions,maxMessages:20});
    const loop = new ToolLoopExecutor({providers,executionAdapter,normalizer:new CanonicalResponseNormalizer(),evidenceGate,sessionState,maxRounds:4,maxToolCallsPerRound:4,maxRepeatedCalls:2});
    const result = await loop.execute({prepared:prepared(),applicationId:'app-a',input:{provider:'fixture-provider',sessionId:session.id,autoToolLoop:true,messages:[{role:'user',content:'calculate'}],tools:[{type:'function',function:{name:'sum_numbers',description:'sum two numbers',parameters:{type:'object'}}}],toolBindings:{sum_numbers:{toolId:'sum-tool'}}}});
    assert.equal(result.status,'completed');
    assert.equal(result.stoppedReason,null);
    assert.equal(result.response.choices[0].message.content,'5');
    assert.equal(result.rounds.length,2);
    assert.equal(result.rounds[0].toolCalls[0].name,'sum_numbers');
    assert.equal(result.verified,false);
    const history=await sessionState.list(session.id,'app-a');
    assert.equal(history[0].role,'user');
    assert.equal(history.some(m=>m.role==='tool'),true);
    assert.equal(history.at(-1).content,'5');
  } finally { await new Promise(resolve=>provider.server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});

test('repeated identical tool calls stop the loop without claiming success', async () => {
  const provider = await startProviderServer(async () => ({id:'repeat',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'same',type:'function',function:{name:'sum_numbers',arguments:'{"a":2,"b":3}'}}]},finish_reason:'tool_calls'}]}));
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase15-repeat-'));
  try {
    await writeFile(path.join(dir,'sum.mjs'), `export async function execute(args) { return {sum:Number(args.a)+Number(args.b)}; }\n`);
    const store=new Store();
    const providers=new ProviderRegistry(store,{providerNetworkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
    await providers.register({id:'fixture-provider',baseUrl:`http://127.0.0.1:${provider.port}/v1`,driver:'openai-compatible',defaultModel:'fixture'});
    const tools=new ToolRegistry(store); await tools.register({id:'sum-tool',status:'ENABLED',entry:'./sum.mjs'});
    const executionAdapter=new ExecutionAdapter({provider:{execute:async()=>{}},tool:new ToolExecutionAdapter({registry:tools,toolRoot:dir}),mcp:{execute:async()=>{}}});
    const loop=new ToolLoopExecutor({providers,executionAdapter,normalizer:new CanonicalResponseNormalizer(),evidenceGate:new EvidenceGate({store}),maxRounds:8,maxRepeatedCalls:2});
    const result=await loop.execute({prepared:prepared(),applicationId:'app-a',input:{provider:'fixture-provider',autoToolLoop:true,toolBindings:{sum_numbers:{toolId:'sum-tool'}}}});
    assert.equal(result.status,'incomplete');
    assert.equal(result.stoppedReason,'repeated_tool_call_limit');
    assert.equal(result.verified,false);
    assert.equal(result.rounds.length,3);
  } finally { await new Promise(resolve=>provider.server.close(resolve)); await rm(dir,{recursive:true,force:true}); }
});

test('stream tool-call deltas assemble into one canonical assistant message', () => {
  const chunks=[
    {choices:[{index:0,delta:{role:'assistant',content:'checking '},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'lookup',arguments:'{"q":"Ba'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'risal"}'}}]},finish_reason:'tool_calls'}]}
  ];
  const calls=assembleStreamToolCalls(chunks);
  assert.equal(calls.length,1);
  assert.equal(calls[0].id,'call_1');
  assert.equal(calls[0].function.name,'lookup');
  assert.equal(calls[0].function.arguments,'{"q":"Barisal"}');
  const assistant=assembleStreamAssistant(chunks);
  assert.equal(assistant.content,'checking ');
  assert.equal(assistant.tool_calls.length,1);
  assert.equal(assistant.finish_reason,'tool_calls');
});
