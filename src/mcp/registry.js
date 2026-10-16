import { id } from '../core/ids.js';
import { discoverMcpTools, LATEST_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from './client.js';
import { assertSafeMcpUrl } from './security.js';
import net from 'node:net';

// Outbound endpoints are often authenticated. Values are stored so discovery and
// tool calls can replay them, but they are never echoed back by the admin API.
function normalizeAuthHeaders(input = {}) {
  const headers = {};
  if (input.headers && typeof input.headers === 'object') {
    for (const [key, value] of Object.entries(input.headers)) {
      if (value != null && String(value).trim()) headers[String(key).toLowerCase()] = String(value).trim();
    }
  }
  const key = input.apiKey ?? input.token;
  if (key && !headers.authorization) {
    const value = String(key).trim();
    headers.authorization = /^bearer\s/i.test(value) ? value : `Bearer ${value}`;
  }
  return headers;
}

/** Admin-safe projection: header names are shown, values are not. */
export function redactEndpoint(endpoint) {
  if (!endpoint || !endpoint.headers || !Object.keys(endpoint.headers).length) return { ...endpoint, hasAuth: false };
  return { ...endpoint, hasAuth: true, authHeaderNames: Object.keys(endpoint.headers), headers: Object.fromEntries(Object.keys(endpoint.headers).map(k => [k, '***'])) };
}

export class McpRegistry {
  constructor(store, {networkPolicy = {}} = {}) { this.store = store; this.networkPolicy = networkPolicy; }
  async validateUrl(url, requestedHosts = []) {
    const globalHosts = [...(this.networkPolicy.allowHosts ?? [])].map(x => String(x).toLowerCase());
    if (requestedHosts.length && globalHosts.length && requestedHosts.some(host => !globalHosts.includes(String(host).toLowerCase()))) throw new Error('mcp_host_not_in_global_allowlist');
    const allowHosts = globalHosts.length ? (requestedHosts.length ? requestedHosts : globalHosts) : requestedHosts;
    const parsed = new URL(String(url));
    if (parsed.username || parsed.password) throw new Error('outbound_url_credentials_forbidden');
    if (!['https:','http:'].includes(parsed.protocol)) throw new Error('outbound_protocol_forbidden');
    if (parsed.protocol === 'http:' && this.networkPolicy.allowHttp !== true) throw new Error('outbound_protocol_forbidden');
    if (parsed.protocol === 'http:' && (this.networkPolicy.allowPrivateNetwork !== true || !allowHosts.length)) throw new Error('mcp_http_requires_private_network_and_host_allowlist');
    const host=parsed.hostname.toLowerCase();
    if (allowHosts.length && !allowHosts.map(x=>String(x).toLowerCase()).includes(host)) throw new Error('outbound_host_not_allowlisted');
    if (net.isIP(host) && !this.networkPolicy.allowPrivateNetwork && /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) throw new Error('outbound_private_address_forbidden');
    return {url:parsed};
  }
  async list() { return this.store.read('mcp-endpoints', []); }
  async register(input) {
    if (!input?.url) throw new Error('mcp_url_required');
    const requestedHosts = Array.isArray(input.allowHosts) ? [...new Set(input.allowHosts.map(String).map(x => x.toLowerCase()).filter(Boolean))] : [];
    await this.validateUrl(input.url, requestedHosts);
    const globalHosts = [...(this.networkPolicy.allowHosts ?? [])];
    const allowHosts = requestedHosts.length ? requestedHosts : globalHosts;
    const endpoints = await this.list();
    const existing = endpoints.find(item => item.url === input.url);
    const headers = normalizeAuthHeaders(input);
    if (existing) {
      // Re-registering the same URL with credentials updates them in place; this
      // is how an operator fixes a rotated token without recreating the endpoint.
      if (Object.keys(headers).length) {
        const merged = { ...existing, headers: { ...(existing.headers ?? {}), ...headers } };
        await this.store.write('mcp-endpoints', endpoints.map(item => item.id === existing.id ? merged : item));
        return merged;
      }
      return existing;
    }
    const item = { id: input.id ? String(input.id) : id('mcp'), url: input.url, name: String(input.name ?? input.url).slice(0,120), enabled: input.enabled !== false, allowHosts, networkPolicy: {allowHttp:this.networkPolicy.allowHttp===true,allowPrivateNetwork:this.networkPolicy.allowPrivateNetwork===true}, headers, status: 'registered', tools: [], createdAt: new Date().toISOString() };
    endpoints.push(item); await this.store.write('mcp-endpoints', endpoints); return item;
  }
  async discover(endpointId) {
    const endpoints = await this.list();
    const endpoint = endpoints.find(item => item.id === endpointId);
    if (!endpoint) throw new Error('mcp_endpoint_not_found');
    try {
      const result = await discoverMcpTools(endpoint);
      const updated = { ...endpoint, status: 'discovered', lastErrorCode: null, sessionId: result.sessionId ?? null, protocolVersion: result.protocolVersion ?? LATEST_MCP_PROTOCOL_VERSION, requestedProtocolVersion: result.requestedProtocolVersion ?? LATEST_MCP_PROTOCOL_VERSION, supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS], tools: result.tools.map(tool => ({ ...tool, qualifiedName: `${endpoint.id}.${tool.name}` })), discoveredAt: new Date().toISOString() };
      await this.store.write('mcp-endpoints', endpoints.map(item => item.id === endpointId ? updated : item));
      return updated;
    } catch (error) {
      const raw = String(error?.mcpCode ?? error?.message ?? 'mcp_discovery_failed');
      const code = /^mcp_[a-zA-Z0-9_.:-]{1,80}$/.test(raw) ? raw : 'mcp_discovery_failed';
      const failed = {...endpoint, status:'error', lastErrorCode:code, lastErrorAt:new Date().toISOString()};
      await this.store.write('mcp-endpoints', endpoints.map(item => item.id === endpointId ? failed : item));
      throw new Error(code);
    }
  }
  async remove(endpointId) {
    const endpoints = await this.list();
    const target = endpoints.find(item => item.id === endpointId);
    if (!target) throw new Error('mcp_endpoint_not_found');
    await this.store.write('mcp-endpoints', endpoints.filter(item => item.id !== endpointId));
    return target;
  }
  async resolveTool(qualifiedName) {
    const endpoints = await this.list();
    for (const endpoint of endpoints) {
      const tool = (endpoint.tools ?? []).find(t => t.qualifiedName === qualifiedName);
      if (tool) return { endpoint, tool };
    }
    throw new Error('mcp_tool_not_found');
  }
  async tools() {
    const endpoints = await this.list();
    return endpoints.flatMap(endpoint => (endpoint.tools ?? []).map(tool => ({ ...tool, endpointId: endpoint.id, endpointName: endpoint.name })));
  }
}
