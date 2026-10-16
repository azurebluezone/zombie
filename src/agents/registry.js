import { ComponentRegistry } from '../registry/catalog.js';
import { DEFAULT_AGENTS } from './index.js';
import { getAgentToolBoundary } from './ecommerce-tool-boundaries.js';

function mergeAgentMetadata(saved, defaults) {
  const byId = new Map(defaults.map(item => [item.id, item]));
  for (const item of saved) byId.set(item.id, item);
  let changed = false;
  for (const item of defaults) {
    const current = byId.get(item.id);
    const boundary = getAgentToolBoundary(item.id);
    if (!boundary || !current) continue;
    const metadata = current.metadata && typeof current.metadata === 'object' ? current.metadata : {};
    if (metadata.toolBoundaryProfile === undefined) {
      byId.set(item.id, {...current, metadata: {...metadata, toolBoundaryProfile: boundary}});
      changed = true;
    }
  }
  return {items:[...byId.values()], changed};
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
    const upgraded = mergeAgentMetadata(merged, defaults);
    if (upgraded.changed) await this.store.write(this.collection, upgraded.items);
    return upgraded.items;
  }
}
