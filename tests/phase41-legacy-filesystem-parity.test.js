import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { toolParityReport } from '../src/compatibility/legacy/tool-parity.js';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';

class MemoryStore {
  constructor(data={}) { this.data=new Map(Object.entries(data)); }
  async read(name,fallback=[]) { return this.data.has(name) ? structuredClone(this.data.get(name)) : structuredClone(fallback); }
  async write(name,value) { this.data.set(name,structuredClone(value)); }
}
function prepared(){ return {contract:{goal:'verify legacy filesystem contract',expectedOutcome:'legacy MCP-compatible result'},consent:{allowed:true}}; }

async function setup(t) {
  const root=await mkdtemp(path.join(tmpdir(),'zc41-parity-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore();
  const registry=new ToolRegistry(store);
  const policyStore=new MemoryStore({'tool-permissions':[]});
  const policy=new ToolPolicy(policyStore);
  const adapter=new ToolExecutionAdapter({registry,toolRoot:path.resolve('tools'),policy});
  const context={projectRoot:root,workingDirectory:root,requestId:'phase41-test'};
  for (const toolId of ['read_file','write_file','list_directory']) await policy.grant({applicationId:'phase41-app',toolId});
  return {root,adapter,context};
}

test('phase41 read_file matches legacy MCP text envelope and truncates at 100000 characters', async t=>{
  const {root,adapter,context}=await setup(t);
  const long='x'.repeat(100500);
  await writeFile(path.join(root,'long.txt'),long);
  const result=await adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'long.txt'}},applicationId:'phase41-app',context});
  assert.deepEqual(result.result,{content:[{type:'text',text:'x'.repeat(100000)}]});
  const missing=await adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'missing.txt'}},applicationId:'phase41-app',context});
  assert.deepEqual(missing.result,{content:[{type:'text',text:`File not found: ${path.join(root,'missing.txt')}`}]});
  const directory=await adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'.'}},applicationId:'phase41-app',context});
  assert.deepEqual(directory.result,{content:[{type:'text',text:`Not a file: ${root}`} ]});
});

test('phase41 write_file creates nested directories and uses legacy MCP text result', async t=>{
  const {root,adapter,context}=await setup(t);
  const result=await adapter.execute({prepared:prepared(),input:{toolId:'write_file',arguments:{path:'new/nested/hello.txt',content:'hello 🌍'}},applicationId:'phase41-app',context});
  assert.deepEqual(result.result,{content:[{type:'text',text:`Written 8 bytes to ${path.join(root,'new/nested/hello.txt')}`}]});
  assert.equal(await readFile(path.join(root,'new/nested/hello.txt'),'utf8'),'hello 🌍');
});

test('phase41 list_directory matches legacy text listing and error envelopes', async t=>{
  const {root,adapter,context}=await setup(t);
  await mkdir(path.join(root,'folder'));
  await writeFile(path.join(root,'file.txt'),'ok');
  const result=await adapter.execute({prepared:prepared(),input:{toolId:'list_directory',arguments:{path:'.'}},applicationId:'phase41-app',context});
  const text=result.result.content[0].text;
  assert.ok(text.startsWith(`Contents of ${root}:\n`));
  assert.match(text,/folder\//);
  assert.match(text,/file\.txt/);
  const missing=await adapter.execute({prepared:prepared(),input:{toolId:'list_directory',arguments:{path:'missing'}},applicationId:'phase41-app',context});
  assert.deepEqual(missing.result,{content:[{type:'text',text:`Directory not found: ${path.join(root,'missing')}`}]});
  const file=await adapter.execute({prepared:prepared(),input:{toolId:'list_directory',arguments:{path:'file.txt'}},applicationId:'phase41-app',context});
  assert.deepEqual(file.result,{content:[{type:'text',text:`Not a directory: ${path.join(root,'file.txt')}`}]});
});

test('phase41 filesystem compatibility does not weaken project-root path boundary', async t=>{
  const {root,adapter,context}=await setup(t);
  await assert.rejects(()=>adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'../outside.txt'}},applicationId:'phase41-app',context}),/execution_path_outside_project_root/);
  const outside=await mkdtemp(path.join(tmpdir(),'zc41-outside-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(path.join(outside,'secret.txt'),'nope');
  try { await symlink(path.join(outside,'secret.txt'),path.join(root,'escape.txt')); }
  catch(error) { if(error.code==='EPERM'||error.code==='EACCES'||error.code==='ENOTSUP') return; throw error; }
  await assert.rejects(()=>adapter.execute({prepared:prepared(),input:{toolId:'read_file',arguments:{path:'escape.txt'}},applicationId:'phase41-app',context}),/execution_path_symlink_escape/);
});

test('phase41 parity ledger records tested contracts without falsely claiming exact parity',()=>{
  const report=toolParityReport(COMMON_TOOLS);
  assert.equal(report.behaviorParityVerified,false);
  assert.equal(report.compatibilityContractTested,true);
  for (const id of ['read_file','write_file','list_directory']) {
    const item=report.items.find(x=>x.id===id);
    assert.equal(item.status,'compatibility-contract-tested-security-hardened');
    assert.equal(item.compatibilityContractTested,true);
    assert.equal(item.behaviorParityVerified,false);
    assert.match(item.securityDifference,/project-root containment/);
    assert.ok(item.parityEvidence);
  }
  assert.equal(report.items.find(x=>x.id==='screen_recorder').behaviorParityVerified,false);
});
