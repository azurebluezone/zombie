import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export function hashSecret(secret) { return createHash('sha256').update(secret).digest('hex'); }
export function createApiKey() { return `zc_${randomBytes(24).toString('base64url')}`; }
export function safeEqual(a, b) { const x=Buffer.from(a); const y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
export function authenticateApiKey(rawKey, applications) {
  if (!rawKey) return null;
  const hash = hashSecret(rawKey);
  return applications.find(a => a.apiKeyHash === hash && a.status === 'active' && (!a.expiresAt || new Date(a.expiresAt) > new Date())) ?? null;
}
