import { id } from '../core/ids.js';

export class McpPermissions {
  constructor(store) { this.store = store; }
  async list() { return this.store.read('mcp-permissions', []); }
  async grant(input) {
    if (!input?.applicationId || !input?.qualifiedName) throw new Error('application_id_and_qualified_tool_required');
    const list = await this.list();
    const existing = list.find(x => x.applicationId === input.applicationId && x.qualifiedName === input.qualifiedName);
    if (existing) return existing;
    const item = { id: id('perm'), applicationId: input.applicationId, qualifiedName: input.qualifiedName, effect: 'allow', createdAt: new Date().toISOString() };
    list.push(item); await this.store.write('mcp-permissions', list); return item;
  }
  async revoke(applicationId, qualifiedName) {
    const list = await this.list();
    const next = list.filter(x => !(x.applicationId === applicationId && x.qualifiedName === qualifiedName));
    await this.store.write('mcp-permissions', next); return next.length !== list.length;
  }
  async allowed(applicationId, qualifiedName) {
    const list = await this.list();
    return list.some(x => x.applicationId === applicationId && x.qualifiedName === qualifiedName && x.effect === 'allow');
  }
}
