export function validateEvidence(item) {
  if (!item || typeof item !== 'object') throw new Error('evidence must be an object');
  if (!item.source || !item.status || !item.observedAt) throw new Error('evidence requires source, status and observedAt');
  return { source: String(item.source).slice(0, 200), status: String(item.status).slice(0, 40), confidence: item.confidence ?? 'unknown', observedAt: String(item.observedAt), summary: String(item.summary ?? '').slice(0, 2000) };
}
