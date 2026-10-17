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

test('external capability tools are declared once, in the external MCP manifest', async () => {
  const ids = COMMON_TOOLS.map(x => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate tool ids');
  // They are external MCP servers, so the registry must NOT mirror them: a
  // mirrored row was an UNVERIFIED tool the agent could see but never call.
  for (const id of ['public_api','tts','ocr','facebook_ads']) {
    assert.equal(COMMON_TOOLS.some(x => x.id === id), false, `${id} must not be a runtime tool`);
  }
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../external-mcp/servers.json', import.meta.url), 'utf8'));
  for (const id of ['public-api','tts','ocr','facebook-ads']) {
    assert.ok(manifest.servers.some(x => x.id === id), `${id} must be declared in external-mcp/servers.json`);
  }
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
