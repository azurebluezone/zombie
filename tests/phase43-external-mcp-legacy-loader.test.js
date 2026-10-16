import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalMcpRegistry } from '../src/registry/external-mcp.js';

async function fixture(t, servers, envObject={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'zc-phase43-'));
  await writeFile(path.join(root,'servers.json'),JSON.stringify({servers}));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registered=[];
  const mcpRegistry={
    list:async()=>[],
    register:async input=>{registered.push(input); return {id:input.id,url:input.url,status:'registered',enabled:true,tools:[]};}
  };
  const registry=new ExternalMcpRegistry({store:{read:async()=>[],write:async()=>{}},mcpRegistry,root,envObject});
  return {registry,registered};
}

test('phase43 preserves legacy EXTERNAL_MCP_URLS list without misreading it as a single named URL', async t=>{
  const {registry}=await fixture(t,[],{EXTERNAL_MCP_URLS:'https://one.example/mcp,https://two.example/mcp'});
  const defs=await registry.definitions();
  assert.equal(defs.length,2);
  assert.deepEqual(defs.map(x=>x.id),['one.example','two.example']);
});

test('phase43 disabled legacy server is not registered', async t=>{
  const {registry,registered}=await fixture(t,[{id:'disabled-one',url:'https://example.test/mcp',enabled:false}]);
  const result=await registry.sync();
  assert.equal(result.definitions[0].status,'disabled');
  assert.equal(registered.length,0);
  assert.equal((await registry.status())[0].status,'disabled');
});

test('phase43 conflicting declarations with the same ID fail closed before registration', async t=>{
  const {registry,registered}=await fixture(t,[{id:'same',url:'https://one.example/mcp'}],{EXTERNAL_MCP_SAME_URL:'https://two.example/mcp'});
  const result=await registry.sync();
  assert.equal(registered.length,0);
  assert.ok(result.definitions.every(x=>x.status==='identity_conflict'));
});

test('phase43 duplicate folder and environment URL declarations collapse to one registration', async t=>{
  const url='https://one.example/mcp';
  const {registry,registered}=await fixture(t,[{id:'one',url}],{EXTERNAL_MCP_ONE_URL:url});
  const result=await registry.sync();
  assert.equal(registered.length,1);
  assert.equal(result.definitions.length,1);
  assert.equal(result.definitions[0].status,'registered');
});

test('phase43 registration errors expose stable error codes, not arbitrary secret-bearing messages', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'zc-phase43-'));
  await writeFile(path.join(root,'servers.json'),JSON.stringify({servers:[{id:'broken',url:'https://example.test/mcp'}]}));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registry=new ExternalMcpRegistry({store:{read:async()=>[],write:async()=>{}},root,envObject:{},mcpRegistry:{list:async()=>[],register:async()=>{throw new Error('Authorization: Bearer super-secret-token')}}});
  const result=await registry.sync();
  assert.equal(result.definitions[0].status,'error');
  assert.equal(result.definitions[0].error,'external_mcp_registration_failed');
  assert.ok(!JSON.stringify(result).includes('super-secret-token'));
});
