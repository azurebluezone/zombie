import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { ProjectContextStore } from '../src/context/project-context.js';
import { LEGACY_ROUTE_COUNT, CURRENT_ROUTE_COUNT, routeMapReport } from '../src/compatibility/route-map.js';
import { DEFAULT_AGENTS } from '../src/agents/index.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { createStore } from '../src/storage/storage.js';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

test('phase24 route map is explicit and matches the current inventory', () => {
  const report = routeMapReport();
  assert.equal(report.legacyConcreteRoutes, 31);
  assert.equal(report.currentConcreteRoutes, 69);
  assert.equal(report.currentHandlerBlocks, 51);
  assert.equal(report.notes.length, 5);
});

test('phase24 default agent count matches the actual registry', () => {
  assert.equal(DEFAULT_AGENTS.length, 12);
});

test('phase24 normalizer fails closed on unsupported provider shape', () => {
  const n = new CanonicalResponseNormalizer();
  assert.throws(() => n.normalize({unexpected:'shape'}), /provider_response_unsupported_format/);
});

test('phase24 project root policy blocks paths outside configured roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zc-phase24-'));
  const store = new ProjectContextStore({defaultRoot:root, allowedRoots:[root]});
  assert.equal(store.root(root), root);
  assert.throws(() => store.root(path.dirname(root)), /project_root_not_allowed/);
});

test('phase24 MCP registration preserves the endpoint host allowlist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zc-phase24-store-'));
  const store = await createStore({sqlitePath:path.join(root,'runtime.sqlite'),dataDir:root});
  const mcp = new McpRegistry(store);
  const endpoint = await mcp.register({url:'https://example.com/mcp',allowHosts:['example.com']});
  assert.deepEqual(endpoint.allowHosts, ['example.com']);
});
