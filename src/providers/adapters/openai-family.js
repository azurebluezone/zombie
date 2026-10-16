import { requestJson, requestStream, authHeaders, resolveTimeoutMs } from './base.js';
import { openAiChatPayload, stripRuntimeFields } from './request-shape.js';

export class OpenAIFamilyProvider {
  constructor({ id, name, baseUrl, apiKey = '', defaultModel = '', capabilities = [], networkPolicy = {}, timeoutMs = undefined }) {
    this.id = id; this.name = name ?? id; this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.apiKey = apiKey; this.defaultModel = defaultModel; this.networkPolicy = networkPolicy; this.timeoutMs = timeoutMs;
    this.capabilities = { streaming: true, functionCalling: true, chatCompletions: true, models: true, ...Object.fromEntries(capabilities.map(x => [x, true])) };
  }
  headers() { return authHeaders(this.apiKey); }
  async listModels() { return requestJson(`${this.baseUrl}/models`, 'GET', undefined, this.headers(), resolveTimeoutMs(undefined, this.timeoutMs), this.networkPolicy); }
  payload(input = {}, model) { return openAiChatPayload(input, model); }
  async chatCompletions(input = {}) { const model = input.model ?? this.defaultModel; if (!model) throw new Error('provider_model_required'); return requestJson(`${this.baseUrl}/chat/completions`, 'POST', this.payload(input, model), this.headers(), resolveTimeoutMs(input.timeoutMs, this.timeoutMs), this.networkPolicy); }
  toCanonical(raw) { return raw; }
  streamChunk(raw) { return raw; }
  async streamChat(input = {}, onChunk) { const model = input.model ?? this.defaultModel; if (!model) throw new Error('provider_model_required'); return requestStream(`${this.baseUrl}/chat/completions`, this.payload({...input, stream:true}, model), this.headers(), {timeoutMs:resolveTimeoutMs(input.timeoutMs, this.timeoutMs), onEvent:onChunk, networkPolicy:this.networkPolicy}); }
}
