const ALLOWED = new Set(['sessionSource','clientId','editor','editorVersion','clientVersion','osPlatform','deviceInfo','executionState','systemPromptDigest','systemPromptBytes','lastProvider','lastModel','fallbackAttempt','fallbackRemaining','verificationState','lastResponseId']);
const MAX = 256;

export function sanitizeSessionMetadata(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) continue;
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    out[key] = text.slice(0, MAX);
  }
  return out;
}

export const SESSION_METADATA_FIELDS = [...ALLOWED];
