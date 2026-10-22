import { createProviderAdapter } from './adapters/factory.js';
import { extractModelIds, pickDefaultModel } from './model-catalog.js';
import { fetchProviderCatalog, mergeProviderCatalog, providerModelKey } from './sync.js';

// `REPLACE_WITH_...` is the placeholder `.env.example` ships so an operator has to
// choose a model deliberately. It must never be sent upstream: the provider answers
// with an error about the model it never received, and the operator is left reading
// provider_http_error instead of the one line that needs editing.
function requireConfiguredModel(model) {
  if (/^REPLACE_WITH_/i.test(String(model ?? ''))) throw new Error('provider_model_not_configured');
  return model;
}

function defaultProvider(config) {
  return {
    id: 'ollama-selfhosted',
    name: 'Ollama Self-Hosted',
    baseUrl: config?.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    defaultModel: '',
    models: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    source: 'configured-ollama-endpoint',
    driver: 'ollama',
    protocol: 'openai-compatible',
    capabilities: ['chat-completions','streaming','function-calling','model-catalog'],
    priority: 10
  };
}

export class ProviderRegistry {
  constructor(store, config) { this.store = store; this.config = config; this.cache = new Map(); }

  async list() {
    let providers = await this.store.read('providers', []);
    if (providers.length) {
      // One-time compatibility migration: older releases stored priorities such as 100/110/200.
      // Convert those legacy values to free slots in 1..10 and persist the normalized column.
      if (providers.some(p => !Number.isFinite(Number(p.priority)) || Number(p.priority) > 10 || Number(p.priority) < 1)) {
        const occupied = new Set(providers.map(p => Number(p.priority)).filter(value => Number.isInteger(value) && value >= 1 && value <= 10));
        const legacyValues = [...new Set(providers.map(p => Number(p.priority)).filter(value => Number.isFinite(value) && (value > 10 || value < 1)))].sort((a,b)=>a-b);
        const freeSlots = Array.from({length:10},(_,index)=>index+1).filter(value=>!occupied.has(value));
        const legacyMap = new Map(legacyValues.map((value,index)=>[value,freeSlots[index] ?? 10]));
        providers = providers.map(p => {
          const raw = Number(p.priority);
          const priority = Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : (legacyMap.get(raw) ?? 10);
          return {...p, priority};
        });
        await this.store.write('providers', providers);
      }
      return providers;
    }
    const provider = defaultProvider(this.config);
    await this.store.write('providers', [provider]);
    return [provider];
  }

  async register(input) {
    if (!input?.baseUrl) throw new Error('provider_baseUrl_required');
    const item = {
      id: input.id ?? `provider_${Date.now()}`,
      name: String(input.name ?? input.id ?? 'provider').slice(0, 120),
      baseUrl: String(input.baseUrl).replace(/\/(models|chat\/completions)\/?$/, ''),
      // The name of the env var this provider's base URL came from, when the seed
      // declared one. Kept so the console can say "seeded from CUSTOM_…_BASE_URL"
      // instead of pretending the URL lives in the database.
      baseUrlEnv: input.baseUrlEnv ? String(input.baseUrlEnv) : null,
      defaultModel: String(input.defaultModel ?? ''),
      models: Array.isArray(input.models) ? [...new Set(input.models.map(String))] : [],
      enabled: input.enabled !== false,
      createdAt: input.createdAt ?? new Date().toISOString(),
      source: input.source ?? 'admin-configured',
      driver: input.driver ?? 'openai-compatible',
      protocol: input.protocol ?? 'openai-compatible',
      capabilities: Array.isArray(input.capabilities) ? [...new Set(input.capabilities.map(String))] : [],
      priority: Number.isFinite(Number(input.priority)) ? Math.min(10, Math.max(1, Math.trunc(Number(input.priority)))) : 10,
      modelAliases: input.modelAliases && typeof input.modelAliases === 'object' && !Array.isArray(input.modelAliases) ? Object.fromEntries(Object.entries(input.modelAliases).map(([k,v]) => [String(k).toLowerCase(), String(v)])) : {},
      syncUrl: input.syncUrl ? String(input.syncUrl) : undefined,
      modelsUpdatedAt: input.modelsUpdatedAt ?? null,
      // A disabled model stays in the catalog (the vendor still serves it) but is
      // skipped by routing. Stored as ids, so it survives a refresh of the catalog.
      disabledModels: Array.isArray(input.disabledModels) ? [...new Set(input.disabledModels.map(String))] : [],
      // Persisted health surface. Without these the admin console could only
      // ever render "unknown": register() rebuilds the record from a fixed
      // field list, so anything not listed here was silently dropped.
      healthStatus: input.healthStatus ?? null,
      lastHealthCheckAt: input.lastHealthCheckAt ?? null,
      lastHealthError: input.lastHealthError ?? null
    };
    const list = await this.list();
    const next = list.filter((p) => p.id !== item.id); next.push(item);
    await this.store.write('providers', next);
    this.cache.delete(item.id);
    return item;
  }

