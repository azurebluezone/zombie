import { createProviderAdapter } from './adapters/factory.js';
import { extractModelIds, pickDefaultModel } from './model-catalog.js';
import { fetchProviderCatalog, mergeProviderCatalog, providerModelKey } from './sync.js';

function defaultProvider(config) {
  return {
    id: 'ollama-local',
    name: 'Ollama Local Compatible Endpoint',
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
      modelsUpdatedAt: input.modelsUpdatedAt ?? null
    };
    const list = await this.list();
    const next = list.filter((p) => p.id !== item.id); next.push(item);
    await this.store.write('providers', next);
    this.cache.delete(item.id);
    return item;
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
      .filter(p => !requestedModel || !Array.isArray(p.models) || !p.models.length || p.models.includes(requestedModel) || p.defaultModel === requestedModel)
      .sort((a,b) => (Number(a.priority ?? 999) - Number(b.priority ?? 999)) || String(a.id).localeCompare(String(b.id)));
  }

  async resolveModel(id, requestedModel = '') {
    const list = await this.list();
    const item = list.find((p) => p.id === id);
    if (!item || item.enabled === false) throw new Error('provider_not_found_or_disabled');
    const requested = String(requestedModel ?? '').trim();
    if (requested) return requested;
    if (item.defaultModel) return item.defaultModel;
    if (Array.isArray(item.models) && item.models.length) return item.models[0];
    const refreshed = await this.refreshModels(id);
    if (!refreshed.defaultModel) throw new Error('provider_model_required');
    return refreshed.defaultModel;
  }
}
