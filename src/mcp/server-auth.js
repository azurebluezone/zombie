/**
 * Inbound MCP authentication policy.
 *
 * The runtime is normally loopback-only, so an operator at the machine does not
 * want to hand every MCP client an application key before it can call a tool.
 * This module owns two things:
 *
 *   1. The effective policy. The env var `MCP_SERVER_AUTH` sets the default and an
 *      admin override (persisted in the `mcp-settings` collection) wins over it,
 *      so the admin panel can flip authentication off without an edit to .env or a
 *      restart. The existing auth flow is untouched while the policy stays
 *      `required`.
 *
 *   2. The auto-provisioned application that signs in unauthenticated inbound MCP
 *      traffic when authentication is disabled. Sessions, tool permissions and
 *      audit entries are all keyed by application id, so the runtime still needs a
 *      real owner even when nobody presented a key. The key is generated, hashed
 *      and stored, and the raw value is discarded on purpose: with authentication
 *      disabled no caller needs it, so there is nothing to leak.
 */
import { createApiKey, hashSecret } from '../auth/application-auth.js';
import { id } from '../core/ids.js';

const SETTINGS_ID = 'mcp-server-auth';
const AUTO_APP_NAME = 'mcp-auto-provisioned';
// The name this application was created with by an earlier release. It is renamed
// in place on read so an existing deployment stops showing the old wording without
// losing the application id that sessions and audit entries already point at.
const LEGACY_AUTO_APP_NAMES = ['mcp-local-auto'];

export class McpServerAuth {
  constructor(store, { requireAuth = true, collection = 'mcp-settings' } = {}) {
    this.store = store;
    this.collection = collection;
    this.envRequireAuth = requireAuth !== false;
    this._autoAppInFlight = null;
  }

  async _settings() {
    const rows = await this.store.read(this.collection, []);
    if (!Array.isArray(rows)) return null;
    return rows.find(row => row.id === SETTINGS_ID) ?? null;
  }

  /**
   * Effective policy. An explicit admin override wins over the env default; the
   * `source` field says which one is in force so the console can show it honestly.
   */
  async policy() {
    const row = await this._settings();
    const override = typeof row?.requireAuth === 'boolean' ? row.requireAuth : null;
    return {
      requireAuth: override ?? this.envRequireAuth,
      source: override === null ? 'env' : 'admin',
      envRequireAuth: this.envRequireAuth,
      updatedAt: row?.updatedAt ?? null
    };
  }

  async setRequireAuth(requireAuth) {
    if (typeof requireAuth !== 'boolean') throw new Error('requireAuth_must_be_boolean');
    const rows = await this.store.read(this.collection, []);
    const list = Array.isArray(rows) ? rows : [];
    const existing = list.find(row => row.id === SETTINGS_ID) ?? null;
    const now = new Date().toISOString();
    const item = { id: SETTINGS_ID, requireAuth, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.store.write(this.collection, [...list.filter(row => row.id !== SETTINGS_ID), item]);
    return this.policy();
  }

  /** Drop the admin override so the env default applies again. */
  async clearOverride() {
    const rows = await this.store.read(this.collection, []);
    const list = Array.isArray(rows) ? rows : [];
    if (list.some(row => row.id === SETTINGS_ID)) {
      await this.store.write(this.collection, list.filter(row => row.id !== SETTINGS_ID));
    }
    return this.policy();
  }

  /**
   * The application that owns unauthenticated inbound MCP traffic. Created once,
   * then reused. The raw key is never stored or returned: it exists only long
   * enough to be hashed, because nothing authenticates with it.
   */
  async autoProvisionedApplication() {
    if (this._autoAppInFlight) return this._autoAppInFlight;
    this._autoAppInFlight = (async () => {
      const apps = await this.store.read('applications', []);
      const list = Array.isArray(apps) ? apps : [];
      const existing = list.find(app => app.managedBy === 'mcp-server' && app.autoProvisioned === true);
      if (existing) {
        if (LEGACY_AUTO_APP_NAMES.includes(existing.name)) {
          const renamed = { ...existing, name: AUTO_APP_NAME };
          await this.store.write('applications', list.map(app => (app.id === existing.id ? renamed : app)));
          return renamed;
        }
        return existing;
      }
      const app = {
        id: id('app'),
        name: AUTO_APP_NAME,
        status: 'active',
        expiresAt: null,
        apiKeyHash: hashSecret(createApiKey()),
        createdAt: new Date().toISOString(),
        capabilities: { tools: {} },
        autoProvisioned: true,
        managedBy: 'mcp-server',
        note: 'Auto-provisioned owner for unauthenticated inbound MCP when MCP_SERVER_AUTH=disabled.'
      };
      await this.store.write('applications', [...list, app]);
      return app;
    })().finally(() => { this._autoAppInFlight = null; });
    return this._autoAppInFlight;
  }
}
