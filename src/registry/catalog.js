import { normalizeManifest, canResolveManifest } from './manifest.js';

export class ComponentRegistry {
  constructor(store, {collection, type, defaults = []} = {}) {
    if (!collection || !type) throw new Error('registry_configuration_required');
    this.store = store;
    this.collection = collection;
    this.type = type;
    this.defaults = defaults.map(item => normalizeManifest(item, type));
  }

  async list() {
    const saved = await this.store.read(this.collection, []);
    if (saved.length) return saved;
    if (this.defaults.length) {
      await this.store.write(this.collection, this.defaults);
      return this.defaults;
    }
    return [];
  }

  async register(input) {
    const item = normalizeManifest(input, this.type);
    const current = await this.list();
    const next = current.filter(existing => existing.id !== item.id);
    next.push(item);
    await this.store.write(this.collection, next);
    return item;
  }

  async resolve(id) {
    const item = (await this.list()).find(candidate => candidate.id === String(id));
    if (!item || !canResolveManifest(item)) throw new Error(`${this.type}_not_found_or_disabled`);
    return item;
  }
}
