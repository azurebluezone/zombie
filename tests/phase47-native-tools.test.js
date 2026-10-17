import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ToolRegistry} from '../src/tools/registry.js';
import {ToolExecutionAdapter} from '../src/execution/tool-adapter.js';
import {extractToolCalls} from '../src/execution/tool-call.js';
class Store { constructor(){this.data=new Map()} async read(k,f=[]){return structuredClone(this.data.has(k)?this.data.get(k):f)} async write(k,v){this.data.set(k,structuredClone(v))} }
const prepared={contract:{goal:'verify native tool',expectedOutcome:'tool result'},consent:{allowed:true}};
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'zc-phase47-'));const store=new Store();const registry=new ToolRegistry(store);const adapter=new ToolExecutionAdapter({registry,toolRoot:path.resolve('tools')});t.after(()=>rm(root,{recursive:true,force:true}));return {root,registry,adapter,run:(toolId,arguments_,extra={})=>adapter.execute({prepared,input:{toolId,arguments:arguments_},applicationId:'phase47-test',context:{projectRoot:root,workingDirectory:root,...extra}})};}
test('phase47 native create/edit/read tools operate inside the project root',async t=>{const f=await fixture(t);let r=await f.run('create_file',{path:'src/a.txt',content:'hello world'});assert.match(r.result.content[0].text,/Created/);r=await f.run('edit_file',{path:'src/a.txt',oldText:'world',newText:'ZombieCoder'});assert.match(r.result.content[0].text,/Updated/);r=await f.run('read_file',{path:'src/a.txt'});assert.equal(r.result.content[0].text,'hello ZombieCoder');});
test('phase47 delete requires explicit confirmation and refuses project root',async t=>{const f=await fixture(t);await writeFile(path.join(f.root,'x.txt'),'x');await assert.rejects(()=>f.run('delete_file',{path:'x.txt',confirm:false}),/delete_confirmation_required/);const r=await f.run('delete_file',{path:'x.txt',confirm:true});assert.match(r.result.content[0].text,/Deleted/);await assert.rejects(()=>f.run('delete_file',{path:'.',confirm:true,recursive:true}),/project_root_delete_forbidden/);});
test('phase47 search and filename discovery return bounded results',async t=>{const f=await fixture(t);await mkdir(path.join(f.root,'src'));await writeFile(path.join(f.root,'src','hello.js'),'export function greet() { return "hi"; }\n');let r=await f.run('grep_search',{pattern:'greet',maxResults:20});assert.match(r.result.content[0].text,/hello.js:1/);r=await f.run('file_search',{query:'hello'});assert.match(r.result.content[0].text,/src\/hello.js/);r=await f.run('view_symbol',{symbol:'greet'});assert.match(r.result.content[0].text,/hello.js:1/);});
test('phase47 search tools accept a path argument and never hide truncation',async t=>{
 const f=await fixture(t);const outside=await mkdtemp(path.join(tmpdir(),'zc-phase47-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 await mkdir(path.join(f.root,'src'));await writeFile(path.join(f.root,'src','needle.txt'),'unique-needle-token\n');await writeFile(path.join(outside,'far.txt'),'unique-needle-token\n');
 // default stays at the project root
 let r=await f.run('grep_search',{pattern:'unique-needle-token'});assert.match(r.result.content[0].text,/src\/needle\.txt:1/);
 // a scoped run cannot point outside its root
 await assert.rejects(()=>f.run('grep_search',{pattern:'unique-needle-token',path:outside}),/path_outside_project_root/);
 // a global run can, and the outside path is reported absolute
 r=await f.run('grep_search',{pattern:'unique-needle-token',path:outside},{allowAnyPath:true,allowAnyCommand:true});assert.match(r.result.content[0].text,/far\.txt:1/);assert.match(r.result.content[0].text,/searched /);
 // a truncated scan is announced instead of looking like "no matches"
 r=await f.run('grep_search',{pattern:'e',maxResults:1});assert.match(r.result.content[0].text,/\[truncated at 1 matches/);
 // a missing path is announced instead of looking like "no matches"
 r=await f.run('grep_search',{pattern:'x',path:path.join(f.root,'nope')});assert.match(r.result.content[0].text,/\[path not found:/);
 // the schema whitelist still rejects an invented argument
 await assert.rejects(()=>f.run('grep_search',{pattern:'x',bogus:1}),/mcp_tool_argument_unknown/);
});

test('phase47 terminal tool does not invoke shell and restricts executable list',async t=>{const f=await fixture(t);const r=await f.run('run_terminal_command',{argv:['node','--version'],timeoutMs:5000});assert.equal(r.status,'completed');assert.match(r.result.content[0].text,/v\d+/);await assert.rejects(()=>f.run('run_terminal_command',{argv:['bash','-c','echo unsafe']}),/command_not_allowlisted/);});
test('phase47 JSON sanitizer recognizes strict tool envelopes only',()=>{const parsed=extractToolCalls({choices:[{message:{role:'assistant',content:'{"tool":"read_file","arguments":{"path":"README.md"}}'}}]});assert.equal(parsed.length,1);assert.equal(parsed[0].name,'read_file');assert.deepEqual(parsed[0].arguments,{path:'README.md'});assert.deepEqual(extractToolCalls({choices:[{message:{role:'assistant',content:'Here is JSON: {"tool":"read_file","arguments":{"path":"x"}}'}}]}),[]);assert.deepEqual(extractToolCalls({choices:[{message:{role:'assistant',content:'{"tool":"read_file","arguments":{"path":"x"},"secret":"ignored"}'}}]}),[]);});
test('phase47 registry lists native tools and never ships a tool it cannot run',async()=>{const r=new ToolRegistry(new Store());const list=await r.list();for(const id of ['create_file','edit_file','delete_file','grep_search','run_terminal_command','git_status','task_planner','todo_manager'])assert.ok(list.some(x=>x.id===id&&x.entry));const unavailable=list.filter(x=>x.status==='NOT_IMPLEMENTED'||x.status==='UNVERIFIED');assert.deepEqual(unavailable.map(x=>x.id),[],'every listed tool must be runnable');for(const id of ['web_search','fetch_web_page']){const tool=list.find(x=>x.id===id);assert.ok(tool,''+id+' must be registered');assert.equal(tool.status,'ENABLED');assert.equal(tool.entry,'common/web_tools.js');}});

test('phase47 strict JSON tool fallback executes through registry when provider lacks native function calling',async t=>{
 const f=await fixture(t);let turns=0;const provider={id:'json-only',capabilities:{functionCalling:false,streaming:false},async chatCompletions(input){turns++;assert.equal(input.tools,undefined);if(turns===1)return {id:'json-1',object:'chat.completion',model:'tiny',choices:[{index:0,message:{role:'assistant',content:'{"tool":"create_file","arguments":{"path":"from-json.txt","content":"created by json fallback"}}'},finish_reason:'stop'}]};return {id:'json-2',object:'chat.completion',model:'tiny',choices:[{index:0,message:{role:'assistant',content:'File created after runtime verification.'},finish_reason:'stop'}]}}};
 const {ToolLoopExecutor}=await import('../src/execution/tool-loop.js');const {CanonicalResponseNormalizer}=await import('../src/providers/normalizer/canonical-response.js');const {ExecutionAdapter}=await import('../src/execution/execution-adapter.js');const {EvidenceGate}=await import('../src/evidence/gate.js');
 const loop=new ToolLoopExecutor({providers:{resolve:async()=>provider,resolveModel:async()=> 'tiny'},router:{route:async()=>({routeId:'test',providerId:'json-only',model:'tiny',publicModel:'zombie-mini',candidates:[{providerId:'json-only',model:'tiny'}]})},executionAdapter:new ExecutionAdapter({provider:{execute:async()=>{}},tool:f.adapter,mcp:{execute:async()=>{}}}),normalizer:new CanonicalResponseNormalizer(),evidenceGate:new EvidenceGate({store:{read:async()=>[],write:async()=>{}}})});
 const result=await loop.execute({prepared,applicationId:'phase47-test',input:{goal:'create file',expectedOutcome:'file exists',projectRoot:f.root,workingDirectory:f.root,executionContext:{projectRoot:f.root,workingDirectory:f.root},autoToolLoop:true,allowJsonToolFallback:true,toolIds:['create_file'],allowedToolIds:['create_file'],toolBindings:{create_file:{toolId:'create_file'}},tools:[{type:'function',function:{name:'create_file',parameters:{type:'object'}}}],messages:[{role:'user',content:'Create out.txt'}]}});
 assert.equal(turns,2);assert.equal(result.response.choices[0].message.content,'File created after runtime verification.');assert.equal(await readFile(path.join(f.root,'from-json.txt'),'utf8'),'created by json fallback');
});

test('phase47 router prefers declared native tool providers but keeps JSON-only providers eligible',async()=>{
 const {SmartRouter}=await import('../src/providers/router/smart-router.js');
 const router=new SmartRouter({providers:{list:async()=>[
  {id:'json-first',enabled:true,baseUrl:'https://json.example/v1',models:['tiny'],defaultModel:'tiny',capabilities:['chat-completions'],priority:1},
  {id:'native-second',enabled:true,baseUrl:'https://native.example/v1',models:['large'],defaultModel:'large',capabilities:['chat-completions','function-calling'],priority:5}
 ]}});
 const route=await router.route({tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}],allowJsonToolFallback:true});
 assert.equal(route.providerId,'native-second');assert.equal(route.candidates.length,2);assert.equal(route.candidates[1].providerId,'json-first');
});

test('phase47 provider adapter respects explicit manifest capability downgrade',async()=>{
 const {createProviderAdapter}=await import('../src/providers/adapters/factory.js');
 const adapter=createProviderAdapter({id:'small-ollama',driver:'ollama',baseUrl:'http://127.0.0.1:11434/v1',capabilities:['chat-completions','streaming','model-catalog']},{providerNetworkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
 assert.equal(adapter.capabilities.functionCalling,false);
});

test('phase47 destructive and terminal tools reject symlink escapes',async t=>{
 const f=await fixture(t);const outside=await mkdtemp(path.join(tmpdir(),'zc-phase47-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));const outsideFile=path.join(outside,'keep.txt');await writeFile(outsideFile,'keep');await symlink(outsideFile,path.join(f.root,'link.txt'));
 await assert.rejects(()=>f.run('delete_file',{path:'link.txt',confirm:true}),/symlink_delete_forbidden/);assert.equal(await readFile(outsideFile,'utf8'),'keep');
 await symlink(outside,path.join(f.root,'external-dir'));
 await assert.rejects(()=>f.run('run_terminal_command',{argv:['node','--version'],cwd:'external-dir'}),/execution_path_symlink_escape/);
});
