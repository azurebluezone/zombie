// Request shaping for the provider boundary.
//
// The runtime request object carries orchestration state (goal, toolIds,
// consent, project root, session metadata...) that must never reach an upstream
// API: it leaks internal context and strict OpenAI-compatible upstreams reject
// unknown parameters with HTTP 400 (this is what made Groq answer 400 while a
// hand-written curl with the same key and model answered 200).

// Fields an upstream chat-completions endpoint is allowed to see. This mirrors
// the widely-implemented OpenAI chat schema; anything not listed is runtime-only.
const OPENAI_CHAT_FIELDS = Object.freeze([
  'messages', 'temperature', 'top_p', 'n', 'stream', 'stream_options', 'stop',
  'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'user', 'seed', 'response_format',
  'tools', 'tool_choice', 'parallel_tool_calls'
]);

// Runtime orchestration fields, removed for adapters that forward a request
// shape of their own (for example the Ollama native /api/chat surface).
export const RUNTIME_INTERNAL_FIELDS = Object.freeze([
  'provider', 'goal', 'expectedOutcome', 'toolIds', 'allowedToolIds', 'consent',
  'autoToolLoop', 'toolBindings', 'allowJsonToolFallback', 'taskPolicy', 'meta',
  'projectRoot', 'workingDirectory', 'sessionId', 'createSession', 'userId',
  'sessionSource', 'clientId', 'editor', 'editorVersion', 'clientVersion',
  'osPlatform', 'deviceInfo', 'applicationId', 'requestId', 'executionContext',
  'toolCatalog', 'evidence', 'compiledContext', 'systemPrompt'
]);

/** Builds the exact body sent to an OpenAI-compatible chat-completions endpoint. */
export function openAiChatPayload(input = {}, model) {
  const payload = {};
  for (const field of OPENAI_CHAT_FIELDS) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  payload.model = model;
  return payload;
}

/** Copies an input object without the runtime-only orchestration fields. */
export function stripRuntimeFields(input = {}) {
  const copy = { ...input };
  for (const field of RUNTIME_INTERNAL_FIELDS) delete copy[field];
  return copy;
}

/**
 * Extracts a safe, loggable reason from a provider error. Joins the upstream
 * HTTP status with the provider's own message so a rejected request is
 * diagnosable instead of surfacing only "provider_http_error".
 *
 * The field is called `upstreamReason` and not `providerMessage` because the
 * logger omits any key containing "message" (see src/core/logger.js), which used
 * to hide the upstream text from the very log line that was meant to carry it.
 */
export function providerErrorDetail(error, { maxLength = 300 } = {}) {
  const status = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : null;
  const body = error?.providerBody;
  let message = '';
  if (body && typeof body === 'object') {
    message = String(body?.error?.message ?? body?.message ?? body?.error ?? '');
  } else if (typeof body === 'string') {
    message = body;
  }
  message = message.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return { statusCode: status, upstreamReason: message || null };
}
