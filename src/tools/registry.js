import { ComponentRegistry } from '../registry/catalog.js';
import { COMMON_TOOLS } from './common-defaults.js';

// Everything that describes what a tool *is* is owned by the code that ships it:
// the JSON schema, entry point, capabilities and description. Those are refreshed
// on every read, so a `git pull` plus restart reaches an existing deployment
// instead of only a fresh one. `status` is the interesting one — see
// OPERATOR_STATUSES below.
const DEFINITION_KEYS = ['type','name','version','entry','description','capabilities','permissions','requiresConsent','source','metadata'];

// The operator's global tool switch (POST /v1/admin/registry/tools/{id}) writes
// `status: 'DISABLED'`. That is a person's decision, so it always wins: a tool
// the operator switched off can never silently switch itself back on.
//
// Every other saved status (NOT_IMPLEMENTED, UNVERIFIED, BROKEN, DEPRECATED,
// ENABLED, VERIFIED) was written by an older checkout or by the code itself. The
// code's current status replaces it, so a tool that became real after a
// `git pull` stops being pinned as NOT_IMPLEMENTED forever — the operator has no
// switch to move it, so leaving the stale value would freeze it for good.
const OPERATOR_STATUSES = new Set(['DISABLED']);

// Sources that mean "the code owns this row". A row with one of these sources
// that the code no longer declares is a leftover from an older checkout and is
// dropped on read, so `git pull` plus restart can REMOVE a phantom tool and not
// only add one. A row with any other source was created by an operator and is
// never touched.
const CODE_OWNED_SOURCES = new Set(['runtime-common','runtime-native','runtime-native-pending','legacy-external-mcp']);

export class ToolRegistry extends ComponentRegistry {
  constructor(store) { super(store, {collection:'tools',type:'tool',defaults:COMMON_TOOLS}); }
  async list() {
    const saved = await this.store.read(this.collection, []);
    const byId = new Map(saved.map(item => [item.id, item]));
    const declared = new Set(this.defaults.map(item => item.id));
    let changed = false;
    for (const [id, item] of [...byId]) {
      if (CODE_OWNED_SOURCES.has(item?.source) && !declared.has(id)) { byId.delete(id); changed = true; }
    }
    for (const item of this.defaults) {
      const existing = byId.get(item.id);
      if (!existing) { byId.set(item.id, item); changed = true; continue; }
      // The definition is taken from code. Status follows the rule above.
      const refreshed = { ...existing };
      for (const key of DEFINITION_KEYS) if (key in item) refreshed[key] = item[key];
      refreshed.status = OPERATOR_STATUSES.has(existing.status) ? existing.status : item.status;
      if (JSON.stringify(refreshed) !== JSON.stringify(existing)) { byId.set(item.id, refreshed); changed = true; }
    }
    const merged = [...byId.values()];
    if (changed) await this.store.write(this.collection, merged);
    return merged;
  }
}
