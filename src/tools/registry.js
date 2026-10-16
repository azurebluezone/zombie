import { ComponentRegistry } from '../registry/catalog.js';
import { COMMON_TOOLS } from './common-defaults.js';

// Everything that describes what a tool *is* is owned by the code that ships it:
// the JSON schema, entry point, capabilities and description. Those are refreshed
// on every read, so a `git pull` plus restart reaches an existing deployment
// instead of only a fresh one. `status` is different: the admin enable/disable
// switch writes it, so the saved value always wins and a tool the operator turned
// off can never silently switch itself back on.
const DEFINITION_KEYS = ['type','name','version','entry','description','capabilities','permissions','requiresConsent','source','metadata'];

export class ToolRegistry extends ComponentRegistry {
  constructor(store) { super(store, {collection:'tools',type:'tool',defaults:COMMON_TOOLS}); }
  async list() {
    const saved = await this.store.read(this.collection, []);
    const byId = new Map(saved.map(item => [item.id, item]));
    let changed = false;
    for (const item of this.defaults) {
      const existing = byId.get(item.id);
      if (!existing) { byId.set(item.id, item); changed = true; continue; }
      // Operator-owned state (status, enabled, updatedAt) stays as saved; the
      // definition is taken from code.
      const refreshed = { ...existing };
      for (const key of DEFINITION_KEYS) if (key in item) refreshed[key] = item[key];
      if (JSON.stringify(refreshed) !== JSON.stringify(existing)) { byId.set(item.id, refreshed); changed = true; }
    }
    const merged = [...byId.values()];
    if (changed) await this.store.write(this.collection, merged);
    return merged;
  }
}
