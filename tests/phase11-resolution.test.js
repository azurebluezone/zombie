import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionResolver } from '../src/registry/resolver.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { TransportRegistry } from '../src/transport/registry.js';
import { ExecutionOrchestrator } from '../src/execution/orchestrator.js';

class MemStore {
  constructor() { this.data = new Map(); }
  async read(k, fallback=[]) { return this.data.has(k) ? structuredClone(this.data.get(k)) : fallback; }
  async write(k, value) { this.data.set(k, structuredClone(value)); }
}

test('extension resolver resolves registered agent and transport without executing', async () => {
  const store = new MemStore();
  const resolver = new ExtensionResolver({
    agents: new AgentRegistry(store),
    skills: new SkillRegistry(store),
    tools: new ToolRegistry(store),
    transports: new TransportRegistry(store)
  });
  const result = await resolver.resolve({agentId:'code-guru', transportId:'http'});
  assert.equal(result.agent.id, 'code-guru');
  assert.equal(result.transport.id, 'http');
});

test('extension resolver refuses disabled tool instead of bypassing registry state', async () => {
  const store = new MemStore();
  const tools = new ToolRegistry(store);
  await tools.register({id:'example-tool', name:'Example', status:'DISABLED'});
  const resolver = new ExtensionResolver({
    agents: new AgentRegistry(store), skills: new SkillRegistry(store), tools, transports: new TransportRegistry(store)
  });
  await assert.rejects(() => resolver.resolve({toolIds:['example-tool']}), /tool_not_found_or_disabled/);
});

test('execution prepare resolves extensions but remains non-executing', async () => {
  const store = new MemStore();
  const resolver = new ExtensionResolver({
    agents: new AgentRegistry(store),
    skills: new SkillRegistry(store),
    tools: new ToolRegistry(store),
    transports: new TransportRegistry(store)
  });
  const execution = new ExecutionOrchestrator({extensionResolver:resolver});
  const prepared = await execution.prepare({goal:'inspect project', agentId:'planner', transportId:'http'});
  assert.equal(prepared.extensions.agent.id, 'planner');
  assert.equal(prepared.extensions.transport.id, 'http');
  assert.equal(prepared.execution.status, 'not_started');
  assert.equal(typeof execution.execute, 'function');
});
