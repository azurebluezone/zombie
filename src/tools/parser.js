import { extractToolCalls } from '../execution/tool-call.js';

export function parseCanonicalToolCalls(response) {
  return extractToolCalls(response).map(call => ({
    id: call.id,
    type: call.type,
    name: call.name,
    arguments: call.arguments
  }));
}

export function stripUnsupportedTools(input = {}, capabilities = {}) {
  if (capabilities.functionCalling !== true && Array.isArray(input.tools) && input.tools.length) {
    const next = {...input};
    delete next.tools;
    return {input:next, stripped:true, reason:'provider_function_calling_not_supported'};
  }
  return {input, stripped:false, reason:null};
}
