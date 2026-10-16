import test from 'node:test';
import assert from 'node:assert/strict';
import { ECOMMERCE_AGENT_TOOL_BOUNDARIES, getAgentToolBoundary } from '../src/agents/ecommerce-tool-boundaries.js';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';
import { ExternalMcpRegistry } from '../src/registry/external-mcp.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('ecommerce agent boundaries are explicit and distinct', () => {
  assert.ok(getAgentToolBoundary('ecommerce-operations-analyst').externalMcp.includes('facebook-ads'));
  assert.ok(getAgentToolBoundary('customer-experience-specialist').externalMcp.includes('ocr'));
  assert.notDeepEqual(getAgentToolBoundary('ecommerce-operations-analyst').toolIds, getAgentToolBoundary('customer-experience-specialist').toolIds);
});

test('external capability tools are declared once in common registry', () => {
  const ids = COMMON_TOOLS.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['public_api','tts','ocr','facebook_ads']) assert.ok(COMMON_TOOLS.some(x => x.id === id));
});

test('external MCP manifest can remain unconfigured without becoming healthy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'zc-phase30-'));
  await writeFile(path.join(root,'servers.json'), JSON.stringify({servers:[{id:'ocr',name:'OCR MCP',urlEnv:'EXTERNAL_MCP_OCR_URL',legacyEntry:'external mcp/ocr-mcp.js'}]}));
  const fakeStore={read:async()=>[],write:async()=>{}};
  const fakeMcp={list:async()=>[],register:async()=>{throw new Error('should_not_register_without_url')}};
  const registry=new ExternalMcpRegistry({store:fakeStore,mcpRegistry:fakeMcp,root,envObject:{}});
  const status=await registry.status();
  assert.equal(status[0].status,'configuration_missing');
  assert.equal(status[0].configured,false);
});
