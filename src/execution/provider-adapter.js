import { createVerificationRecord } from './contract.js';
import { SmartRouter } from '../providers/router/smart-router.js';
import { maskCanonicalResponse, createAgentProviderIdentity } from '../providers/masking/provider-mask.js';
import { providerErrorDetail } from '../providers/adapters/request-shape.js';
import { stripUnsupportedTools } from '../tools/parser.js';
import { ExecutionLifecycle } from './lifecycle.js';
import { completionToStreamChunk } from '../providers/normalizer/stream-chunk.js';

export class ProviderExecutionAdapter {
  constructor({providers, normalizer, logger=null, router=null, lifecycle=null}) {
    this.providers = providers;
    this.normalizer = normalizer;
    this.logger = logger;
    this.router = router ?? new SmartRouter({providers, logger});
    this.lifecycle = lifecycle ?? new ExecutionLifecycle({normalizer, logger});
  }

  async execute({prepared, input = {}} = {}) {
    if (!prepared?.consent?.allowed) throw new Error('execution_consent_required');
    if (!prepared?.contract?.goal) throw new Error('execution_contract_required');

    const route = await this.router.route(input);
    const candidates = route.candidates;
    const messages = Array.isArray(input.messages) ? input.messages : [{role:'system',content:'ZombieCoder execution system prompt.'},{role:'user', content:prepared.contract.goal}];
    await this.lifecycle.begin({sessionId:input.sessionId ?? null, applicationId:input.applicationId ?? null, messages});
    let lastError = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      let emitted = false;
      try {
        const provider = await this.providers.resolve(candidate.providerId);
        const model = await this.providers.resolveModel(candidate.providerId, route.publicModel ? candidate.model : (input.model || candidate.model));
        const preparedInput = stripUnsupportedTools({...input, messages, model, stream:false}, provider.capabilities ?? {});
        await this.logger?.info?.('provider.execution.started', {routeId:route.routeId,providerId:provider.id,model,goalPresent:Boolean(prepared?.contract?.goal),toolsStripped:preparedInput.stripped});
        const raw = await provider.chatCompletions(preparedInput.input);
        const canonicalInput = typeof provider.toCanonical === 'function' ? provider.toCanonical(raw) : raw;
        const canonical = this.normalizer.normalize(canonicalInput, {model, providerId:provider.id});
        const identity = createAgentProviderIdentity({agentId:input.agent ?? input.persona ?? 'code-guru',configuredModel:'',capabilities:Object.keys(provider.capabilities ?? {}).filter(k => provider.capabilities[k])});
        const masked = maskCanonicalResponse(canonical, {agentId:input.agent ?? input.persona ?? 'code-guru',configuredModel:route.publicModel || '',capabilities:identity.capabilities});
        const content = canonical?.choices?.[0]?.message?.content ?? null;
        const evidence = content ? [await this.lifecycle.providerObserved({sessionId:input.sessionId ?? null,applicationId:input.applicationId ?? null,providerId:provider.id,model,canonical})] : [];
        const verification = createVerificationRecord({contract:prepared.contract,expected:prepared.contract.expectedOutcome,actual:content ? 'provider_response_received' : null,evidence});
        await this.logger?.info?.('provider.execution.completed', {routeId:route.routeId,providerId:provider.id,model,status:'unverified',responseId:canonical.id,verified:false});
        await this.lifecycle.complete({sessionId:input.sessionId ?? null,applicationId:input.applicationId ?? null,verified:false,status:'completed_unverified'});
        return {status:'completed_unverified',providerId:provider.id,model,route,identity,response:masked,verification,evidence,verified:false};
      } catch (error) {
        lastError = error;
        await this.lifecycle.providerFailure({sessionId:input.sessionId ?? null,applicationId:input.applicationId ?? null,providerId:candidate.providerId,model:candidate.model, error, attempt:index+1, remainingCandidates:candidates.length-index-1});
        await this.logger?.error?.('router.provider.failed', {routeId:route.routeId,providerId:candidate.providerId,model:candidate.model,error:String(error?.message ?? error),...providerErrorDetail(error)});
      }
    }
    throw lastError ?? new Error('provider_route_failed');
  }

  async stream({prepared, input = {}, onChunk} = {}) {
    if (!prepared?.consent?.allowed) throw new Error('execution_consent_required');
    if (!prepared?.contract?.goal) throw new Error('execution_contract_required');
    const route = await this.router.route(input);
    const candidates = route.candidates;
    const messages = Array.isArray(input.messages) ? input.messages : [{role:'system',content:'ZombieCoder execution system prompt.'},{role:'user', content:prepared.contract.goal}];
    await this.lifecycle.begin({sessionId:input.sessionId ?? null, applicationId:input.applicationId ?? null, messages});
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      let emitted = false;
      try {
        const provider = await this.providers.resolve(candidate.providerId);
        const model = await this.providers.resolveModel(candidate.providerId, route.publicModel ? candidate.model : (input.model || candidate.model));
        if (typeof provider.streamChat !== 'function') throw new Error('provider_streaming_not_supported');
        const preparedInput = stripUnsupportedTools({...input, messages, model, stream:true}, provider.capabilities ?? {});
        await this.logger?.info?.('provider.execution.started', {routeId:route.routeId,providerId:provider.id,model,goalPresent:Boolean(prepared?.contract?.goal),stream:true,toolsStripped:preparedInput.stripped});
        await provider.streamChat(preparedInput.input, raw => {
          if (raw?.done === true && !raw?.choices) return;
          const canonicalInput = typeof provider.streamChunk === 'function' ? provider.streamChunk(raw) : raw;
          const chunk = canonicalInput?.choices ? this.normalizer.normalize(canonicalInput, {model, providerId:provider.id}) : null;
          if (chunk) { emitted = true; onChunk?.(maskCanonicalResponse(chunk, {agentId:input.agent ?? input.persona ?? 'code-guru',configuredModel:route.publicModel || '',capabilities:Object.keys(provider.capabilities ?? {}).filter(k=>provider.capabilities[k])})); }
        });
        if (!emitted) {
          const raw = await provider.chatCompletions({...preparedInput.input, stream:false});
          const canonicalInput = typeof provider.toCanonical === 'function' ? provider.toCanonical(raw) : raw;
          const completion = this.normalizer.normalize(canonicalInput, {model, providerId:provider.id});
          const fallbackChunk = this.normalizer.normalize(completionToStreamChunk(completion), {model, providerId:provider.id});
          emitted = true;
          onChunk?.(maskCanonicalResponse(fallbackChunk, {agentId:input.agent ?? input.persona ?? 'code-guru',configuredModel:route.publicModel || '',capabilities:Object.keys(provider.capabilities ?? {}).filter(k=>provider.capabilities[k])}));
        }
        await this.lifecycle.complete({sessionId:input.sessionId ?? null,applicationId:input.applicationId ?? null,verified:false,status:'completed_unverified'});
        return {status:'completed_unverified',providerId:provider.id,model,route,verified:false};
      } catch (error) {
        lastError = error;
        if (emitted) throw error;
        if (index >= candidates.length - 1) break;
        await this.lifecycle.providerFailure({sessionId:input.sessionId ?? null,applicationId:input.applicationId ?? null,providerId:candidate.providerId,model:candidate.model,error,attempt:index+1,remainingCandidates:candidates.length-index-1});
      }
    }
    throw lastError ?? new Error('provider_route_failed');
  }
}
