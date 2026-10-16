/** Convert a completed canonical response into one valid OpenAI-compatible final stream chunk. */
export function completionToStreamChunk(response) {
  const choice = response?.choices?.[0];
  if (!choice?.message) throw new Error('provider_response_missing_message');
  const message = choice.message;
  const delta = {role: message.role ?? 'assistant'};
  if (message.content != null) delta.content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    delta.tool_calls = message.tool_calls.map((call, index) => ({
      index,
      id: String(call.id ?? `call_${index + 1}`),
      type: 'function',
      function: {
        ...(call.function?.name ? {name: String(call.function.name)} : {}),
        arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})
      }
    }));
  }
  return {
    id: response.id ?? `fallback_stream_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: response.created ?? Math.floor(Date.now()/1000),
    model: response.model ?? '',
    choices: [{index: Number.isInteger(choice.index) ? choice.index : 0, delta, finish_reason: choice.finish_reason ?? 'stop'}]
  };
}
