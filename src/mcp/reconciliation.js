/**
 * Crash/incomplete execution reconciliation.
 * A request is considered incomplete only when a durable `request/started`
 * event exists without a terminal result event. Reconciliation never creates
 * a success event.
 */
export class McpReconciliation {
  constructor(audit, {graceMs = 30000} = {}) {
    this.audit = audit;
    const parsedGrace = Number(graceMs);
    this.graceMs = Number.isFinite(parsedGrace) ? Math.max(0, parsedGrace) : 30000;
  }

  async findIncomplete() {
    const events = await this.audit.list(5000);
    const byRequest = new Map();
    for (const event of events) {
      if (!event?.requestId) continue;
      const current = byRequest.get(event.requestId) ?? { request: null, terminal: null, recovery: null };
      if (event.stage === 'request' && event.outcome === 'started') current.request = event;
      if (event.stage === 'result' && ['success', 'error'].includes(event.outcome)) current.terminal = event;
      if (event.stage === 'recovery' && event.outcome === 'incomplete') current.recovery = event;
      byRequest.set(event.requestId, current);
    }
    const cutoff = Date.now() - this.graceMs;
    return [...byRequest.entries()]
      .filter(([, state]) => state.request && !state.terminal && !state.recovery)
      .filter(([, state]) => Date.parse(state.request.timestamp ?? 0) <= cutoff)
      .map(([requestId, state]) => ({ requestId, started: state.request }));
  }

  async reconcile() {
    const incomplete = await this.findIncomplete();
    const recovered = [];
    for (const item of incomplete) {
      const recovery = await this.audit.append({
        requestId: item.requestId,
        applicationId: item.started.applicationId,
        endpointId: item.started.endpointId,
        qualifiedName: item.started.qualifiedName,
        action: 'tool_call',
        stage: 'recovery',
        outcome: 'incomplete',
        reason: 'no_terminal_result_observed_before_reconciliation'
      });
      recovered.push(recovery);
    }
    return { scanned: incomplete.length, recovered };
  }
}
