import { ComponentRegistry } from '../registry/catalog.js';
import { COMMON_TOOLS } from './common-defaults.js';

export class ToolRegistry extends ComponentRegistry {
  constructor(store) {
    super(store, {collection:'tools',type:'tool',defaults:COMMON_TOOLS});
  }
  async list() {
    const saved = await this.store.read(this.collection, []);
    const byId = new Map(saved.map(item => [item.id, item]));
    let changed = false;
    for (const item of this.defaults) if (!byId.has(item.id)) { byId.set(item.id,item); changed=true; }
    const merged = [...byId.values()];
    if (changed) await this.store.write(this.collection, merged);
    return merged;
  }
}
