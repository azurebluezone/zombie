import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { McpConnections } from '../src/mcp/connections.js';
import { migrateJsonToSqlite } from '../src/storage/migrate-json-to-sqlite.js';

test('SQLite survives store restart and preserves application/permission/audit data', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'zc-phase6-')); const db=path.join(dir,'runtime.sqlite');
  try {
    let store=new SqliteStore(db); await store.init();
    await store.write('applications',[{id:'app_1',name:'test',createdAt:new Date().toISOString()}]);
    await store.write('mcp-permissions',[{id:'perm_1',applicationId:'app_1',qualifiedName:'mcp.tool',effect:'allow',createdAt:new Date().toISOString()}]);
    await store.write('mcp-audit',[{requestId:'req_1',outcome:'success',timestamp:new Date().toISOString()}]);
    store.close();
    store=new SqliteStore(db); await store.init();
    assert.equal((await store.read('applications')).length,1);
    assert.equal((await store.read('mcp-permissions'))[0].qualifiedName,'mcp.tool');
    assert.equal((await store.read('mcp-audit'))[0].requestId,'req_1');
    store.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('MCP connection reuses identity and expires by lease', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'zc-phase6-')); const db=path.join(dir,'runtime.sqlite');
  try {
    const store=new SqliteStore(db); await store.init(); const conns=new McpConnections(store,{leaseMs:1000});
    const a=await conns.upsert({runtimeId:'rt1',clientId:'client1'});
    const b=await conns.upsert({runtimeId:'rt1',clientId:'client1'});
    assert.equal(a.connectionId,b.connectionId); assert.equal(a.sessionId,b.sessionId);
    assert.equal((await conns.resolve({connectionId:a.connectionId})).status,'active');
    await new Promise(r=>setTimeout(r,1100));
    assert.equal(await conns.resolve({connectionId:a.connectionId}),null);
    assert.equal((await conns.list())[0].status,'expired');
    store.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('JSON migration copies supported collections into SQLite', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'zc-phase6-')); const db=path.join(dir,'runtime.sqlite');
  try {
    await writeFile(path.join(dir,'applications.json'),JSON.stringify([{id:'app_m',name:'migrated'}]));
    await writeFile(path.join(dir,'mcp-audit.json'),JSON.stringify([{requestId:'req_m',timestamp:new Date().toISOString()}]));
    const report=await migrateJsonToSqlite(dir,db);
    assert.equal(report.find(x=>x.name==='applications').migrated,true);
    const store=new SqliteStore(db); await store.init();
    assert.equal((await store.read('applications'))[0].id,'app_m');
    assert.equal((await store.read('mcp-audit'))[0].requestId,'req_m'); store.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
