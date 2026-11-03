import { requestJson, requestStream, requestLineStream, authHeaders, resolveTimeoutMs } from './base.js';
import { stripRuntimeFields } from './request-shape.js';
import { OpenAIFamilyProvider } from './openai-family.js';

// Ollama's native /api/chat is not the OpenAI message dialect: tool arguments
// are objects and a tool result is matched to its call by `tool_name`, not by
// `tool_call_id`. The official tool-calling examples send
// {"role":"tool","tool_name":"get_weather","content":"..."}; forwarding the
// OpenAI id or dropping the name makes the follow-up turn ambiguous.
function nativeArguments(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

export function toNativeMessages(messages = []) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    const out = { role: message.role };
    if (message.content !== undefined) out.content = message.content;
    if (Array.isArray(message.images)) out.images = message.images;
    const toolName = String(message.tool_name ?? message.name ?? '').trim();
    if (message.role === 'tool' && toolName) out.tool_name = toolName;
    if (Array.isArray(message.tool_calls)) {
      out.tool_calls = message.tool_calls.map((call, index) => ({
        type: 'function',
        function: {
          index: Number.isInteger(call?.function?.index) ? call.function.index : index,
          name: call?.function?.name ?? call?.name ?? '',
          arguments: nativeArguments(call?.function?.arguments ?? call?.arguments)
        }
      })).filter(call => call.function.name);
    }
    return out;
  });
}

function nativePayload(input = {}, { stream = false } = {}) {
  const { messages, ...rest } = stripRuntimeFields(input);
  return {
    ...rest,
    ...(Array.isArray(messages) ? { messages: toNativeMessages(messages) } : {}),
    stream
  };
}

export class OllamaProvider {
  constructor({ id='ollama-selfhosted', baseUrl, apiKey='', defaultModel='', mode='openai-compatible', networkPolicy = {}, timeoutMs = undefined } = {}) {
    this.id=id; this.name='Ollama'; this.mode=mode; this.defaultModel=defaultModel; this.apiKey=apiKey; this.baseUrl=String(baseUrl ?? '').replace(/\/$/,''); this.networkPolicy=networkPolicy; this.timeoutMs=timeoutMs;
    this.capabilities={streaming:true,functionCalling:true,chatCompletions:true,models:true};
    if (mode === 'openai-compatible') this.compat = new OpenAIFamilyProvider({id,name:this.name,baseUrl:this.baseUrl,apiKey,defaultModel,networkPolicy,timeoutMs});
  }
  async listModels() { if (this.mode === 'native') return requestJson(`${this.baseUrl}/api/tags`, 'GET', undefined, authHeaders(this.apiKey), resolveTimeoutMs(undefined, this.timeoutMs), this.networkPolicy); return this.compat.listModels(); }
  async chatCompletions(input={}) { if (this.mode === 'native') return requestJson(`${this.baseUrl}/api/chat`, 'POST', {...nativePayload(input), model:input.model ?? this.defaultModel, stream:false}, authHeaders(this.apiKey), resolveTimeoutMs(input.timeoutMs, this.timeoutMs), this.networkPolicy); return this.compat.chatCompletions(input); }
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
  async streamChat(input={}, onChunk) { if (this.mode === 'native') return requestLineStream(`${this.baseUrl}/api/chat`, {...nativePayload(input,{stream:true}), model:input.model ?? this.defaultModel}, authHeaders(this.apiKey), {onEvent:onChunk, networkPolicy:this.networkPolicy}); return this.compat.streamChat(input,onChunk); }
}
