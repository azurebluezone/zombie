import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { McpAudit } from '../src/mcp/audit.js';
import { McpReconciliation } from '../src/mcp/reconciliation.js';

test('reconciliation marks stale started execution as incomplete, never success', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'zc-phase7-')); const db=path.join(dir,'runtime.sqlite');
  try {
    const store=new SqliteStore(db); await store.init(); const audit=new McpAudit(store); const r=new McpReconciliation(audit,{graceMs:0});
    const old=new Date(Date.now()-1000).toISOString();
    await audit.append({requestId:'req_crash',applicationId:'app1',qualifiedName:'ep.tool',stage:'request',outcome:'started',timestamp:old});
    const found=await r.findIncomplete(); assert.equal(found.length,1); assert.equal(found[0].requestId,'req_crash');
    const result=await r.reconcile(); assert.equal(result.scanned,1); assert.equal(result.recovered.length,1);
    const events=await audit.list(100); assert.equal(events.some(e=>e.requestId==='req_crash'&&e.outcome==='success'),false); assert.equal(events.some(e=>e.requestId==='req_crash'&&e.outcome==='incomplete'),true);
    assert.equal((await r.findIncomplete()).length,0); store.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('completed execution is never classified as incomplete', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'zc-phase7-')); const db=path.join(dir,'runtime.sqlite');
  try {
    const store=new SqliteStore(db); await store.init(); const audit=new McpAudit(store); const r=new McpReconciliation(audit,{graceMs:0});
    const old=new Date(Date.now()-1000).toISOString();
    await audit.append({requestId:'req_ok',applicationId:'app1',qualifiedName:'ep.tool',stage:'request',outcome:'started',timestamp:old});
    await audit.append({requestId:'req_ok',applicationId:'app1',qualifiedName:'ep.tool',stage:'result',outcome:'success',timestamp:old});
    assert.equal((await r.findIncomplete()).length,0); store.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