  /**
   * Remove a stored provider. Used by the boot migration that retires an id a
   * previous release shipped, so a renamed provider does not leave a phantom row
   * behind in the admin console.
   */
  async remove(id) {
    const list = await this.list();
    const next = list.filter((p) => p.id !== String(id));
    if (next.length === list.length) return false;
    await this.store.write('providers', next);
    this.cache.delete(String(id));
    return true;
  }

  async resolve(id) {
    const list = await this.list(); const item = list.find((p) => p.id === id);
    if (!item || item.enabled === false) throw new Error('provider_not_found_or_disabled');
    if (!this.cache.has(id)) this.cache.set(id, createProviderAdapter(item, this.config));
    return this.cache.get(id);
  }

  async refreshModels(id) {
    const list = await this.list();
    const item = list.find((p) => p.id === id);
    if (!item || item.enabled === false) throw new Error('provider_not_found_or_disabled');
    const provider = await this.resolve(id);
    const raw = await provider.listModels();
    const models = extractModelIds(raw);
    const defaultModel = pickDefaultModel(models, item.defaultModel);
    const updated = {...item, models, defaultModel, modelsUpdatedAt:new Date().toISOString()};
    await this.store.write('providers', list.map(p => p.id === id ? updated : p));
    this.cache.delete(id);
    return updated;
  }


  async syncAll({ syncUrl = this.config.providerCatalogSyncUrl, apiKey = this.config.providerCatalogApiKey, timeoutMs = this.config.providerSyncTimeoutMs } = {}) {
    if (!syncUrl) throw new Error('provider_catalog_sync_url_required');
    const current = await this.list();
    const catalog = await fetchProviderCatalog(syncUrl, { apiKey, networkPolicy: this.config.providerNetworkPolicy, timeoutMs });
    const merged = mergeProviderCatalog(current, catalog);
    await this.store.write('providers', merged);
    this.cache.clear();
    return { source: syncUrl, providerCount: merged.length, modelCount: merged.reduce((n,p) => n + (Array.isArray(p.models) ? p.models.length : 0), 0), providers: merged };
  }

  async syncProvider(id, { syncUrl, timeoutMs = this.config.providerSyncTimeoutMs } = {}) {
    const current = await this.list();
    const item = current.find(p => p.id === id);
    if (!item) throw new Error('provider_not_found');
    const target = syncUrl ?? item.syncUrl;
    if (target) {
      const catalog = await fetchProviderCatalog(target, { apiKey: this.config.providerApiKeys?.[id] ?? '', networkPolicy: this.config.providerNetworkPolicy, timeoutMs });
      const merged = mergeProviderCatalog(current, catalog);
      const updated = merged.find(p => p.id === id);
      await this.store.write('providers', merged);
      this.cache.delete(id);
      return { provider: updated, modelKeys: (updated.models ?? []).map(model => providerModelKey(id, model)), source: target };
    }
    const updated = await this.refreshModels(id);
    return { provider: updated, modelKeys: (updated.models ?? []).map(model => providerModelKey(id, model)), source: 'provider-models-endpoint' };
  }

  async routeCandidates(input = {}) {
    const list = await this.list();
    const requestedProvider = String(input.provider ?? '').trim();
    const requestedModel = String(input.model ?? '').trim();
    return list
      .filter(p => p.enabled !== false && (!requestedProvider || p.id === requestedProvider))
      .filter(p => !requestedModel || !(Array.isArray(p.disabledModels) && p.disabledModels.includes(requestedModel)))
      .filter(p => !requestedModel || !Array.isArray(p.models) || !p.models.length || p.models.includes(requestedModel) || p.defaultModel === requestedModel)
      .sort((a,b) => (Number(a.priority ?? 999) - Number(b.priority ?? 999)) || String(a.id).localeCompare(String(b.id)));
  }

  async resolveModel(id, requestedModel = '') {
    const list = await this.list();
    const item = list.find((p) => p.id === id);
    if (!item || item.enabled === false) throw new Error('provider_not_found_or_disabled');
    const requested = String(requestedModel ?? '').trim();
    if (requested && Array.isArray(item.disabledModels) && item.disabledModels.includes(requested)) throw new Error('model_disabled');
    if (requested) return requested;
    // A shipped placeholder such as REPLACE_WITH_SUPPORTED_GEMINI_MODEL is not a model
    // id. Sending it upstream answered with an opaque provider_http_error that said
    // nothing about the real problem; naming it tells the operator which line to fix.
    if (item.defaultModel) return requireConfiguredModel(item.defaultModel);
    if (Array.isArray(item.models) && item.models.length) return requireConfiguredModel(item.models[0]);
    const refreshed = await this.refreshModels(id);
    if (!refreshed.defaultModel) throw new Error('provider_model_required');
    return requireConfiguredModel(refreshed.defaultModel);
  }
}
