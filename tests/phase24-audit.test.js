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
  // Bumped 69 -> 86 -> 89 -> 91 -> 94 -> 95: the inventory also lists the routes added for
  // the admin console (logs + SSE stream, agent metrics, runtime metrics, model and
  // masking-model catalogs, agent-model mappings, tool status update, provider
  // live test, persona update/deletion, the inbound MCP server/client endpoints
  // plus endpoint removal, the inbound MCP auth policy GET/PATCH/DELETE, the
  // agent tool-access scope GET/PATCH pair, the project-notes GET/POST/DELETE trio,
  // the messaging-channel plan GET, and the user/token trio: one GET that reveals a
  // token, one PATCH that sets role/ceilings/expiry/status, and one GET /v1/auth/verify
  // that a client's own application calls to resolve a token to a user).
  // The pinned number is intentional: it must be raised deliberately whenever the
  // route inventory changes.
  assert.equal(report.currentConcreteRoutes, 98);
  // Hand-maintained, and recorded as such in the map's own notes: no code derives it.
  assert.equal(report.currentHandlerBlocks, 59);
  assert.equal(report.notes.length, 10);
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
