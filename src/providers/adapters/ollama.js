import { requestJson, requestStream, requestLineStream, authHeaders, resolveTimeoutMs } from './base.js';
import { stripRuntimeFields } from './request-shape.js';
import { OpenAIFamilyProvider } from './openai-family.js';

export class OllamaProvider {
  constructor({ id='ollama-selfhosted', baseUrl, apiKey='', defaultModel='', mode='openai-compatible', networkPolicy = {}, timeoutMs = undefined } = {}) {
    this.id=id; this.name='Ollama'; this.mode=mode; this.defaultModel=defaultModel; this.apiKey=apiKey; this.baseUrl=String(baseUrl ?? '').replace(/\/$/,''); this.networkPolicy=networkPolicy; this.timeoutMs=timeoutMs;
    this.capabilities={streaming:true,functionCalling:true,chatCompletions:true,models:true};
    if (mode === 'openai-compatible') this.compat = new OpenAIFamilyProvider({id,name:this.name,baseUrl:this.baseUrl,apiKey,defaultModel,networkPolicy,timeoutMs});
  }
  async listModels() { if (this.mode === 'native') return requestJson(`${this.baseUrl}/api/tags`, 'GET', undefined, authHeaders(this.apiKey), resolveTimeoutMs(undefined, this.timeoutMs), this.networkPolicy); return this.compat.listModels(); }
  async chatCompletions(input={}) { if (this.mode === 'native') return requestJson(`${this.baseUrl}/api/chat`, 'POST', {...stripRuntimeFields(input), model:input.model ?? this.defaultModel, stream:false}, authHeaders(this.apiKey), resolveTimeoutMs(input.timeoutMs, this.timeoutMs), this.networkPolicy); return this.compat.chatCompletions(input); }
  toCanonical(raw) { if (this.mode !== 'native') return raw; return {id:raw.id ?? `ollama_${Date.now()}`, object:'chat.completion', model:raw.model ?? this.defaultModel, choices:[{index:0,message:raw.message ?? {role:'assistant',content:''},finish_reason:raw.done_reason ?? null}], usage: raw.prompt_eval_count || raw.eval_count ? {prompt_tokens:raw.prompt_eval_count ?? 0, completion_tokens:raw.eval_count ?? 0, total_tokens:(raw.prompt_eval_count ?? 0)+(raw.eval_count ?? 0)} : undefined}; }
  streamChunk(raw) {
    if (this.mode !== 'native') return raw;
    const toolCalls = (raw.message?.tool_calls ?? []).map((call, index) => ({
      index,
      id: call.id ?? `call_${index + 1}`,
      type: 'function',
      function: {name:call.function?.name ?? call.name ?? '', arguments:typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})}
    }));
    return {id:raw.id ?? `ollama_${Date.now()}`,object:'chat.completion.chunk',model:raw.model ?? this.defaultModel,choices:[{index:0,delta:{role:raw.message?.role,content:raw.message?.content ?? '',...(toolCalls.length ? {tool_calls:toolCalls}:{})},finish_reason:raw.done ? (raw.done_reason ?? 'stop') : null}]};
  }
  async streamChat(input={}, onChunk) { if (this.mode === 'native') return requestLineStream(`${this.baseUrl}/api/chat`, {...input, model:input.model ?? this.defaultModel, stream:true}, authHeaders(this.apiKey), {onEvent:onChunk, networkPolicy:this.networkPolicy}); return this.compat.streamChat(input,onChunk); }
}
