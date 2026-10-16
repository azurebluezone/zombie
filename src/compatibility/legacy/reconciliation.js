/**
 * Purpose-first reconciliation of the legacy api.md surface.
 *
 * This is a migration decision record, not a legacy compatibility shim.
 * The decision is about the PURPOSE a legacy capability served and where that
 * purpose belongs in the modular runtime today.
 */

export const RECONCILIATION_DECISIONS = Object.freeze({
  KEEP: 'KEEP',
  REPLACE: 'REPLACE',
  MERGE: 'MERGE',
  DEPRECATE: 'DEPRECATE',
  BLOCK: 'BLOCK'
});

const rows = [
  ['anti-dote.type-safety', 'execution safety and verification contract', 'MERGE', 'src/execution/contract.js + src/evidence/gate.js + src/execution/task-policy.js', 'Keep the six-stage purpose, but do not preserve the old monitoring loophole or require a separate legacy wrapper for every endpoint.'],
  ['anti-dote.non-blocking-monitor', 'observe failures without corrupting the execution result', 'DEPRECATE', 'src/evidence/gate.js', 'A failed check must remain visible; execution must not be falsely reported as verified.'],
  ['context.inject', 'supply only relevant project/session evidence to a model', 'MERGE', 'src/context/context-budget.js + src/context/resolver.js', 'Bound context and retrieve relevant archive evidence instead of dumping three full files into every request.'],
  ['tool.execution.loop', 'bounded tool orchestration', 'KEEP', 'src/execution/tool-loop.js', 'Existing bounded loop already expresses the purpose; tool selection is now policy-scoped.'],
  ['smart.agent.router', 'select an appropriate agent for the task', 'REPLACE', 'src/agents/runner.js + src/execution/task-policy.js', 'Do not copy regex-heavy legacy routing; task purpose and explicit profile drive the boundary.'],
  ['provider.registry', 'resolve provider/model resources without exposing infrastructure identity', 'KEEP', 'src/providers/registry.js + src/providers/router/', 'Current provider/model boundary is the correct architectural home.'],
  ['provider.fallback', 'recover from provider failure without fabricating success', 'KEEP', 'src/providers/registry.js + src/providers/router/', 'Fallback remains an infrastructure concern and must remain evidence-visible.'],
  ['model.masking', 'hide infrastructure identity from agents/clients', 'KEEP', 'src/providers/masking/', 'Masking is a boundary concern, not a provider-specific feature.'],
  ['auto-ssot', 'maintain a bounded project source of truth', 'MERGE', 'src/context/ssot.js + src/context/project-context.js', 'Keep the purpose; do not reproduce legacy autoSSOT file mutation semantics blindly.'],
  ['syllabus-memory', 'retain project/session knowledge without unbounded prompt growth', 'MERGE', 'src/context/syllabus.js + src/context/memory.js + src/session/state.js', 'Use bounded retrieval rather than unconditional full-history injection.'],
  ['mcp.permissions', 'prevent unauthorized external tool execution', 'KEEP', 'src/mcp/permissions.js + src/mcp/audit.js', 'Default-deny and durable audit are the correct control-plane boundary.'],
  ['mcp.uds', 'low-overhead local process transport', 'KEEP', 'src/transport/server.js', 'UDS is a transport boundary; it must not be confused with UDP or provider protocol semantics.'],
  ['web-function', 'answer from external web evidence', 'REPLACE', 'src/execution/task-policy.js + registered web_search tool', 'Expose only web_search for this task profile; no unrelated filesystem or execution tools are needed.'],
  ['file-line-answer', 'answer with exact workspace evidence', 'REPLACE', 'src/execution/task-policy.js + registered read_file tool', 'Require source + locator evidence; a browser-only function should not invent file access.'],
  ['workspace-user-directory', 'create a bounded per-user workspace', 'MERGE', 'src/execution/context.js + src/execution/tool-adapter.js', 'Directory creation belongs to execution scope/path policy, not to a generic chat function.'],
  ['compile-check', 'prove implementation correctness with executable evidence', 'REPLACE', 'registered compiler/test tool + src/evidence/gate.js', 'Use the strongest available verification tool; if unavailable, report inability rather than downgrade to a claim.'],
  ['legacy-websocket', 'interactive bidirectional transport', 'DEPRECATE', 'src/transport/registry.js', 'No demonstrated need in the current contract; do not preserve for feature-count parity.'],
  ['legacy-pusher', 'browser push/event delivery', 'DEPRECATE', 'SSE/HTTP streaming boundary', 'Use the native streaming boundary unless a concrete requirement proves otherwise.'],
  ['legacy-git-downloader', 'obtain runtime code/assets remotely', 'BLOCK', 'none', 'Unbounded runtime download is outside the core execution trust boundary until a separately audited supply-chain policy exists.'],
  ['legacy-emoji-strip', 'presentation cleanup', 'DEPRECATE', 'response presentation layer', 'Not a runtime safety or execution capability.'],
  ['legacy-dashboard', 'admin visibility/control', 'REPLACE', 'src/admin/admin-service.js + admin APIs', 'Admin UI is control plane only and must never become the execution owner.']
].map(([id,purpose,decision,boundary,rationale]) => ({id,purpose,decision,boundary,rationale}));

export const LEGACY_RECONCILIATION = Object.freeze(rows);

export function reconciliationReport() {
  const counts = Object.fromEntries(Object.values(RECONCILIATION_DECISIONS).map(x => [x, 0]));
  for (const row of rows) counts[row.decision] += 1;
  return {
    source: 'api.md',
    sourceRole: 'legacy-purpose-reconciliation',
    behaviorParityVerified: false,
    principle: 'Reconcile purpose and boundary; do not copy legacy implementation for feature-count parity.',
    counts,
    items: rows
  };
}
