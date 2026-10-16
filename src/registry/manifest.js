const TYPES = new Set(['agent','skill','tool','mcp','provider','transport']);
const STATUSES = new Set(['REGISTERED','ENABLED','VERIFIED','UNVERIFIED','DISABLED','DEPRECATED','BROKEN','NOT_IMPLEMENTED']);

export function normalizeManifest(input, expectedType) {
  if (!input || typeof input !== 'object') throw new Error('manifest_required');
  const type = String(input.type ?? expectedType ?? '').toLowerCase();
  if (!TYPES.has(type)) throw new Error('manifest_type_invalid');
  if (expectedType && type !== expectedType) throw new Error('manifest_type_mismatch');
  if (!input.id) throw new Error('manifest_id_required');

  const status = String(input.status ?? 'REGISTERED').toUpperCase();
  if (!STATUSES.has(status)) throw new Error('manifest_status_invalid');

  return {
    id: String(input.id),
    type,
    name: String(input.name ?? input.id).slice(0, 160),
    description: String(input.description ?? input.metadata?.description ?? '').slice(0, 1000),
    version: String(input.version ?? '0.0.0'),
    entry: input.entry == null ? null : String(input.entry),
    capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String) : [],
    permissions: Array.isArray(input.permissions) ? input.permissions.map(String) : [],
    requiresConsent: input.requiresConsent === true,
    enabled: input.enabled !== false,
    status,
    source: String(input.source ?? 'runtime'),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    updatedAt: new Date().toISOString()
  };
}

export function canResolveManifest(manifest) {
  return Boolean(manifest && manifest.enabled !== false && ['REGISTERED','ENABLED','VERIFIED'].includes(manifest.status));
}
