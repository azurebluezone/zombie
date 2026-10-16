export function extractModelIds(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('provider_models_invalid');
  const data = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
  const ids = data.map(item => typeof item === 'string' ? item : item?.id ?? item?.name).filter(Boolean).map(String);
  if (!ids.length) throw new Error('provider_models_empty');
  return [...new Set(ids)];
}

// Model IDs that are served by the same catalog endpoint but cannot answer a
// chat-completions request (speech, transcription, embeddings, classifiers).
// Used only to avoid picking an unusable default; it never blocks a model from
// being selected explicitly.
const NON_CHAT_MODEL_PATTERN = /(whisper|tts|text-to-speech|speech|embedding|embed-|guard|moderation|rerank|re-rank|image-generation|imagen|dall-|stable-diffusion|audio)/i;

/**
 * Chooses a stable, usable default model.
 *   1. keep the current default when it still exists upstream (stability across restarts)
 *   2. otherwise take the first model that looks chat-capable
 *   3. otherwise fall back to the first reported model
 */
export function pickDefaultModel(models = [], previous = '') {
  const list = (Array.isArray(models) ? models : []).map(String).filter(Boolean);
  if (!list.length) return '';
  const previousValue = String(previous ?? '');
  if (previousValue && list.includes(previousValue)) return previousValue;
  const chatCapable = list.filter(id => !NON_CHAT_MODEL_PATTERN.test(id));
  return chatCapable[0] ?? list[0];
}
