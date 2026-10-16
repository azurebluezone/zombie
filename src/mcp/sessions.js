/**
 * Inbound MCP client sessions.
 *
 * The Streamable HTTP server hands out an `Mcp-Session-Id` on initialize but
 * kept no record of it, so nothing could answer "which client is connected,
 * what is its id, and what is it doing right now". This keeps one row per
 * session and refreshes `lastSeenAt` / `lastMethod` on every message.
 *
 * `active` is derived on read (idle window), never stored: a stored boolean
 * would go stale the moment a client disappeared.
 */
export class McpClientSessions {
  constructor(store, { collection = 'mcp-clients', idleMs = 120000 } = {}) {
    this.store = store;
    this.collection = collection;
    this.idleMs = idleMs;
  }

  async _read() {
    const rows = await this.store.read(this.collection, []);
    return Array.isArray(rows) ? rows : [];
  }

  async list() {
    const rows = await this._read();
    const now = Date.now();
    return rows
      .map(row => {
        const lastSeen = Date.parse(row.lastSeenAt ?? '');
        return {
          ...row,
          idleMs: Number.isFinite(lastSeen) ? now - lastSeen : null,
          active: Number.isFinite(lastSeen) ? now - lastSeen <= this.idleMs : false
        };
      })
      .sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));
  }

  /**
   * @param {object} msg
   * @param {string} msg.sessionId
   * @param {{name?:string,version?:string}|null} [msg.clientInfo]  from initialize params
   * @param {string|null} [msg.protocolVersion]
   * @param {string|null} [msg.applicationId]  authenticated MCP caller
   * @param {string|null} [msg.method]         JSON-RPC method just handled
   * @param {string|null} [msg.requestId]
   * @param {boolean} [msg.closed]
   */
  async touch({ sessionId, clientInfo = null, protocolVersion = null, applicationId = null, method = null, requestId = null, closed = false } = {}) {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return null;
    const rows = await this._read();
    const now = new Date().toISOString();
    const existing = rows.find(row => row.id === sid) ?? {
      id: sid,
      sessionId: sid,
      firstSeenAt: now,
      requestCount: 0,
      methods: []
    };
    const item = {
      ...existing,
      clientName: clientInfo?.name ? String(clientInfo.name).slice(0, 120) : existing.clientName ?? null,
      clientVersion: clientInfo?.version ? String(clientInfo.version).slice(0, 60) : existing.clientVersion ?? null,
      protocolVersion: protocolVersion ? String(protocolVersion) : existing.protocolVersion ?? null,
      applicationId: applicationId ?? existing.applicationId ?? null,
      lastMethod: method ?? existing.lastMethod ?? null,
      lastRequestId: requestId ?? existing.lastRequestId ?? null,
      lastSeenAt: now,
      requestCount: (existing.requestCount ?? 0) + 1,
      status: closed ? 'closed' : 'active',
      closedAt: closed ? now : existing.closedAt ?? null,
      methods: method ? [...new Set([...(existing.methods ?? []), method])].slice(0, 20) : (existing.methods ?? [])
    };
    const next = rows.filter(row => row.id !== sid);
    next.push(item);
    await this.store.write(this.collection, next);
    return item;
  }

  async close(sessionId) {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return null;
    return this.touch({ sessionId: sid, closed: true });
  }
}
