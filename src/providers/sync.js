import { requestJson, authHeaders } from './adapters/base.js';
import { extractModelIds } from './model-catalog.js';

function cleanProvider(input = {}) {
  if (!input?.id || !input?.baseUrl) throw new Error('provider_sync_invalid_provider');
  const provider = {
    id: String(input.id),
    name: String(input.name ?? input.id),
    baseUrl: String(input.baseUrl).replace(/\/(models|chat\/completions)\/?$/, ''),
    defaultModel: String(input.defaultModel ?? ''),
    models: Array.isArray(input.models) ? [...new Set(input.models.map(String))] : [],
    enabled: input.enabled !== false,
    source: String(input.source ?? 'sync'),
    driver: String(input.driver ?? input.type ?? 'openai-compatible'),
    protocol: String(input.protocol ?? 'openai-compatible'),
    capabilities: Array.isArray(input.capabilities) ? [...new Set(input.capabilities.map(String))] : [],
    priority: Number.isFinite(Number(input.priority)) ? Math.min(10, Math.max(1, Math.trunc(Number(input.priority)))) : 10,
    modelAliases: input.modelAliases && typeof input.modelAliases === 'object' && !Array.isArray(input.modelAliases) ? Object.fromEntries(Object.entries(input.modelAliases).map(([k,v]) => [String(k).toLowerCase(), String(v)])) : {},
    syncUrl: input.syncUrl ? String(input.syncUrl) : undefined,
    updatedAt: new Date().toISOString()
  };
  // Deliberately ignore apiKey, token, headers and all unrecognized catalog fields.
  return provider;
}

export async function fetchProviderCatalog(syncUrl, { apiKey = '', networkPolicy = {}, timeoutMs = 30000 } = {}) {
  if (!syncUrl) throw new Error('provider_catalog_sync_url_required');
  const raw = await requestJson(syncUrl, 'GET', undefined, authHeaders(apiKey), timeoutMs, networkPolicy);
  const providers = Array.isArray(raw?.providers) ? raw.providers : [];
  const models = Array.isArray(raw?.models) ? raw.models : [];
  if (!providers.length && !models.length) throw new Error('provider_catalog_empty');
  return {
    providers: providers.map(cleanProvider),
    models: models.map(m => ({
      providerId: String(m.providerId ?? m.provider_id ?? ''),
      id: String(m.id ?? m.name ?? ''),
      name: String(m.name ?? m.id ?? '')
    })).filter(m => m.providerId && m.id)
  };
}

export function mergeProviderCatalog(existing = [], catalog = {}) {
  const safeExisting = existing.map(p => {
    const {apiKey, api_key, token, accessToken, authorization, headers, secret, ...safe} = p ?? {};
    return safe;
  });
  const byId = new Map(safeExisting.map(p => [String(p.id), p]));
  for (const incomingRaw of catalog.providers ?? []) {
    const incoming = cleanProvider(incomingRaw);
    const current = byId.get(incoming.id) ?? {};
    const scopedModels = (catalog.models ?? []).filter(m => m.providerId === incoming.id).map(m => m.id);
    byId.set(incoming.id, {
      ...current,
      ...incoming,
      models: [...new Set([...(incoming.models ?? []), ...scopedModels])],
      modelsUpdatedAt: scopedModels.length ? new Date().toISOString() : current.modelsUpdatedAt
    });
  }
  return [...byId.values()];
}

export function providerModelKey(providerId, modelId) {
  return `${String(providerId)}:${String(modelId)}`;
}

export function scopeModels(provider, modelIds = []) {
  return [...new Set(modelIds.map(String))].map(id => ({
    providerId: String(provider.id),
    modelId: id,
    key: providerModelKey(provider.id, id)
  }));
}
