import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { McpExecutionAdapter } from '../src/execution/mcp-adapter.js';
import { ExecutionAdapter } from '../src/execution/execution-adapter.js';

class Store {
  constructor(data = {}) { this.data = new Map(Object.entries(data)); }
  async read(k, fallback = []) { return structuredClone(this.data.has(k) ? this.data.get(k) : fallback); }
  async write(k, value) { this.data.set(k, structuredClone(value)); }
}

const prepared = {
  contract: { goal: 'run registered tool', expectedOutcome: 'result returned' },
  consent: { allowed: true }
};

test('registered tool executes its real module only when explicitly enabled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase13-tool-'));
  try {
    await writeFile(path.join(dir, 'real-tool.mjs'), `export async function execute(args) { return { sum: Number(args.a) + Number(args.b) }; }\n`);
    const store = new Store();
    const registry = new ToolRegistry(store);
    await registry.register({
      id: 'real-sum', name: 'Real Sum Tool', version: '1.0.0', status: 'ENABLED',
      entry: './real-tool.mjs', metadata: { toolSchema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } } }
    });
    const adapter = new ToolExecutionAdapter({ registry, toolRoot: dir });
    const result = await adapter.execute({ prepared, input: { toolId: 'real-sum', arguments: { a: 2, b: 3 } }, applicationId: 'app_1' });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { sum: 5 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registered tool cannot escape the configured tool root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase13-tool-'));
  try {
    const registry = new ToolRegistry(new Store());
    await registry.register({ id: 'escape', status: 'ENABLED', entry: '../outside.mjs' });
    const adapter = new ToolExecutionAdapter({ registry, toolRoot: dir });
    await assert.rejects(() => adapter.execute({ prepared, input: { toolId: 'escape', arguments: {} }, applicationId: 'app_1' }), /tool_entry_outside_tool_root/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MCP execution checks application permission before network execution', async () => {
  const adapter = new McpExecutionAdapter({
    registry: { resolveTool: async () => { throw new Error('network_should_not_be_reached'); } },
    permissions: { allowed: async () => false },
    audit: { append: async () => {} },
    connections: { resolve: async () => null },
    limits: { acquire: () => () => {} }
  });
  await assert.rejects(
    () => adapter.execute({ prepared, input: { qualifiedName: 'mcp.endpoint.tool' }, applicationId: 'app_1' }),
    /mcp_tool_not_permitted/
  );
});

test('execution adapter selects tool, MCP, or provider boundary explicitly', async () => {
  const calls = [];
  const adapter = new ExecutionAdapter({
    tool: { execute: async () => { calls.push('tool'); return { target: 'tool' }; } },
    mcp: { execute: async () => { calls.push('mcp'); return { target: 'mcp' }; } },
    provider: { execute: async () => { calls.push('provider'); return { target: 'provider' }; } }
  });
  await adapter.execute({ prepared, input: { toolId: 't' }, applicationId: 'app_1' });
  await adapter.execute({ prepared, input: { qualifiedName: 'q' }, applicationId: 'app_1' });
  await adapter.execute({ prepared, input: {}, applicationId: 'app_1' });
  assert.deepEqual(calls, ['tool', 'mcp', 'provider']);
});
