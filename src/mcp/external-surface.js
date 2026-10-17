/**
 * External MCP tools in the request-scoped tool surface.
 *
 * The tool loop already knows how to execute an external MCP tool: a binding of
 * the shape `{qualifiedName, executionTarget:'mcp'}` is routed to the MCP
 * execution adapter by `bindingFor()` in `src/execution/tool-loop.js`. What was
 * missing is putting such a binding into the surface at all — an external tool
 * used to be reachable only by naming its qualified name by hand.
 *
 * This module closes that gap. It turns the tools discovered on an endpoint into
 * ordinary OpenAI function definitions plus the bindings that connect the name
 * the model echoes back to the qualified name the MCP adapter needs.
 *
 * Two rules it never breaks:
 *   - A declaration is not a health claim. Only an endpoint whose status is
 *     `discovered` and that actually reported tools contributes anything.
 *   - Narrowing can only ever offer less, never grant more. Permission, consent
 *     and the MCP permission table are still enforced downstream.
 */

import { getAgentToolBoundary } from '../agents/ecommerce-tool-boundaries.js';

// OpenAI-compatible function names are restricted to this alphabet. Endpoint ids
// and remote tool names are not, so every name is normalised before it is offered.
const SAFE_NAME = /[^a-zA-Z0-9_-]/g;
const MAX_NAME = 64;

export function safeFunctionName(endpointId, toolName) {
  const raw = `mcp_${String(endpointId ?? 'endpoint')}_${String(toolName ?? 'tool')}`.replace(SAFE_NAME, '_');
  return (raw.slice(0, MAX_NAME) || 'mcp_tool');
}

/**
 * The endpoints an agent is allowed to see, or `null` for "no restriction".
 * A boundary is only a filter when the agent declares one; every other agent
 * keeps the full discovered set.
 */
export function boundaryEndpointIds(agentId) {
  const boundary = getAgentToolBoundary(agentId);
  return Array.isArray(boundary?.externalMcp) && boundary.externalMcp.length ? [...boundary.externalMcp] : null;
}

/**
 * @param {object}   input
 * @param {object[]} input.endpoints          records from McpRegistry.list()
 * @param {string[]} [input.allowedEndpointIds] restrict to these endpoint ids; null/omitted = all
 * @param {number}   [input.maxTools]         hard cap on how many remote tools are offered
 * @returns {{definitions:object[], bindings:object, entries:object[], dropped:object[], endpointIds:string[]}}
 */
export function buildExternalToolSurface({ endpoints = [], allowedEndpointIds = null, maxTools = 16 } = {}) {
  const allowed = Array.isArray(allowedEndpointIds) ? new Set(allowedEndpointIds.map(String)) : null;
  const cap = Math.max(1, Number(maxTools) || 16);
  const definitions = [];
  const bindings = {};
  const entries = [];
  const dropped = [];
  const endpointIds = [];
  const used = new Set();

  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    if (!endpoint || endpoint.enabled === false) continue;
    if (endpoint.status !== 'discovered') continue;
    if (allowed && !allowed.has(String(endpoint.id))) continue;
    const tools = Array.isArray(endpoint.tools) ? endpoint.tools : [];
    if (!tools.length) continue;

    let contributed = false;
    for (const tool of tools) {
      const qualifiedName = String(tool?.qualifiedName ?? (tool?.name ? `${endpoint.id}.${tool.name}` : ''));
      if (!qualifiedName) continue;
      if (definitions.length >= cap) { dropped.push({ endpointId: endpoint.id, qualifiedName, reason: 'external_tool_cap' }); continue; }

      let name = safeFunctionName(endpoint.id, tool.name);
      let suffix = 2;
      while (used.has(name)) name = `${safeFunctionName(endpoint.id, tool.name).slice(0, MAX_NAME - 4)}_${suffix++}`;
      used.add(name);

      definitions.push({
        type: 'function',
        function: {
          name,
          description: String(tool.description ?? `External MCP tool ${qualifiedName} on endpoint ${endpoint.id}.`).slice(0, 1024),
          parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
        }
      });
      bindings[name] = { qualifiedName, executionTarget: 'mcp' };
      entries.push({ name, qualifiedName, endpointId: endpoint.id, toolName: String(tool.name ?? qualifiedName) });
      contributed = true;
    }
    if (contributed) endpointIds.push(String(endpoint.id));
  }

  return { definitions, bindings, entries, dropped, endpointIds };
}
