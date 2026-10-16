export class McpAudit {
  constructor(store) { this.store = store; }
  async append(event) {
    const events = await this.store.read('mcp-audit', []);
    events.push({ ...event, timestamp: new Date().toISOString() });
    await this.store.write('mcp-audit', events.slice(-5000));
  }
  async list(limit = 100) {
    const events = await this.store.read('mcp-audit', []);
    return events.slice(-Math.min(Number(limit) || 100, 500));
  }
}
