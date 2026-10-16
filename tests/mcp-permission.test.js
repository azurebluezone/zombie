import test from 'node:test';
import assert from 'node:assert/strict';
import { McpPermissions } from '../src/mcp/permissions.js';

function store() { const m=new Map(); return { async read(k,f){return m.has(k)?m.get(k):f;}, async write(k,v){m.set(k,v);} }; }

test('MCP permission denies an application until explicitly granted', async () => {
  const p = new McpPermissions(store());
  assert.equal(await p.allowed('app_1','mcp_1.fetch'), false);
  await p.grant({applicationId:'app_1',qualifiedName:'mcp_1.fetch'});
  assert.equal(await p.allowed('app_1','mcp_1.fetch'), true);
  assert.equal(await p.allowed('app_2','mcp_1.fetch'), false);
});
