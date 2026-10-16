export class EntityDoor {
  constructor({ maxEntries = 64 } = {}) { this.maxEntries = maxEntries; }
  resolve(input = {}) {
    const raw = Array.isArray(input.entities) ? input.entities : [];
    const entities = raw.slice(0, this.maxEntries).map((item) => {
      if (typeof item === 'string') return { id:item, type:'unknown', name:item, source:'request' };
      return { id:String(item.id ?? item.name ?? ''), type:String(item.type ?? 'unknown'), name:String(item.name ?? item.id ?? ''), source:String(item.source ?? 'request') };
    }).filter((e) => e.id || e.name);
    return { entities, count:entities.length, truncated:raw.length > entities.length };
  }
}
