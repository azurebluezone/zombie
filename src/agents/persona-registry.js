import { DEFAULT_AGENTS, getDefaultAgent } from './index.js';

const DEFAULT_PERSONAS = DEFAULT_AGENTS.map((agent, priority) => ({
  id: agent.id,
  name: agent.name,
  role: agent.role,
  expertise: agent.capabilities.join(', '),
  priority: priority + 1,
  persona: agent.persona
}));

export class PersonaRegistry {
  constructor(store, logger=null) { this.store=store; this.logger=logger; }

  async _saved() {
    const saved = await this.store.read('personas', []);
    return Array.isArray(saved) ? saved : [];
  }

  _default(id) {
    if (id) {
      const agent = getDefaultAgent(id);
      if (!agent) return null;
      return DEFAULT_PERSONAS.find(p => p.id === id) || null;
    }
    return DEFAULT_PERSONAS;
  }

  async list() {
    const saved = await this._saved();
    const byId = new Map(DEFAULT_PERSONAS.map(p => [p.id, p]));
    for (const item of saved) byId.set(item.id, item);
    return [...byId.values()].sort((a,b) => (a.priority ?? 99) - (b.priority ?? 99));
  }

  async resolve(id='code-guru') {
    const saved = await this._saved();
    const persisted = saved.find(p => p.id === id);
    const persona = persisted || this._default(id);
    if (!persona || persona.enabled === false) throw new Error('persona_not_found_or_disabled');
    await this.logger?.debug?.('persona.resolved', {
      requestedId:id,
      resolvedId:persona?.id,
      name:persona?.name,
      role:persona?.role,
      source:persisted ? 'database' : 'file-default',
      expertise:persona?.expertise
    });
    return persona;
  }

  async ensureDefaults() {
    const saved = await this._saved();
    const byId = new Map(saved.map(p => [p.id, p]));
    const missing = DEFAULT_PERSONAS.filter(p => !byId.has(p.id));
    if (missing.length) {
      await this.store.write('personas', [...saved, ...missing]);
    }
    return { seeded: missing.length, total: (await this._saved()).length };
  }

  async register(input) {
    if (!input?.id) throw new Error('persona_id_required');
    const item={
      id:String(input.id),
      name:String(input.name??input.id),
      role:String(input.role??'general'),
      expertise:String(input.expertise??''),
      priority:Number(input.priority??99),
      persona:String(input.persona??''),
      enabled:input.enabled !== false
    };
    const list=await this._saved();
    const next=list.filter(p=>p.id!==item.id); next.push(item);
    await this.store.write('personas',next);
    return item;
  }
}

export { DEFAULT_PERSONAS };
