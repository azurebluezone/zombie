export const ZOMBIE_PROVIDER_NAME = 'ZombieCoder';

export function maskProviderName() { return ZOMBIE_PROVIDER_NAME; }

// The public surface may only name a routing alias it created itself. Anything
// else — an upstream model id such as `gpt-oss:20b` or `gemini-2.5-flash` — is
// provider identity and must be replaced. The previous implementation echoed
// whatever `configuredName` it was given, so one caller passing a real model
// name was enough to leak it.
const PUBLIC_MODEL_PATTERN = /^(?:zombie-[a-z0-9][a-z0-9._-]*|zombiecoder\/[a-z0-9][a-z0-9._-]*)$/i;

export function isPublicModelName(value) {
  return PUBLIC_MODEL_PATTERN.test(String(value ?? '').trim());
}

export function maskModelName({agentId='code-guru', configuredName='' }={}) {
  const safeAgent = String(agentId || 'code-guru').replace(/[^a-zA-Z0-9._-]/g, '-');
  const configured = String(configuredName ?? '').trim();
  return isPublicModelName(configured) ? configured : `zombiecoder/${safeAgent}`;
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
  // OpenAI's choice object always carries `logprobs` — null unless the caller asked
  // for it. A client that validates the response shape should not have to special-case
  // this runtime, so the field is added when the upstream provider omitted it.
  if (Array.isArray(copy.choices)) {
    copy.choices = copy.choices.map(choice =>
      choice && typeof choice === 'object' && !Object.hasOwn(choice, 'logprobs')
        ? { ...choice, logprobs: null }
        : choice);
  }
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
  const requested = publicModel ?? route.publicModel ?? null;
  // A route summary without a public alias says `model: null`; it never falls
  // back to the upstream model name just to fill the field.
  const model = isPublicModelName(requested) ? requested : null;
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
