import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashSecret(secret) { return createHash('sha256').update(secret).digest('hex'); }
export function createApiKey() { return `zc_${randomBytes(24).toString('base64url')}`; }
export function safeEqual(a, b) { const x=Buffer.from(a); const y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }

export function authenticateApiKey(rawKey, applications) {
  if (!rawKey) return null;
  const hash = hashSecret(rawKey);
  return applications.find(a => a.apiKeyHash === hash && a.status === 'active' && (!a.expiresAt || new Date(a.expiresAt) > new Date())) ?? null;
}

/**
 * `admin` or `user`, and nothing else.
 *
 * There is no third role and no "superuser" ladder to get wrong. The global admin
 * token in the environment is still the admin credential — this role exists so an
 * operator can hand out a *user* token without also handing out the admin API, and
 * so a token they mark as admin can reach the admin API without the global secret
 * being copied onto a machine.
 *
 * An application with no role is a `user`. That is deliberate and it is what keeps
 * the thirteen applications created before roles existed behaving exactly as they
 * did: they could not reach the admin API before, and they still cannot.
 */
export const APPLICATION_ROLES = Object.freeze(['admin', 'user']);

export function normalizeRole(value) {
  return String(value ?? '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
}

export function roleOf(application) {
  return normalizeRole(application?.role);
}

/** Does this raw key belong to an application the operator marked admin? */
export function isAdminApplication(rawKey, applications) {
  const application = authenticateApiKey(rawKey, Array.isArray(applications) ? applications : []);
  return application ? roleOf(application) === 'admin' : false;
}

/**
 * A user's ceiling, or `null` to inherit the runtime default.
 *
 * `null` and `0` are different things and the distinction is kept: `null` means
 * "whatever APP_RATE_LIMIT says", whereas a number means "this one, for this user".
 * Storing 0 as a stand-in for "unset" would make the ceiling a moving target the
 * day someone changes the default.
 */
export const LIMIT_CEILINGS = Object.freeze({ rateLimit: 100000, concurrency: 1000 });

export function normalizeLimits(input) {
  const source = input && typeof input === 'object' ? input : {};
  const read = (key) => {
    const raw = source[key];
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return null;
    return Math.min(value, LIMIT_CEILINGS[key]);
  };
  return { rateLimit: read('rateLimit'), concurrency: read('concurrency') };
}

/**
 * The application as anything outside the admin service may see it.
 *
 * `apiKeyHash` is not a token and `apiKeyVault` is ciphertext, but neither belongs
 * in a list response, a log line, or a UI table, so they are removed once here
 * rather than remembered at every call site. `tokenRecoverable` replaces them with
 * the one fact a caller legitimately needs: whether the admin can show this token
 * again.
 */
/**
 * A user's end date, or `null` for "no end date".
 *
 * Validated rather than stored as given, because an unparseable date does not fail
 * loudly on its own: `new Date('whenever') > new Date()` is `false`, so
 * `authenticateApiKey` rejects that token forever. A typo would mean a user whose token
 * is dead on arrival while nothing in the store looks wrong. Refusing the write is the
 * only honest outcome.
 */
export function normalizeExpiry(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`application_expiresAt_invalid:${String(value).slice(0, 40)}`);
  return new Date(ms).toISOString();
}

export function publicApplication(application) {
  if (!application || typeof application !== 'object') return application;
  const { apiKeyHash, apiKeyVault, ...visible } = application;
  return { ...visible, role: roleOf(application), tokenRecoverable: Boolean(apiKeyVault) };
}
