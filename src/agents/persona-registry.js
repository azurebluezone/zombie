import { DEFAULT_AGENTS, getDefaultAgent } from './index.js';

/**
 * Persona registry.
 *
 * The database is the SSOT for persona text; the agent `.js` files are the
 * fallback and the source of truth for *defaults*.
 *
 * Ownership rule (this is what makes "fall back to the file" safe):
 *   - A row with `source: 'admin'` was saved by an operator. It is never
 *     overwritten by `ensureDefaults()`.
 *   - Any other row is "file-owned": `ensureDefaults()` keeps it in sync with
 *     the current file default, so shipping a better default actually reaches
 *     existing installations instead of only brand-new ones.
 *   - If no row exists at all, `resolve()` reads the file default directly.
 */

const ADMIN_SOURCE = 'admin';
const HISTORY_LIMIT = 3;
const HISTORY_TEXT_LIMIT = 2000;

const DEFAULT_PERSONAS = DEFAULT_AGENTS.map((agent, priority) => ({
  id: agent.id,
  name: agent.name,
  role: agent.role,
  callSign: agent.callSign ?? '',
  title: agent.title ?? '',
  expertise: agent.capabilities.join(', '),
  priority: priority + 1,
  persona: agent.persona
}));

function isAdminOwned(record) {
  return record?.source === ADMIN_SOURCE;
}

// Content fields only: bookkeeping (source, history, enabled) must not count as
// a difference, otherwise every startup would look like an upgrade.
function contentKey(record = {}) {
  return JSON.stringify([
    record.name ?? '',
    record.role ?? '',
    record.callSign ?? '',
    record.title ?? '',
    record.expertise ?? '',
    record.priority ?? null,
    record.persona ?? ''
  ]);
}

// Keep a short undo trail so an upgrade can never silently destroy text.
function nextHistory(previous, personaAfter) {
  const history = Array.isArray(previous?.personaHistory) ? previous.personaHistory.slice(-HISTORY_LIMIT) : [];
  const before = String(previous?.persona ?? '');
  const after = String(personaAfter ?? '');
  if (!before || before === after) return history;
  history.push({ at: new Date().toISOString(), persona: before.slice(0, HISTORY_TEXT_LIMIT) });
  return history.slice(-HISTORY_LIMIT);
}

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
      source:isAdminOwned(persisted) ? ADMIN_SOURCE : 'file-default',
      origin:persisted ? 'database' : 'file',
      personaChars:String(persona?.persona ?? '').length,
      expertise:persona?.expertise
    });
    return persona;
  }

  /**
   * Seed missing personas and refresh file-owned rows whose default changed.
   * Admin-owned rows are always preserved.
   */
  async ensureDefaults() {
    const saved = await this._saved();
    const byId = new Map(saved.map(p => [p.id, p]));
    const next = [...saved];
    let seeded = 0; let updated = 0; let preserved = 0;

    for (const def of DEFAULT_PERSONAS) {
      const existing = byId.get(def.id);
      if (!existing) { next.push(def); seeded++; continue; }
      if (isAdminOwned(existing)) { preserved++; continue; }
      if (contentKey(existing) === contentKey(def)) continue;
      const index = next.findIndex(p => p.id === def.id);
      next[index] = { ...def, enabled: existing.enabled !== false, personaHistory: nextHistory(existing, def.persona) };
      updated++;
      await this.logger?.info?.('persona.default_upgraded', {
        id:def.id,
        fromChars:String(existing.persona ?? '').length,
        toChars:String(def.persona ?? '').length
      });
    }

    if (seeded || updated) await this.store.write('personas', next);
    return { seeded, updated, preserved, total: (await this._saved()).length };
  }

  /**
   * Operator save. Marks the row admin-owned so future file defaults never
   * overwrite it.
   */
  async register(input) {
    if (!input?.id) throw new Error('persona_id_required');
    const list = await this._saved();
    const previous = list.find(p => p.id === String(input.id)) || null;
    const item={
      id:String(input.id),
      name:String(input.name??input.id),
      role:String(input.role??'general'),
      callSign:String(input.callSign??''),
      title:String(input.title??''),
      expertise:String(input.expertise??''),
      priority:Number(input.priority??99),
      persona:String(input.persona??''),
      enabled:input.enabled !== false,
      source:ADMIN_SOURCE,
      personaHistory:nextHistory(previous, input.persona)
    };
    const next=list.filter(p=>p.id!==item.id); next.push(item);
    await this.store.write('personas',next);
    await this.logger?.info?.('persona.saved', {
      id:item.id, source:ADMIN_SOURCE, personaChars:item.persona.length
    });
    return item;
  }
}

export { DEFAULT_PERSONAS };
