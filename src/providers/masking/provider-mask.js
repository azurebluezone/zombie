export const ZOMBIE_PROVIDER_NAME = 'ZombieCoder';

export function maskProviderName() { return ZOMBIE_PROVIDER_NAME; }

export function maskModelName({agentId='code-guru', configuredName='' }={}) {
  const safeAgent = String(agentId || 'code-guru').replace(/[^a-zA-Z0-9._-]/g, '-');
  return String(configuredName || '').trim() || `zombiecoder/${safeAgent}`;
}

export function createAgentProviderIdentity({agentId='code-guru', configuredModel='', capabilities=[]}={}) {
  return {
    provider: ZOMBIE_PROVIDER_NAME,
    model: maskModelName({agentId, configuredName:configuredModel}),
    capabilities: [...new Set((Array.isArray(capabilities) ? capabilities : []).map(String))]
  };
}

export function maskCanonicalResponse(response, {agentId='code-guru', configuredModel='', capabilities=[]}={}) {
  if (!response || typeof response !== 'object') throw new Error('canonical_response_invalid');
  const identity = createAgentProviderIdentity({agentId, configuredModel, capabilities});
  const copy = structuredClone(response);
  delete copy.provider;
  // The agent-facing envelope gets the masked identity; provider infrastructure never leaks through.
  copy.model = identity.model;
  return { ...copy, provider: identity.provider };
}

/**
 * Evidence items carry `source: "provider:<upstreamId>"`. That value is internal
 * provenance: the runtime keeps the real upstream id in its log and evidence store,
 * but a client must only ever see the masked provider name. Masking the response
 * envelope alone is not enough because evidence is attached *after* masking, so
 * every client-facing payload must pass through here.
 */
export function maskEvidenceSource(source) {
  const text = String(source ?? '');
  return text.startsWith('provider:') ? `provider:${ZOMBIE_PROVIDER_NAME}` : text;
}

export function maskEvidenceForPublic(evidence) {
  if (!Array.isArray(evidence)) return evidence;
  return evidence.map(item => (item && typeof item === 'object' ? { ...item, source: maskEvidenceSource(item.source) } : item));
}

/**
 * Route metadata for the public surface: identifiers and counts only.
 * The candidate list is internal routing state (it names other providers and their
 * upstream models), so it is reduced to `candidateCount` exactly like the chat
 * tool-loop response does.
 */
export function maskRouteForPublic(route, {publicModel=null}={}) {
  if (!route || typeof route !== 'object') return route ?? null;
  const candidates = Array.isArray(route.candidates) ? route.candidates : [];
  const model = publicModel ?? route.publicModel ?? null;
  return {
    routeId: route.routeId ?? null,
    providerId: 'masked',
    model,
    publicModel: model,
    requiredCapabilities: Array.isArray(route.requiredCapabilities) ? [...route.requiredCapabilities] : [],
    candidateCount: candidates.length,
    reason: route.reason ?? null,
    status: route.status ?? null
  };
}
