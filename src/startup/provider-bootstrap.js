export function parseProviderBootConfig(raw = '') {
  if (!raw?.trim()) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('PROVIDER_CONFIG_JSON_must_be_array');
  return value;
}

const PLACEHOLDER_PATTERN = /^REPLACE_WITH_/i;

// A provider id that a previous release shipped, mapped to the id that replaced it.
// `ollama-local` was renamed to `ollama-selfhosted`: the old wording made an
// operator (and other agents reading the config) treat a real, OpenAI-compatible
// endpoint as a throwaway toy. A stored row under a legacy id is retired on boot
// so the console does not list a provider that no longer exists in the seed.
const LEGACY_PROVIDER_IDS = Object.freeze({ 'ollama-local': 'ollama-selfhosted' });

// Fields that belong to the running deployment rather than to the .env seed:
// they are produced by model discovery, by an operator through the admin API, or
// by a health check. Restarting the runtime must never reset them.
const RUNTIME_OWNED_FIELDS = ['healthStatus', 'lastHealthCheckAt', 'lastHealthError', 'syncUrl', 'createdAt'];

/**
 * Seeds one boot entry over its stored record without destroying state the
 * deployment owns. PROVIDER_CONFIG_JSON is a seed: a field it declares with a
 * real value wins, while an empty/placeholder declaration leaves the discovered
 * or operator-set value in place. Without this, every restart wiped the
 * discovered model list, the default model and the alias mapping.
 */
export function carryForwardProviderState(existing, incoming = {}) {
  if (!existing) return { ...incoming };
  const merged = { ...incoming };

  const declaredModels = Array.isArray(incoming.models) ? incoming.models.filter(Boolean) : [];
  if (!declaredModels.length && Array.isArray(existing.models) && existing.models.length) {
    merged.models = existing.models;
    merged.modelsUpdatedAt = existing.modelsUpdatedAt ?? null;
  }

  const declaredDefault = String(incoming.defaultModel ?? '');
  if ((!declaredDefault || PLACEHOLDER_PATTERN.test(declaredDefault)) && existing.defaultModel) {
    merged.defaultModel = existing.defaultModel;
  }

  const declaredAliases = incoming.modelAliases && typeof incoming.modelAliases === 'object' ? Object.keys(incoming.modelAliases) : [];
  if (!declaredAliases.length && existing.modelAliases && Object.keys(existing.modelAliases).length) {
    merged.modelAliases = existing.modelAliases;
  }

  for (const field of RUNTIME_OWNED_FIELDS) {
    if (merged[field] === undefined && existing[field] !== undefined) merged[field] = existing[field];
  }
  return merged;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); })
  ]);
}

/**
 * Reconciles the stored model catalog with what each enabled provider actually
 * serves. This is what makes PROVIDER_MODELS_REFRESH_ON_START real instead of a
 * declaration that nothing reads.
 *
 * Refreshes run sequentially on purpose: refreshModels() rewrites the whole
 * provider list in one store write, so concurrent refreshes could overwrite each
 * other's results. Failures are recorded and never abort startup — a provider
 * that is offline simply keeps its previous declaration.
 */
export async function refreshProviderModelsOnStart({ registry, config = {}, logger, providers = undefined } = {}) {
  if (config.providerModelsRefreshOnStart !== true) return { enabled: false, refreshed: [], failed: [] };
  const list = providers ?? await registry.list();
  const refreshed = [];
  const failed = [];
  for (const item of list) {
    if (item.enabled === false) continue;
    if (/REPLACE_WITH_/i.test(String(item.baseUrl ?? ''))) continue;
    try {
      const updated = await withTimeout(registry.refreshModels(item.id), config.providerModelsRefreshTimeoutMs ?? 8000, 'provider_models_refresh');
      refreshed.push({ id: item.id, modelCount: updated.models.length, defaultModel: updated.defaultModel ?? null });
    } catch (error) {
      failed.push({ id: item.id, error: String(error?.message ?? error) });
    }
  }
  if (refreshed.length) await logger?.info?.('provider.models_refreshed', { providers: refreshed });
  if (failed.length) await logger?.warn?.('provider.models_refresh_failed', { providers: failed });
  return { enabled: true, refreshed, failed };
}

export async function bootstrapProviders({ registry, config, logger, bootConfig = undefined } = {}) {
  const boot = Array.isArray(bootConfig) ? bootConfig : parseProviderBootConfig(process.env.PROVIDER_CONFIG_JSON ?? '');
  const existingById = new Map((await registry.list()).map(item => [item.id, item]));
  // Retire a stored provider that only a previous release's id can explain. The
  // operator's own config always wins: an id the seed still declares is untouched.
  const declaredIds = new Set(boot.map(item => String(item.id)));
  const retired = [];
  for (const [legacyId, replacementId] of Object.entries(LEGACY_PROVIDER_IDS)) {
    if (declaredIds.has(legacyId) || !declaredIds.has(replacementId) || !existingById.has(legacyId)) continue;
    if (await registry.remove(legacyId)) {
      existingById.delete(legacyId);
      retired.push({ id: legacyId, replacedBy: replacementId });
    }
  }
  if (retired.length) await logger?.info?.('provider.legacy_id_retired', { providers: retired });
  const registered = [];
  for (const item of boot) {
    const seeded = carryForwardProviderState(existingById.get(item.id), item);
    const provider = await registry.register({...seeded, source: item.source ?? 'env-bootstrap'});
    registered.push({ id: provider.id, source: 'env', enabled: provider.enabled !== false, driver: provider.driver, baseUrl: provider.baseUrl, defaultModel: provider.defaultModel || null });
  }
  let sync = null;
  if (config.providerCatalogSyncUrl && config.providerCatalogSyncOnStart) {
    try {
      sync = await registry.syncAll({ syncUrl: config.providerCatalogSyncUrl, apiKey: config.providerCatalogApiKey, timeoutMs: config.providerSyncTimeoutMs });
      await logger.info('provider.catalog_synced', { providerCount: sync.providerCount, modelCount: sync.modelCount });
    } catch (error) {
      await logger.warn('provider.catalog_sync_failed', { error: String(error?.message ?? error) });
      sync = { ok: false, error: String(error?.message ?? error) };
    }
  }
  const modelsRefresh = await refreshProviderModelsOnStart({ registry, config, logger });
  return { registered, sync, modelsRefresh };
}
