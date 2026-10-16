import { ComponentRegistry } from '../registry/catalog.js';
import { DEFAULT_AGENTS } from './index.js';
import { getAgentToolBoundary } from './ecommerce-tool-boundaries.js';
import { normalizeAgentAccess } from './access.js';

// One pass that both preserves the legacy ecommerce boundary profile and makes
// sure every agent carries the tool-access scope fields. A record that predates
// the scope columns is upgraded in place, so an operator never has to run a
// migration by hand.
function mergeAgentAccess(saved, defaults) {
  const byId = new Map(defaults.map(item => [item.id, item]));
  for (const item of saved) byId.set(item.id, item);
  let changed = false;
  for (const item of defaults) {
    const current = byId.get(item.id);
    if (!current) continue;
    let next = current;
    const boundary = getAgentToolBoundary(item.id);
    const metadata = next.metadata && typeof next.metadata === 'object' ? next.metadata : {};
    if (boundary && metadata.toolBoundaryProfile === undefined) {
      next = { ...next, metadata: { ...metadata, toolBoundaryProfile: boundary } };
      changed = true;
    }
    const access = normalizeAgentAccess(next);
    if (next.toolBoundary !== access.toolBoundary || (next.workingDirectory ?? null) !== access.workingDirectory) {
      next = { ...next, ...access };
      changed = true;
    }
    byId.set(item.id, next);
  }
  return { items: [...byId.values()], changed };
}

export class AgentRegistry extends ComponentRegistry {
  constructor(store) {
    super(store, { collection: 'agents', type: 'agent', defaults: DEFAULT_AGENTS });
  }

  async list() {
    const saved = await this.store.read(this.collection, []);
    const defaults = this.defaults;
    const merged = saved.length ? saved : defaults;
    if (!saved.length && defaults.length) await this.store.write(this.collection, defaults);
    const upgraded = mergeAgentAccess(merged, defaults);
    if (upgraded.changed) await this.store.write(this.collection, upgraded.items);
    return upgraded.items;
  }

  /**
   * Persist a new access scope for one agent and return the stored record.
   * The record always keeps its identity, status and metadata; only the scope
   * fields move, so a scope edit can never disable an agent.
   */
  async setAccess(agentId, input = {}) {
    const current = await this.resolve(agentId);
    if (!current) throw new Error('agent_not_found');
    const next = { ...current, ...normalizeAgentAccess({ ...current, ...input }) };
    const items = (await this.list()).map(item => (item.id === next.id ? next : item));
    await this.store.write(this.collection, items);
    return next;
  }
}
