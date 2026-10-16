import { ZOMBIECODER_MODELS } from '../../providers/masking/zombie-models.js';

/**
 * Legacy frontend contract adapters.
 * These adapters preserve legacy field names/envelopes without exposing provider secrets.
 * They do not claim behavioral parity for actions that are not implemented in the modular runtime.
 */

export function legacyModelList({agents=[], providers=[]}={}) {
  const now = Math.floor(Date.now()/1000);
  // Agent-facing API intentionally exposes only stable ZombieCoder aliases.
  // Raw upstream model IDs remain available through authenticated admin routes.
  const routable = (providers ?? []).some(provider => {
    if (provider.enabled === false) return false;
    const models = Array.isArray(provider.models) ? provider.models : [];
    const aliases = provider.modelAliases && typeof provider.modelAliases === 'object' ? provider.modelAliases : {};
    const hasTarget = ZOMBIECODER_MODELS.some(model => {
      const target = aliases[model.id] ?? aliases[model.id.replaceAll('-', '_')] ?? provider.defaultModel ?? models[0] ?? '';
      return Boolean(target && !/^REPLACE_WITH_/i.test(String(target)) && (!models.length || models.includes(target) || Boolean(aliases[model.id]) || Boolean(aliases[model.id.replaceAll('-', '_')]) || Boolean(provider.defaultModel)));
    });
    return hasTarget;
  });
  return {
    object: 'list',
    data: routable ? ZOMBIECODER_MODELS.map(model => ({id:model.id, object:'model', created:now, owned_by:'ZombieCoder'})) : []
  };
}

export function legacyProviderModelList(providers=[]) {
  const now=Math.floor(Date.now()/1000);
  const data=[];
  for (const provider of providers) {
    const models=Array.isArray(provider.models)&&provider.models.length?provider.models:[provider.defaultModel||'*'];
    for(const model of models) data.push({
      id:model==='*'?'*':String(model),
      provider:provider.id,
      providerName:provider.name||provider.id,
      type:provider.protocol||provider.driver||'openai',
      apiModel:model==='*'?'*':String(model),
      free:false,
      object:'model',
      created:now,
      owned_by:provider.name||provider.id
    });
  }
  return {object:'list',data,total_providers:providers.length,total_models:data.length};
}

export function legacyNormalizeList({providers=[],models=[]}={}) {
  return {
    normalizer:'Haq Mawla Universal Response Normalizer',
    version:'1.0.0',
    providers:providers.map(p=>({id:p.id,name:p.name||p.id,type:p.protocol||p.driver||'openai',baseUrl:p.baseUrl||'',models:p.models||[],priority:p.priority})),
    models,
    features:['OpenAI standard format','Anthropic format (content array)','Gemini format (candidates/parts)','Raw string fallback','Provider detection','Dynamic provider routing','SQLite-backed provider catalog'],
    evidence:'contract-adapter'
  };
}

export function legacyDomain({requestHost='localhost',version='0.0.0',projectRoot=null}={}) {
  return {detected:requestHost,startup:requestHost,hostHeader:requestHost,type:'runtime',version,hasFrontend:true,hasPusher:false,hasDevModels:false,maxRateLimit:null,corsOrigins:[],sessionVerifyUrl:null,envOverride:null,allDomains:[requestHost],projectRoot};
}

export function legacyPusherConfig() {
  return {enabled:false,key:null,cluster:'ap2',source:'runtime-no-pusher'};
}
