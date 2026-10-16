function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

export function parseToolArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { throw new Error('tool_call_arguments_invalid_json'); }
}

function parseSanitizedJsonToolCalls(message) {
  if (typeof message?.content !== 'string') return [];
  let text = message.content.trim();
  // Accept a single fenced JSON object, but never scrape JSON out of arbitrary prose.
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  let candidates = [];
  if (Array.isArray(parsed?.tool_calls) && Object.keys(parsed).every(k => ['tool_calls','type','action'].includes(k))) {
    if ((parsed.type && !['tool_calls','function_calls'].includes(parsed.type)) || (parsed.action != null && parsed.action !== 'tool_call')) return [];
    candidates = parsed.tool_calls;
  } else if (typeof parsed?.tool === 'string' && parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments) && Object.keys(parsed).every(k => ['tool','arguments','type','action','id'].includes(k))) {
    if ((parsed.type && !['tool_call','function_call'].includes(parsed.type)) || (parsed.action != null && parsed.action !== 'tool_call')) return [];
    candidates = [{name:parsed.tool,arguments:parsed.arguments,id:parsed.id}];
  } else if (parsed?.type === 'function' && typeof parsed?.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object' && Object.keys(parsed).every(k => ['type','name','arguments','id'].includes(k))) {
    candidates = [parsed];
  } else return [];
  return candidates.slice(0,8).map((call,index)=>({
    id:String(call?.id ?? `json_call_${index+1}`),
    type:'function',
    name:String(call?.function?.name ?? call?.name ?? '').trim(),
    arguments:parseToolArguments(call?.function?.arguments ?? call?.arguments ?? {})
  })).filter(call=>call.name && /^[a-zA-Z0-9_.:-]{1,160}$/.test(call.name));
}

export function extractToolCalls(response) {
  const message = response?.choices?.[0]?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const normalized = calls.map((call, index) => ({
    id: String(call.id ?? `call_${index + 1}`),
    type: String(call.type ?? 'function'),
    name: String(call.function?.name ?? call.name ?? '').trim(),
    arguments: parseToolArguments(call.function?.arguments ?? call.arguments ?? {}),
  })).filter(call => call.name);
  // Fallback for small models that emit strict JSON rather than native tool_calls.
  // Actual execution is still bound to the server-side registry and allowlist.
  return normalized.length ? normalized : parseSanitizedJsonToolCalls(message);
}

export function toolCallSignature(call) {
  return `${call.name}:${stable(call.arguments ?? {})}`;
}

export function createToolResultMessage(call, result) {
  let content;
  try { content = JSON.stringify(result); } catch { content = JSON.stringify({error:'tool_result_not_serializable'}); }
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name,
    content: content ?? 'null',
  };
}

export function createToolErrorMessage(call, error) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name,
    content: JSON.stringify({error: String(error?.message ?? error)}),
  };
}
