import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { CapabilityConfigResolver } from '../src/registry/config-resolver.js';
import { ExternalMcpRegistry } from '../src/registry/external-mcp.js';
import { McpRegistry } from '../src/mcp/registry.js';

class MemoryStore {
  constructor(data={}) { this.data=new Map(Object.entries(data)); }
  async read(name,fallback=[]) { return this.data.has(name) ? structuredClone(this.data.get(name)) : structuredClone(fallback); }
  async write(name,value) { this.data.set(name,structuredClone(value)); }
}

function prepared(){return {contract:{goal:'test tool',expectedOutcome:'tool returns evidence'},consent:{allowed:true}};}

test('common tools are registered from one shared registry and do not duplicate', async()=>{
  const store=new MemoryStore();
  const registry=new ToolRegistry(store);
  const first=await registry.list();
  const second=await registry.list();
  assert.ok(first.some(x=>x.id==='read_file'));
  assert.ok(first.some(x=>x.id==='write_file'));
  assert.equal(second.filter(x=>x.id==='read_file').length,1);
  assert.equal(second.filter(x=>x.id==='write_file').length,1);
});

test('read_file and write_file execute through the real tool adapter with path boundary', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zc29-tool-'));
  try {
    const store=new MemoryStore();
    const registry=new ToolRegistry(store);
    const policyStore=new MemoryStore({'tool-permissions':[{id:'p1',applicationId:'app1',toolId:'write_file',effect:'allow'}]});
    const policy=new ToolPolicy(policyStore);
    const adapter=new ToolExecutionAdapter({registry,toolRoot:path.resolve('tools'),policy});
    const context={projectRoot:dir,workingDirectory:dir,requestId:'test'};
    const write=await adapter.execute({prepared:prepared(),input:{toolId:'write_file',arguments:{path:'hello.txt',content:'hello'}},applicationId:'app1',context});
    assert.equal(write.status,'completed');
    assert.equal(await readFile(path.join(dir,'hello.txt'),'utf8'),'hello');
    await policy.grant({applicationId:'app1',toolId:'read_file'});
    const read=await adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'hello.txt'}},applicationId:'app1',context});
    assert.deepEqual(read.result.content,[{type:'text',text:'hello'}]);
    await assert.rejects(()=>adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'../outside.txt'}},applicationId:'app1',context}),/execution_path_outside_project_root/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('database capability setting wins over environment fallback', async()=>{
  const store=new MemoryStore({applications:[{id:'app1',capabilities:{tools:{read_file:{enabled:false}}}}],'tool-permissions':[{id:'p',applicationId:'app1',toolId:'read_file',effect:'allow'}]});
  const resolver=new CapabilityConfigResolver({store,envObject:{ZOMBIECODER_TOOL_READ_FILE:'true'}});
  const setting=await resolver.toolSetting('app1','read_file');
  assert.deepEqual(setting,{enabled:false,source:'database',explicit:true});
  const policy=new ToolPolicy(store,{configResolver:resolver});
  assert.equal(await policy.allowed('app1','read_file'),false);
});

test('environment fallback is used only when database value is absent', async()=>{
  const store=new MemoryStore({applications:[{id:'app1',capabilities:{tools:{}}}],'tool-permissions':[{id:'p',applicationId:'app1',toolId:'read_file',effect:'allow'}]});
  const resolver=new CapabilityConfigResolver({store,envObject:{ZOMBIECODER_TOOL_READ_FILE:'true'}});
  const setting=await resolver.toolSetting('app1','read_file');
  assert.equal(setting.enabled,true);
  assert.equal(setting.source,'environment');
  const policy=new ToolPolicy(store,{configResolver:resolver});
  assert.equal(await policy.allowed('app1','read_file'),true);
});

test('external MCP registry imports environment definitions without pretending discovery', async()=>{
  const store=new MemoryStore();
  const mcp=new McpRegistry(store);
  const registry=new ExternalMcpRegistry({store,mcpRegistry:mcp,root:path.join(tmpdir(),'zc29-no-folder'),envObject:{EXTERNAL_MCP_URLS:'https://example.com/mcp'}});
  const sync=await registry.sync();
  assert.equal(sync.environmentCount,1);
  assert.equal(sync.definitions[0].status,'registered');
  const status=await registry.status();
  assert.equal(status[0].configurationSource,'database');
  assert.equal(status[0].status,'registered');
  assert.equal(status[0].tools,0);
});
