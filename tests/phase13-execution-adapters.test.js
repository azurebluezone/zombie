import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutionAdapter } from '../src/execution/tool-adapter.js';
import { McpExecutionAdapter } from '../src/execution/mcp-adapter.js';
import { ExecutionAdapter } from '../src/execution/execution-adapter.js';
import { EvidenceGate } from '../src/evidence/gate.js';

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

// Regression: /v1/execution/run validates every returned evidence item with
// EvidenceGate.validate(), which requires source/status/observedAt. Both
// adapters used to return {type,...} objects, so a completed tool or remote MCP
// call was turned into an opaque HTTP 400 after the work had already run.
test('tool and MCP adapters emit evidence the evidence gate can validate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase13-evidence-'));
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-test' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }], isError: false } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(path.join(dir, 'echo-tool.mjs'), `export async function execute(args) { return { echo: args.value }; }\n`);
    const registry = new ToolRegistry(new Store());
    await registry.register({ id: 'echo-tool', status: 'ENABLED', entry: './echo-tool.mjs' });
    const toolResult = await new ToolExecutionAdapter({ registry, toolRoot: dir })
      .execute({ prepared, input: { toolId: 'echo-tool', arguments: { value: 'x' } }, applicationId: 'app_1' });

    const port = server.address().port;
    const mcpResult = await new McpExecutionAdapter({
      registry: {
        resolveTool: async () => ({
          endpoint: { id: 'ep', url: `http://127.0.0.1:${port}/mcp`, allowHosts: ['127.0.0.1'], networkPolicy: { allowHttp: true, allowPrivateNetwork: true } },
          tool: { name: 'ping' }
        })
      },
      permissions: { allowed: async () => true },
      audit: { append: async () => {} },
      connections: { resolve: async () => null, touch: async () => {} },
      limits: { acquire: () => () => {} }
    }).execute({ prepared, input: { qualifiedName: 'ep.ping', arguments: {} }, applicationId: 'app_1' });

    const gate = new EvidenceGate({ store: new Store() });
    for (const [label, result] of [['tool', toolResult], ['mcp', mcpResult]]) {
      assert.equal(result.status, 'completed', label);
      const validated = gate.validate(result.evidence);
      assert.equal(validated.length, 1, label);
      assert.ok(validated[0].source, `${label} evidence needs a source`);
      assert.ok(validated[0].observedAt, `${label} evidence needs observedAt`);
      assert.equal(validated[0].status, 'observed', label);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
