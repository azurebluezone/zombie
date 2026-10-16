/**
 * Legacy API feature inventory.
 *
 * This module is intentionally an INVENTORY, not a compatibility shim.
 * It records whether capabilities documented in legacy api.md have a
 * visible boundary in the modular runtime. It does not claim behavioral
 * parity and does not execute legacy code.
 */

const FEATURE_STATUS = Object.freeze({
  PRESENT: 'PRESENT',
  PARTIAL: 'PARTIAL',
  WARNING: 'WARNING',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED'
});

const features = [
  // Core/runtime
  ['core.modules', 'Core Node modules', 'src/core', FEATURE_STATUS.PRESENT, 'Split across native runtime modules.'],
  ['domain.configuration', 'Domain configuration/detection', 'src/compatibility/legacy/boundaries/domain/', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy api.md had detectDomain/getDomainConfig; no modular boundary yet.'],
  ['env.loader', '.env loader', 'src/config/env-loader.js', FEATURE_STATUS.PRESENT, 'Zero-dependency loader is present.'],
  ['runtime.constants', 'Runtime/config constants', 'src/config/env.js', FEATURE_STATUS.PRESENT, 'Central config boundary exists.'],
  ['allowed.directories', 'User/tool allowed-directory policy', 'src/execution/tool-adapter.js', FEATURE_STATUS.PARTIAL, 'Tool root containment exists; legacy ALLOWED_DIRS semantics are not yet reconciled.'],
  ['pusher.config', 'Optional Pusher/SSE client config', 'src/compatibility/legacy/boundaries/pusher/', FEATURE_STATUS.NOT_IMPLEMENTED, 'No Pusher compatibility boundary.'],
  ['cache.config', 'Cache/Git runtime configuration', 'src/compatibility/legacy/boundaries/runtime-config/', FEATURE_STATUS.WARNING, 'Legacy cache/Git settings are not yet reconciled into a dedicated policy.'],
  ['runtime.config.update', 'Runtime config update endpoint/service', 'src/config', FEATURE_STATUS.WARNING, 'Read-time config exists; legacy updateRuntimeConfig behavior is not migrated.'],
  ['os.auto-setup', 'OS-aware runtime auto-setup', 'src/compatibility/legacy/boundaries/auto-setup/', FEATURE_STATUS.PRESENT, 'Modular AutoSetupService exists; legacy .missionbarisal behavior still needs parity verification.'],
  ['system.identity', 'System identity/domain-aware identity', 'src/policy/constitution.js', FEATURE_STATUS.PARTIAL, 'Core identity/constitution exists; domain-aware legacy identity is not reconciled.'],

  // Providers/models
  ['provider.registry', 'Provider registry', 'src/providers/registry.js', FEATURE_STATUS.PRESENT, 'Modular provider registry exists.'],
  ['provider.routing', 'Provider competition/routing', 'src/providers/registry.js', FEATURE_STATUS.PRESENT, 'Capability-aware SmartRouter and provider adapters provide the current routing boundary; legacy competition behavior is not parity-verified.'],
  ['provider.fallback', 'Priority fallback across providers', 'src/providers/registry.js', FEATURE_STATUS.PRESENT, 'ProviderExecutionAdapter tries eligible route candidates in priority order; legacy fallback semantics are not parity-verified.'],
  ['provider.gemini.native', 'Native Gemini request/stream', 'src/providers/adapters/gemini.js', FEATURE_STATUS.PRESENT, 'Adapter boundary exists.'],
  ['provider.model.masking', 'Public/API model masking', 'src/providers', FEATURE_STATUS.PRESENT, 'Provider/model masking is enforced at the agent-facing response boundary; legacy exact formatting parity is not verified.'],
  ['api.normalize', 'Canonical response normalization endpoint', 'src/providers/normalizer/canonical-response.js', FEATURE_STATUS.PARTIAL, 'Normalizer exists; legacy /api/normalize route parity is not present.'],

  // Agent/persona/knowledge
  ['personas', 'Persona loading/registry', 'src/agents/persona-registry.js', FEATURE_STATUS.PRESENT, 'Modular persona registry exists.'],
  ['default.agents', 'Default agent set', 'src/agents/registry.js', FEATURE_STATUS.PRESENT, 'Twelve core agents are explicitly registered.'],
  ['smart.agent.router', 'Input classification and smart agent routing', 'src/agents/runner.js', FEATURE_STATUS.PARTIAL, 'Agent boundary exists; legacy classifier/router parity is not migrated.'],
  ['single.agent.execute', 'Single-agent execution', 'src/agents/runner.js', FEATURE_STATUS.PARTIAL, 'Agent runner boundary exists; full legacy execution semantics are not parity-verified.'],
  ['mission.execute', 'Multi-agent mission execution', 'src/execution/orchestrator.js', FEATURE_STATUS.PARTIAL, 'Goal/plan/consent/execution boundary exists; legacy debate pipeline is not parity-verified.'],
  ['agent.to.agent', 'Agent-to-agent delegation', 'src/agents/runner.js', FEATURE_STATUS.WARNING, 'Registry/runner exist; legacy call_agent protocol is not yet represented as a verified contract.'],
  ['ssot', 'SSOT project context', 'src/context/project-context.js', FEATURE_STATUS.PRESENT, 'Modular project-context boundary exists.'],
  ['ssot.auto-refresh', 'Automatic SSOT generation/refresh', 'src/context/project-context.js', FEATURE_STATUS.PARTIAL, 'Dedicated SSOTService exists; legacy autoSSOT generator behavior is not parity-verified.'],
  ['syllabus', 'Agent syllabus/learning store', 'src/context/project-context.js', FEATURE_STATUS.PRESENT, 'Dedicated modular SyllabusService exists; legacy exact file/route parity is not verified.'],
  ['memory', 'Memory/session context', 'src/session/state.js', FEATURE_STATUS.PRESENT, 'Durable session state exists.'],
  ['session.archive', 'Session archive/history', 'src/session/state.js', FEATURE_STATUS.PARTIAL, 'Session messages exist; legacy archive semantics are not parity-verified.'],

  // Tools/MCP
  ['tool.registry', 'Tool registry', 'src/tools/registry.js', FEATURE_STATUS.PRESENT, 'Explicit modular registry exists.'],
  ['tool.execution.loop', 'Tool execution loop', 'src/execution/tool-loop.js', FEATURE_STATUS.PRESENT, 'Bounded multi-round loop exists.'],
  ['mcp.registry', 'MCP endpoint registry', 'src/mcp/registry.js', FEATURE_STATUS.PRESENT, 'MCP registry exists.'],
  ['mcp.permissions', 'MCP permission boundary', 'src/mcp/permissions.js', FEATURE_STATUS.PRESENT, 'Default-deny permission layer exists.'],
  ['mcp.remote.call', 'Remote MCP tool invocation', 'src/execution/mcp-adapter.js', FEATURE_STATUS.PARTIAL, 'Execution boundary exists; legacy remote_mcp_call parity is not verified.'],
  ['mcp.audit', 'MCP execution audit', 'src/mcp/audit.js', FEATURE_STATUS.PRESENT, 'Durable audit exists.'],
  ['mcp.reconciliation', 'Incomplete execution reconciliation', 'src/mcp/reconciliation.js', FEATURE_STATUS.PRESENT, 'Recovery boundary exists.'],

  // HTTP/API routes
  ['route.root.dashboard', 'GET / dashboard', 'src/server.js', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy UI dashboard route is not part of modular runtime.'],
  ['route.health', 'GET /health', 'src/server.js', FEATURE_STATUS.PRESENT, 'Modular health endpoint exists.'],
  ['route.rate-limit', 'Rate-limit status/reset', 'src/server.js', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy /api/rate-limit routes are not migrated.'],
  ['route.identity', 'GET /identity', 'src/server.js', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy identity route is not migrated.'],
  ['route.models', 'Model catalog routes', 'src/providers/model-catalog.js', FEATURE_STATUS.PARTIAL, 'Provider model catalog exists; legacy /v1/models, /api/v0/models and /api/v1/models parity not verified.'],
  ['route.clients', 'MCP clients/connected clients routes', 'src/mcp/connections.js', FEATURE_STATUS.PARTIAL, 'Durable connection listing exists; legacy HTML/JSON client routes are not parity-verified.'],
  ['route.domain', 'GET /api/domain', 'src/compatibility/legacy/boundaries/domain/', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy domain route has no modular boundary yet.'],
  ['route.pusher', 'GET /api/pusher-config', 'src/compatibility/legacy/boundaries/pusher/', FEATURE_STATUS.NOT_IMPLEMENTED, 'No Pusher compatibility boundary.'],
  ['route.agents', 'GET /api/agents', 'src/agents/registry.js', FEATURE_STATUS.PARTIAL, 'Admin registry exists; legacy public route parity not verified.'],
  ['route.admin', 'Legacy HTML admin dashboard', 'src/admin/admin-service.js', FEATURE_STATUS.PARTIAL, 'Admin service/API exists; HTML dashboard is not migrated.'],
  ['route.admin.stats', 'GET /api/admin/stats', 'src/admin/admin-service.js', FEATURE_STATUS.WARNING, 'No dedicated legacy stats contract.'],
  ['route.locks', 'GET /api/locks', 'src/core', FEATURE_STATUS.NOT_IMPLEMENTED, 'No legacy lock status endpoint.'],
  ['route.config', 'GET/POST /api/config', 'src/config/env.js', FEATURE_STATUS.PARTIAL, 'Central config exists; legacy public config route is not migrated.'],
  ['route.working-dir', 'POST /api/set-working-dir', 'src/execution/tool-adapter.js', FEATURE_STATUS.WARNING, 'Working-directory policy is bounded by tool root; legacy route semantics are not verified.'],
  ['route.ssot', 'GET /api/ssot', 'src/context/project-context.js', FEATURE_STATUS.PARTIAL, 'Context boundary exists; legacy route parity not verified.'],
  ['route.sessions', 'GET /api/sessions', 'src/session/service.js', FEATURE_STATUS.PARTIAL, 'Modular session API exists under /v1; legacy route parity not verified.'],
  ['route.chat', 'POST /v1/chat/completions', 'src/server.js', FEATURE_STATUS.PRESENT, 'OpenAI-compatible chat route exists.'],
  ['route.mission', 'POST /api/mission', 'src/execution/orchestrator.js', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy route intentionally not recreated.'],
  ['route.antidote', 'POST /api/v1/anti-dote', 'src/execution/contract.js', FEATURE_STATUS.PARTIAL, 'Goal/plan/consent/verify boundary exists; legacy anti-dote route parity is not verified.'],
  ['route.mcp', 'POST/GET /mcp', 'src/mcp', FEATURE_STATUS.PARTIAL, 'MCP modular services exist; legacy HTTP MCP route parity not yet exposed.'],
  ['route.workspace', 'POST /api/workspace', 'src/context/project-context.js', FEATURE_STATUS.PARTIAL, 'Project context exists; legacy workspace auto-generation route not migrated.'],
  ['route.syllabus', 'POST /api/syllabus', 'src/context/project-context.js', FEATURE_STATUS.PRESENT, 'Dedicated /v1/context/syllabus write boundary exists; legacy route parity is not verified.'],
  ['route.input', 'POST /api/input', 'src/server.js', FEATURE_STATUS.PARTIAL, 'Thin shim over ProviderExecutionAdapter exists (masked identity); legacy tool-loop/session parity is not verified.'],

  // Transports/system services
  ['transport.http', 'HTTP transport', 'src/transport/registry.js', FEATURE_STATUS.PRESENT, 'Registered.'],
  ['transport.https', 'HTTPS transport', 'src/transport/registry.js', FEATURE_STATUS.PRESENT, 'Registered as encrypted transport.'],
  ['transport.sse', 'SSE streaming transport', 'src/transport/registry.js', FEATURE_STATUS.PRESENT, 'Provider streaming endpoint exists.'],
  ['transport.uds', 'Unix domain socket transport', 'src/transport/registry.js', FEATURE_STATUS.PRESENT, 'Shared HTTP request handler is mounted on a Unix domain socket.'],
  ['transport.websocket', 'WebSocket transport', 'src/transport/registry.js', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy WS transport is not implemented in modular runtime.'],
  ['transport.client', 'Runtime client transport support', 'src/transport/client.js', FEATURE_STATUS.PRESENT, 'Node client supports HTTP, HTTPS, UDS and SSE streaming.'],
  ['context.inject', 'Three-layer context injection', 'src/context', FEATURE_STATUS.PARTIAL, 'Context resolver/project context exist; legacy injection order not parity-verified.'],
  ['cross.verification', 'Cross-agent verification', 'src/evidence/gate.js', FEATURE_STATUS.PARTIAL, 'Evidence gate exists; legacy multi-agent cross-verification algorithm is not migrated.'],
  ['compiler.check', 'Compiler/type check helpers', 'src/compatibility/legacy/boundaries/compiler/', FEATURE_STATUS.NOT_IMPLEMENTED, 'No modular compiler-check service yet.'],
  ['usage.tracking', 'Usage tracking helpers', 'src/compatibility/legacy/boundaries/usage/', FEATURE_STATUS.NOT_IMPLEMENTED, 'No modular usage accounting service yet.'],
  ['client.persistence', 'Connected client persistence', 'src/storage', FEATURE_STATUS.PARTIAL, 'Application/session persistence exists; legacy client list semantics are not verified.'],
  ['git.runtime.download', 'Git runtime downloader', 'src/compatibility/legacy/boundaries/git-download/', FEATURE_STATUS.NOT_IMPLEMENTED, 'No modular downloader boundary.'],
  ['emoji.strip', 'Emoji stripping utility', 'src/compatibility/legacy', FEATURE_STATUS.NOT_IMPLEMENTED, 'Legacy utility not migrated.'],
  ['graceful.shutdown', 'Graceful shutdown/cleanup', 'src/server.js', FEATURE_STATUS.PARTIAL, 'Runtime lifecycle exists; legacy cleanup semantics are not parity-verified.']
].map(([id,name,target,status,notes]) => ({id,name,target,status,notes}));

export { FEATURE_STATUS, features as LEGACY_API_FEATURES };

export function legacyFeatureReport() {
  const counts = Object.fromEntries(Object.values(FEATURE_STATUS).map(s => [s, 0]));
  for (const f of features) counts[f.status] += 1;
  return {
    source: 'api.md',
    sourceRole: 'legacy-feature-inventory',
    behaviorParityVerified: false,
    counts,
    warnings: features.filter(f => f.status !== FEATURE_STATUS.PRESENT),
    features
  };
}
