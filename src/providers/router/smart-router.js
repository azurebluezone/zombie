import { randomUUID } from 'node:crypto';
import { PROVIDER_CAPABILITIES } from '../capabilities.js';
import { resolveZombieModelAlias } from '../masking/zombie-models.js';

function uniq(values = []) { return [...new Set(values.map(String).filter(Boolean))]; }

function requestedCapabilities(input = {}) {
  const caps = [];
  if (input.stream === true) caps.push(PROVIDER_CAPABILITIES.streaming);
  if (Array.isArray(input.tools) && input.tools.length && input.allowJsonToolFallback !== true) caps.push(PROVIDER_CAPABILITIES.functionCalling);
  if (input.requireFunctionCalling === true) caps.push(PROVIDER_CAPABILITIES.functionCalling);
  if (input.requireModels === true) caps.push(PROVIDER_CAPABILITIES.models);
  caps.push(PROVIDER_CAPABILITIES.chatCompletions);
  return uniq(caps);
}

function providerSupports(provider, caps) {
  if (provider.enabled === false) return false;
  const declared = new Set(Array.isArray(provider.capabilities) ? provider.capabilities : []);
  // The Gemini adapter accepts the runtime's canonical chat-completions contract
  // while translating requests to Gemini generateContent upstream. Keep the
  // upstream protocol label separate from the runtime-facing capability.
  if (provider.driver === 'gemini') {
    // This adapter translates the runtime chat contract to Gemini generateContent.
    declared.add(PROVIDER_CAPABILITIES.chatCompletions);
  }
  // An empty capability list means the adapter's known defaults are authoritative.
  if (!declared.size) return true;
  return caps.every(cap => declared.has(cap));
}

export class SmartRouter {
  constructor({providers, logger=null}={}) { this.providers = providers; this.logger = logger; }

  async candidates(input = {}) {
    const all = await this.providers.list();
    const caps = requestedCapabilities(input);
    const requestedProvider = String(input.provider ?? '').trim();
    const requestedModel = String(input.model ?? '').trim();
    const modelAlias = resolveZombieModelAlias(requestedModel);
    const candidates = [];
    // A provider that explicitly maps the requested public alias outranks one
    // that merely falls back to its default model. Fallback candidates stay in
    // the list afterwards so failover still works.
    const explicitAliasCandidates = [];
    const fallbackCandidates = [];
    const legacyPriorities = [...new Set(all.map(p => Number(p.priority)).filter(value => Number.isFinite(value) && value > 10))].sort((a,b)=>a-b);
    const legacyPriorityMap = new Map(legacyPriorities.map((value,index)=>[value,Math.min(10,index+1)]));

    for (const provider of all) {
      if (requestedProvider && provider.id !== requestedProvider) continue;
      if (!providerSupports(provider, caps)) continue;
      const models = Array.isArray(provider.models) ? provider.models : [];
      let targetModel = requestedModel;
      let explicitAlias = false;
      if (modelAlias) {
        const aliasMap = provider.modelAliases && typeof provider.modelAliases === 'object' ? provider.modelAliases : {};
        const mapped = aliasMap[modelAlias.id] ?? aliasMap[modelAlias.id.replaceAll('-', '_')];
        explicitAlias = Boolean(mapped);
        targetModel = mapped ?? provider.defaultModel ?? models[0] ?? '';
        if (!targetModel || /^REPLACE_WITH_/i.test(String(targetModel))) continue;
        if (models.length && !models.includes(targetModel)) continue;
      } else if (requestedModel && models.length && !models.includes(requestedModel) && provider.defaultModel !== requestedModel) continue;
      else if (!requestedModel) targetModel = provider.defaultModel || models[0] || '';
      const candidate = {
        providerId: provider.id,
        provider,
        model: targetModel,
        publicModel: modelAlias?.id ?? '',
        explicitAlias,
        priority: Number.isFinite(Number(provider.priority)) ? (Number(provider.priority) > 10 ? (legacyPriorityMap.get(Number(provider.priority)) ?? 10) : Math.min(10, Math.max(1, Number(provider.priority)))) : 10,
        capabilities: caps,
        nativeFunctionCalling: !Array.isArray(provider.capabilities) || provider.capabilities.length === 0 || provider.capabilities.includes(PROVIDER_CAPABILITIES.functionCalling)
      };
      if (explicitAlias) explicitAliasCandidates.push(candidate); else fallbackCandidates.push(candidate);
    }

    // Sort each group on its own, then concatenate: an explicit alias mapping
    // must outrank a default-model fallback rather than being re-sorted under it.
    const comparator = (a,b) => (input.allowJsonToolFallback === true && Array.isArray(input.tools) && input.tools.length ? Number(b.nativeFunctionCalling) - Number(a.nativeFunctionCalling) : 0) || a.priority - b.priority || String(a.providerId).localeCompare(String(b.providerId));
    explicitAliasCandidates.sort(comparator);
    fallbackCandidates.sort(comparator);
    candidates.push(...(explicitAliasCandidates.length ? [...explicitAliasCandidates, ...fallbackCandidates] : fallbackCandidates));

    return {caps, candidates};
  }

  async route(input = {}) {
    const {caps, candidates} = await this.candidates(input);
    if (!candidates.length) throw new Error('no_provider_route_available');
    const selected = candidates[0];
    const route = {
      routeId: `route_${randomUUID()}`,
      providerId: selected.providerId,
      model: selected.model || null,
      publicModel: selected.publicModel || null,
      requiredCapabilities: caps,
      candidates: candidates.map(c => ({providerId:c.providerId, model:c.model || null, priority:c.priority, nativeFunctionCalling:c.nativeFunctionCalling, explicitAlias:c.explicitAlias === true})),
      reason: input.provider ? 'explicit_constraint_then_priority' : (selected.explicitAlias ? 'explicit_model_alias' : (input.model ? 'explicit_constraint_then_priority' : 'capability_then_priority')),
      status: 'selected'
    };
    await this.logger?.info?.('router.route.selected', {
      routeId:route.routeId, providerId:route.providerId, model:route.model,
      requiredCapabilities:route.requiredCapabilities, candidateCount:route.candidates.length
    });
    return route;
  }
}
