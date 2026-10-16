import { createHash } from 'node:crypto';
import { providerErrorDetail } from '../providers/adapters/request-shape.js';

function digest(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

export function assertSystemPrompt(messages = []) {
  const system = Array.isArray(messages) ? messages.find(m => m?.role === 'system') : null;
  if (!system || typeof system.content !== 'string' || !system.content.trim()) {
    throw new Error('system_prompt_required');
  }
  return { present: true, digest: digest(system.content), bytes: Buffer.byteLength(system.content) };
}

export class ExecutionLifecycle {
  constructor({sessions = null, evidenceGate = null, normalizer = null, logger = null, requireSystemPrompt = false} = {}) {
    this.sessions = sessions;
    this.evidenceGate = evidenceGate;
    this.normalizer = normalizer;
    this.logger = logger;
    this.requireSystemPrompt = requireSystemPrompt;
  }

  async begin({sessionId = null, applicationId = null, metadata = {}, messages = []} = {}) {
    const prompt = this.requireSystemPrompt ? assertSystemPrompt(messages) : (Array.isArray(messages) && messages.some(m => m?.role === 'system') ? assertSystemPrompt(messages) : {present:false,digest:null,bytes:0});
    if (sessionId && this.sessions) {
      await this.sessions.updateMetadata(sessionId, applicationId, {
        executionState: 'started',
        systemPromptDigest: prompt.digest,
        systemPromptBytes: String(prompt.bytes),
        ...metadata,
      });
    }
    await this.logger?.info?.('execution.lifecycle.started', {sessionId, applicationId, systemPrompt: prompt});
    return prompt;
  }

  async providerFailure({sessionId = null, applicationId = null, requestId = null, providerId, model, error, attempt, remainingCandidates = 0} = {}) {
    const summary = String(error?.message ?? error ?? 'provider_failed').slice(0, 500);
    if (sessionId && this.sessions) await this.sessions.updateMetadata(sessionId, applicationId, {
      executionState: 'fallback',
      lastProvider: providerId,
      lastModel: model,
      fallbackAttempt: String(attempt),
      fallbackRemaining: String(remainingCandidates),
    });
    // Same correlation fields and upstream detail as provider.chat_candidate_failed,
    // otherwise a fallback cannot be tied to its caller and the provider's own
    // rejection message is lost.
    await this.logger?.warn?.('execution.lifecycle.provider_fallback', {sessionId, applicationId, requestId, providerId, model, attempt, remainingCandidates, error: summary, ...providerErrorDetail(error)});
  }

  async providerObserved({sessionId = null, applicationId = null, providerId, model, canonical, evidence} = {}) {
    if (!canonical || !Array.isArray(canonical.choices)) throw new Error('canonical_response_required');
    const record = {source:`provider:${providerId}`, status:'observed', confidence:'direct-response', observedAt:new Date().toISOString(), summary:'Canonical provider response received; independent verification is still required'};
    if (this.evidenceGate) await this.evidenceGate.record({contextId:sessionId, ...record});
    if (sessionId && this.sessions) await this.sessions.updateMetadata(sessionId, applicationId, {
      executionState: 'observed',
      lastProvider: providerId,
      lastModel: model,
      verificationState: 'unverified',
      lastResponseId: canonical.id,
    });
    return evidence ?? record;
  }

  async toolObserved({sessionId = null, applicationId = null, toolId, status = 'observed', summary = 'Tool execution returned a result'} = {}) {
    const record = {source:`tool:${toolId}`, status, confidence:'direct-execution-return', observedAt:new Date().toISOString(), summary};
    if (this.evidenceGate) await this.evidenceGate.record({contextId:sessionId, ...record});
    return record;
  }

  async complete({sessionId = null, applicationId = null, verified = false, status = 'completed'} = {}) {
    if (sessionId && this.sessions) await this.sessions.updateMetadata(sessionId, applicationId, {
      executionState: status,
      verificationState: verified ? 'verified' : 'unverified',
    });
    await this.logger?.info?.('execution.lifecycle.completed', {sessionId, applicationId, status, verified});
  }
}
