import { randomUUID } from 'node:crypto';
import { MCP_PROTOCOL_VERSIONS, LATEST_MCP_PROTOCOL_VERSION } from './client.js';
import { RUNTIME_VERSION } from '../runtime/version.js';

// This module is the inbound side of MCP: a Streamable HTTP server that the
// runtime exposes on POST /mcp when MCP_SERVER_ENABLED=true. It is deliberately
// separate from ./client.js (the outbound side) so the two roles never share
// state. The server only advertises tools that this runtime can actually run
// (native, executable, ENABLED/VERIFIED); it never advertises NOT_IMPLEMENTED or
// external-MCP placeholder entries, because advertising a tool that cannot run
// would be a truthfulness violation.
const JSONRPC = '2.0';
export const MCP_SERVER_NAME = 'zombiecoder-runtime';
// Methods this server answers. `notifications/*` never receive a response body.
export const MCP_SERVER_METHODS = Object.freeze(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list', 'tools/call']);

function executableNativeTool(tool) {
  return Boolean(tool) && Boolean(tool.entry) && Boolean(tool.metadata?.toolSchema)
    && (tool.status === 'ENABLED' || tool.status === 'VERIFIED');
}

/**
 * Maps the runtime tool registry onto the MCP `tools/list` shape. Only tools
 * that pass the execution boundary (native entry + schema + enabled status) are
 * exposed, so the advertised catalog always equals the runnable catalog.
 */
export function mcpServerToolCatalog(tools = []) {
  return tools.filter(executableNativeTool).map(tool => ({
    name: String(tool.id),
    description: String(tool.description ?? tool.name ?? tool.id),
    inputSchema: tool.metadata.toolSchema
  }));
}

export function negotiateProtocolVersion(requested) {
  const value = String(requested ?? '');
  return MCP_PROTOCOL_VERSIONS.includes(value) ? value : LATEST_MCP_PROTOCOL_VERSION;
}

function rpcResult(id, result) { return { jsonrpc: JSONRPC, id: id ?? null, result }; }
function rpcError(id, code, message, data) {
  return { jsonrpc: JSONRPC, id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * Handles one JSON-RPC 2.0 message from an MCP client. Returns:
 *   { body }              -> send `body` as JSON (HTTP 200)
 *   { body: null }        -> a notification: send HTTP 202 with no body
 *   { body, sessionId }   -> also return the (new) Mcp-Session-Id header
 *
 * `executeTool(name, args, meta)` is supplied by the caller and is responsible
 * for auth, permission and sandboxing; this function only owns the protocol.
 */
export async function handleMcpServerMessage(message, { tools = [], executeTool, sessionId = null } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== JSONRPC || typeof message.method !== 'string') {
    return { body: rpcError(message?.id, -32600, 'invalid_request') };
  }
  const id = message.id;
  const isNotification = id === undefined || id === null;

  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return {
        body: rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(requested),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: RUNTIME_VERSION }
        }),
        sessionId: sessionId ?? `mcp-${randomUUID()}`
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { body: null };
    case 'ping':
      return { body: isNotification ? null : rpcResult(id, {}) };
    case 'tools/list': {
      if (isNotification) return { body: null };
      return { body: rpcResult(id, { tools: mcpServerToolCatalog(tools) }) };
    }
    case 'tools/call': {
      if (isNotification) return { body: null };
      const name = String(message.params?.name ?? '');
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      if (!mcpServerToolCatalog(tools).some(tool => tool.name === name)) {
        return { body: rpcError(id, -32602, 'unknown_tool', { tool: name }) };
      }
      try {
        const result = await executeTool(name, args, message.params?._meta ?? {});
        // A tool-level failure is a CallToolResult with isError=true, not a
        // JSON-RPC error: the protocol succeeded, the tool did not.
        return { body: rpcResult(id, callToolResult(result)) };
      } catch (error) {
        const detail = { error: String(error?.message ?? 'tool_call_failed') };
        return { body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(detail) }], isError: true }) };
      }
    }
    default:
      return { body: isNotification ? null : rpcError(id, -32601, 'method_not_found', { method: message.method }) };
  }
}

function stringifyResult(result) {
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result ?? null); } catch { return String(result); }
}

// Native tools already answer with the MCP `content` envelope (legacy
// mcp-text-content-v1), so a shaped result passes straight through instead of
// being double-encoded into one big text block.
function callToolResult(result) {
  if (result && Array.isArray(result.content)) return { content: result.content, isError: false };
  return { content: [{ type: 'text', text: stringifyResult(result) }], isError: false };
}
