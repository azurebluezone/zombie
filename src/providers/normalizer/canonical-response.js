import { randomUUID } from 'node:crypto';

function safeUsage(usage) {
  return usage && typeof usage === 'object' ? structuredClone(usage) : undefined;
}

function safeToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.map((call, index) => ({
    id: String(call?.id ?? `call_${index + 1}`),
    type: 'function',
    function: {
      name: String(call?.function?.name ?? call?.name ?? '').slice(0, 200),
      arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? call?.arguments ?? {})
    },
    // Gemini 3.x signs every functionCall part and rejects the conversation when the
    // assistant turn is replayed without its signature. The value is provider-specific,
    // opaque and only ever echoed back to the provider that issued it.
    ...(typeof call?.thoughtSignature === 'string' && call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
  })).filter(call => call.function.name);
}

function safeDelta(delta = {}) {
  const result = {};
  if (delta.role != null) result.role = String(delta.role);
  if (delta.content != null) result.content = typeof delta.content === 'string' ? delta.content : JSON.stringify(delta.content);
  if (delta.refusal != null) result.refusal = String(delta.refusal);
  if (Array.isArray(delta.tool_calls)) {
    result.tool_calls = delta.tool_calls.map((call, index) => {
      const fn = call?.function ?? {};
      const functionDelta = {};
      if (fn.name != null) functionDelta.name = String(fn.name).slice(0, 200);
      // Streamed argument fragments must remain fragments; do not JSON-parse or re-serialize them.
      if (fn.arguments != null) functionDelta.arguments = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
      return { ...(call?.index != null ? {index: Number(call.index)} : {index}), ...(call?.id != null ? {id: String(call.id)} : {}), type: call?.type ?? 'function', function: functionDelta, ...(typeof call?.thoughtSignature === 'string' && call.thoughtSignature ? {thoughtSignature: call.thoughtSignature} : {}) };
    });
  }
  return result;
}

function safeMessage(message = {}) {
  const result = {
    role: String(message.role ?? 'assistant'),
    content: message.content == null ? null : (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
  };
  const calls = safeToolCalls(message);
  if (calls.length) result.tool_calls = calls;
  return result;
}

// Upstreams describe the same terminal state with different words. An
// OpenAI-compatible client validates finish_reason against a fixed enum, so the
// canonical layer translates instead of forwarding provider jargon. The
// tool-call correction is the important one: Gemini and Ollama native both
// return STOP next to a functionCall, and a client that trusts finish_reason
// would discard a valid tool call.
export function normalizeFinishReason(reason, hasToolCalls = false) {
  const raw = reason == null ? '' : String(reason).trim().toLowerCase();
  if (raw === 'length' || raw === 'max_tokens' || raw === 'max_output_tokens' || raw === 'max_completion_tokens') return 'length';
  if (raw === 'content_filter' || raw === 'safety' || raw === 'recitation' || raw === 'blocklist' || raw === 'prohibited_content' || raw === 'spii' || raw === 'blocked') return 'content_filter';
  if (raw === 'tool_calls' || raw === 'tool_call' || raw === 'function_call' || raw === 'tool_use') return 'tool_calls';
  if (raw === '') return hasToolCalls ? 'tool_calls' : null;
  if (hasToolCalls && ['stop', 'end_turn', 'stop_sequence', 'complete', 'completed', 'eos', 'done'].includes(raw)) return 'tool_calls';
  if (['stop', 'end_turn', 'stop_sequence', 'complete', 'completed', 'eos', 'done'].includes(raw)) return 'stop';
  // Unknown non-empty reason: keep the response usable and never claim a tool
  // call when the message has none.
  return hasToolCalls ? 'tool_calls' : 'stop';
}

export class CanonicalResponseNormalizer {
  normalize(raw, { model = '', providerId = '' } = {}) {
    if (!raw || typeof raw !== 'object') throw new Error('provider_response_invalid');
    if (Array.isArray(raw.choices)) return this.openai(raw, model, providerId);
    if (Array.isArray(raw.candidates)) return this.gemini(raw, model, providerId);
    if (Array.isArray(raw.content)) return this.anthropic(raw, model, providerId);
    if (typeof raw.output_text === 'string') return this.text(raw.output_text, model, providerId);
    if (typeof raw.text === 'string') return this.text(raw.text, model, providerId);
    throw new Error('provider_response_unsupported_format');
  }
  base(model, providerId) { return { id:`normalized_${randomUUID()}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, provider:providerId }; }
  openai(raw, model, providerId) {
    const streaming = raw.choices.some(choice => choice && Object.hasOwn(choice, 'delta') && !Object.hasOwn(choice, 'message'));
    const choices = raw.choices.map((choice, index) => {
      const payload = streaming ? safeDelta(choice?.delta ?? {}) : safeMessage(choice?.message ?? {});
      const hasToolCalls = Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0;
      return {
        index: Number.isInteger(choice?.index) ? choice.index : index,
        ...(streaming ? {delta: payload} : {message: payload}),
        finish_reason: normalizeFinishReason(choice?.finish_reason, hasToolCalls)
      };
    });
    if (!choices.length) throw new Error('provider_response_empty_choices');
    const base = this.base(model || raw.model, providerId);
    return {
      ...base,
      ...(raw.id ? {id: String(raw.id)} : {}),
      object: streaming ? 'chat.completion.chunk' : (raw.object ?? 'chat.completion'),
      ...(Number.isFinite(raw.created) ? {created: raw.created} : {}),
      choices,
      ...(raw.usage ? {usage:safeUsage(raw.usage)} : {})
    };
  }
  gemini(raw, model, providerId) {
    const parts=raw.candidates.flatMap(c=>c?.content?.parts??[]);
    const text=parts.map(p=>p?.text).filter(Boolean).join('');
    const toolCalls=parts.filter(p=>p?.functionCall).map((p,i)=>({id:String(p.functionCall.id??`call_${i+1}`),type:'function',function:{name:String(p.functionCall.name??'').slice(0,200),arguments:JSON.stringify(p.functionCall.args??{})},...(p.thoughtSignature?{thoughtSignature:String(p.thoughtSignature)}:{})})).filter(x=>x.function.name);
    const message={role:'assistant',content:text||null}; if(toolCalls.length) message.tool_calls=toolCalls;
    return {...this.base(model, providerId), choices:[{index:0,message,finish_reason:normalizeFinishReason(raw.candidates[0]?.finishReason, toolCalls.length>0)}]};
  }
  anthropic(raw, model, providerId) {
    const blocks=Array.isArray(raw.content)?raw.content:[];
    const text=blocks.map(x=>x?.text).filter(Boolean).join('');
    const toolCalls=blocks.filter(x=>x?.type==='tool_use'&&x?.name).map((x,i)=>({id:String(x.id??`call_${i+1}`),type:'function',function:{name:String(x.name).slice(0,200),arguments:JSON.stringify(x.input??{})}}));
    const message={role:'assistant',content:text||null}; if(toolCalls.length) message.tool_calls=toolCalls;
    return {...this.base(model || raw.model, providerId), choices:[{index:0,message,finish_reason:normalizeFinishReason(raw.stop_reason, toolCalls.length>0)}], usage:safeUsage(raw.usage)};
  }
  text(text, model, providerId) { return {...this.base(model, providerId), choices:[{index:0,message:{role:'assistant',content:String(text)},finish_reason:null}]}; }
}
