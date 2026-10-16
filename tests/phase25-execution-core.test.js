import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExecutionContext } from '../src/execution/context.js';
import { resolveExecutionPath } from '../src/execution/path-boundary.js';
import { sanitizeSessionMetadata } from '../src/session/metadata.js';
import { createStore } from '../src/storage/storage.js';
import { ToolPolicy } from '../src/tools/policy.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { ToolRegistry } from '../src/tools/registry.js';

test('phase25 execution context keeps runtime identity and omits arbitrary metadata',()=>{
  const c=createExecutionContext({applicationId:'a',requestId:'r',goal:'g',providerId:'secret-provider',model:'secret-model',workingDirectory:'/x'},{runtimeId:'rt',instanceId:'in'});
  assert.equal(c.runtimeId,'rt'); assert.equal(c.instanceId,'in'); assert.equal(c.providerId,'secret-provider'); assert.equal(c.model,'secret-model'); assert.equal(c.ip,undefined);
});

test('phase25 path boundary blocks traversal and symlink escape',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'zc-p25-root-')); const outside=await mkdtemp(path.join(tmpdir(),'zc-p25-out-'));
  await writeFile(path.join(root,'ok.txt'),'ok'); await writeFile(path.join(outside,'secret.txt'),'secret');
  await symlink(outside,path.join(root,'link'));
  assert.equal(await resolveExecutionPath('ok.txt',{projectRoot:root,mustExist:true}),path.join(root,'ok.txt'));
  await assert.rejects(()=>resolveExecutionPath('../secret.txt',{projectRoot:root}),/outside_project_root/);
  await assert.rejects(()=>resolveExecutionPath('link/secret.txt',{projectRoot:root,mustExist:true}),/symlink_escape/);
});

test('phase25 session metadata is allowlisted',()=>{
  const x=sanitizeSessionMetadata({editor:'vscode',clientId:'c',authorization:'secret',apiKey:'secret',ip:'1.2.3.4'});
  assert.deepEqual(x,{editor:'vscode',clientId:'c'});
});

test('phase25 tool policy is default deny when policy is connected',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'zc-p25-store-')); const store=await createStore({sqlitePath:path.join(root,'runtime.sqlite'),dataDir:root});
  const policy=new ToolPolicy(store); assert.equal(await policy.allowed('app','tool'),false); await policy.grant({applicationId:'app',toolId:'tool'}); assert.equal(await policy.allowed('app','tool'),true);
});

test('phase25 tool adapter rejects unpermitted tool before module execution',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'zc-p25-tool-')); const store=await createStore({sqlitePath:path.join(root,'runtime.sqlite'),dataDir:root});
  const registry=new ToolRegistry(store); const entry=path.join(root,'tool.js'); await writeFile(entry,'export function execute(){ throw new Error("MUST_NOT_RUN") }');
  await registry.register({id:'tool',type:'tool',version:'1.0.0',entry,status:'VERIFIED',enabled:true,metadata:{toolSchema:{type:'object'}}});
  const adapter=new ToolExecutionAdapter({registry,toolRoot:root,policy:new ToolPolicy(store)});
  await assert.rejects(()=>adapter.execute({prepared:{consent:{allowed:true},contract:{goal:'g'}},input:{toolId:'tool',arguments:{}},applicationId:'app'}),/tool_not_permitted/);
});

test('phase25 permitted tool receives a canonical project path',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'zc-p25-permitted-')); await writeFile(path.join(root,'input.txt'),'ok');
  const store=await createStore({sqlitePath:path.join(root,'runtime.sqlite'),dataDir:root}); const registry=new ToolRegistry(store);
  const entry=path.join(root,'tool.js'); await writeFile(entry,'export function execute(args){ return args.path }');
  await registry.register({id:'path-tool',type:'tool',version:'1.0.0',entry:entry,status:'VERIFIED',enabled:true,metadata:{toolSchema:{type:'object',properties:{path:{type:'string'}},required:['path']},pathArguments:['path'],pathMustExist:true}});
  const policy=new ToolPolicy(store); await policy.grant({applicationId:'app',toolId:'path-tool'});
  const adapter=new ToolExecutionAdapter({registry,toolRoot:root,policy});
  const result=await adapter.execute({prepared:{consent:{allowed:true},contract:{goal:'read',expectedOutcome:null}},input:{toolId:'path-tool',arguments:{path:'input.txt'}},applicationId:'app',context:{projectRoot:root,workingDirectory:root,requestId:'r1'}});
  assert.equal(result.result,path.join(root,'input.txt'));
});
