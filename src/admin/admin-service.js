import { createApiKey, hashSecret, normalizeExpiry, normalizeLimits, normalizeRole, publicApplication, roleOf, APPLICATION_ROLES } from '../auth/application-auth.js';
import { id } from '../core/ids.js';

/**
 * Fields an API caller may patch on an application.
 *
 * The field used to be spread straight in (`{...list[i], ...patch}`), which meant a
 * caller could post `{"apiKeyHash": "<a hash they chose>"}` and give themselves a
 * token of their own choosing, or `{"apiKeyVault": ...}` and plant ciphertext for
 * the reveal endpoint to hand back. Nothing exploited it, but a write path with no
 * boundary is not a boundary — it is a habit. So the list is explicit, and an
 * unknown field is refused loudly rather than dropped quietly, because a client
 * that thinks it renamed something and got a 200 would believe a lie.
 */
export const PATCHABLE_APPLICATION_FIELDS = Object.freeze(['name', 'status', 'role', 'expiresAt', 'limits']);

const APPLICATION_STATUSES = Object.freeze(['active', 'revoked']);

function assertRole(value) {
  if (value === undefined || value === null || value === '') return 'user';
  const role = String(value).trim().toLowerCase();
  // A privilege field is never defaulted silently. If a caller says "ada", that is
  // not a request to create a user — it is a mistake worth failing on.
  if (!APPLICATION_ROLES.includes(role)) throw new Error(`application_role_invalid:${role}`);
  return role;
}

function assertStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  if (!APPLICATION_STATUSES.includes(status)) throw new Error(`application_status_invalid:${status}`);
  return status;
}

export class AdminService {
  constructor(store, { vault = null } = {}) { this.store = store; this.vault = vault; }

  /** The stored records, secrets and all. Stays inside this class. */
  async stored() { return this.store.read('applications', []); }

  /** The list anything outside this class may see. */
  async applications() { return (await this.stored()).map(publicApplication); }

  async application(appId) {
    const found = (await this.stored()).find(a => a.id === appId);
    if (!found) throw new Error('application_not_found');
    return publicApplication(found);
  }

  /**
   * What the operator needs to know about the token they are about to hand over.
   * The wording lives here, once, so the create and rotate routes cannot drift into
   * telling the operator two different things about the same token.
   */
  get tokenNotice() {
    return this.vault
      ? 'This token is stored encrypted, so the admin console can show it again later. It is never written to a log.'
      : 'Store this token now: without TOKEN_ENCRYPTION_KEY set, it cannot be shown again and the only recovery is to rotate it.';
  }

  async createApplication(input = {}) {
    const key = createApiKey();
    const list = await this.stored();
    const item = {
      id: id('app'),
      name: String(input.name ?? 'unnamed').slice(0, 120),
      status: 'active',
      role: assertRole(input.role),
      expiresAt: normalizeExpiry(input.expiresAt),
      limits: normalizeLimits(input.limits ?? { rateLimit: input.rateLimit, concurrency: input.concurrency }),
      apiKeyHash: hashSecret(key),
      apiKeyVault: this.vault ? this.vault.seal(key) : null,
      createdAt: new Date().toISOString(),
      capabilities: { tools: {} }
    };
    list.push(item);
    await this.store.write('applications', list);
    return { application: publicApplication(item), apiKey: key, tokenNotice: this.tokenNotice };
  }

  async updateApplication(appId, patch = {}) {
    const list = await this.stored();
    const index = list.findIndex(a => a.id === appId);
    if (index < 0) throw new Error('application_not_found');

    const refused = Object.keys(patch).filter(key => !PATCHABLE_APPLICATION_FIELDS.includes(key));
    if (refused.length) throw new Error(`application_patch_field_not_allowed:${refused.join(',')}`);

    const next = { ...list[index] };
    if ('name' in patch) next.name = String(patch.name ?? '').slice(0, 120) || next.name;
    if ('status' in patch) next.status = assertStatus(patch.status);
    if ('role' in patch) next.role = assertRole(patch.role);
    if ('expiresAt' in patch) next.expiresAt = normalizeExpiry(patch.expiresAt);
    if ('limits' in patch) next.limits = normalizeLimits(patch.limits);

    list[index] = next;
    await this.store.write('applications', list);
    return publicApplication(next);
  }

  /**
   * Give the operator back the token they handed out.
   *
   * This is the one place a stored token is decrypted. It is deliberately a
   * separate method with a separate route so that it can be audited on its own —
   * reading a customer's credential is a privileged act, not a side effect of
   * listing users.
   */
  async revealKey(appId) {
    const found = (await this.stored()).find(a => a.id === appId);
    if (!found) throw new Error('application_not_found');
    if (!this.vault) throw new Error('token_vault_not_configured');
    if (!found.apiKeyVault) throw new Error('token_not_recoverable');
    return { id: found.id, name: found.name, role: roleOf(found), apiKey: this.vault.open(found.apiKeyVault) };
  }

  async rotateKey(appId) {
    const list = await this.stored();
    const index = list.findIndex(a => a.id === appId);
    if (index < 0) throw new Error('application_not_found');
    const key = createApiKey();
    // Rotating is not a patch a client may send, so it writes the hash and the
    // sealed copy directly rather than going through updateApplication's allowlist.
    list[index] = {
      ...list[index],
      apiKeyHash: hashSecret(key),
      apiKeyVault: this.vault ? this.vault.seal(key) : null,
      rotatedAt: new Date().toISOString()
    };
    await this.store.write('applications', list);
    return { application: publicApplication(list[index]), apiKey: key, tokenNotice: this.tokenNotice };
  }
}

export { normalizeRole };
