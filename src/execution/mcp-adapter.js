import { callMcpTool } from '../mcp/client.js';
import { validateToolArguments } from '../mcp/schema.js';

export class McpExecutionAdapter {
  constructor({ registry, permissions, audit, connections, limits, logger=null }) {
    this.registry = registry;
    this.permissions = permissions;
    this.audit = audit;
    this.connections = connections;
    this.limits = limits;
    this.logger = logger;
  }

  async execute({ prepared, input = {}, applicationId, context } = {}) {
    if (!prepared?.consent?.allowed) throw new Error('execution_consent_required');
    if (!prepared?.contract?.goal) throw new Error('execution_contract_required');
    const qualifiedName = String(input.qualifiedName ?? '').trim();
    if (!qualifiedName) throw new Error('qualified_tool_required');
    if (!applicationId) throw new Error('application_id_required');

    let release;
    try {
      release = this.limits?.acquire(applicationId) ?? (() => {});
      const allowed = await this.permissions.allowed(applicationId, qualifiedName);
      const requestId = String(context?.requestId ?? input.requestId ?? `mcp-exec-${Date.now()}`);
      await this.logger?.info?.('mcp.execution.started', {requestId,applicationId,qualifiedName});
      if (!allowed) {
        await this.audit.append({ requestId, applicationId, runtimeId:context?.runtimeId ?? null, connectionId:context?.connectionId ?? null, qualifiedName, action: 'tool_call', stage: 'permission', outcome: 'denied' });
        throw new Error('mcp_tool_not_permitted');
      }

      const resolved = await this.registry.resolveTool(qualifiedName);
      const { endpoint, tool } = resolved;
      const args = input.arguments ?? {};
      validateToolArguments(tool, args);
      const connection = await this.connections.resolve({
        connectionId: input.connectionId,
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        clientId: input.clientId
      });
      const sessionId = connection?.sessionId || input.sessionId || endpoint.sessionId || null;

      await this.audit.append({ requestId, applicationId, endpointId: endpoint.id, qualifiedName, action: 'tool_call', stage: 'request', outcome: 'started', connectionId: connection?.connectionId ?? null, sessionId });
      try {
        const result = await callMcpTool(endpoint, tool.name, args, { sessionId });
        if (connection) await this.connections.touch(connection.connectionId, { sessionId });
        await this.audit.append({ requestId, applicationId, endpointId: endpoint.id, qualifiedName, action: 'tool_call', stage: 'result', outcome: 'success', connectionId: connection?.connectionId ?? null, sessionId });
        await this.logger?.info?.('mcp.execution.completed', {requestId,applicationId,qualifiedName,endpointId:resolved.endpoint.id});
        return { status: 'completed', target: 'mcp', result, endpointId: endpoint.id, qualifiedName, requestId, connectionId: connection?.connectionId ?? null, sessionId, evidence: [{ type: 'mcp_tool_execution', qualifiedName, outcome: 'success' }] };
      } catch (error) {
        await this.audit.append({ requestId, applicationId, endpointId: endpoint.id, qualifiedName, action: 'tool_call', stage: 'result', outcome: 'error', connectionId: connection?.connectionId ?? null, sessionId, error: error.message });
        await this.logger?.error?.('mcp.execution.failed', {requestId,applicationId,qualifiedName,error:String(error?.message ?? error)});
        throw error;
      }
    } finally {
      if (release) release();
    }
  }
}
