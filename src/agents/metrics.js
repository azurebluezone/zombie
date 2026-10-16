/**
 * Per-agent run counters.
 *
 * Nothing in the runtime recorded "how often did this agent succeed or fail":
 * evidence items carry no agentId and the request log only carries an
 * operation string. This is the smallest truthful source for the admin
 * console's per-agent status view.
 *
 * Deliberately dumb: one row per agent, monotonic counters, a rolling window of
 * the most recent runs. No aggregation on read, no inference about why a run
 * failed (the outcome string is whatever the caller actually observed).
 */
export class AgentMetrics {
  constructor(store, { collection = 'agentMetrics', maxRecent = 50 } = {}) {
    this.store = store;
    this.collection = collection;
    this.maxRecent = maxRecent;
  }

  async list() {
    const rows = await this.store.read(this.collection, []);
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * @param {object} run
   * @param {string} run.agentId  agent/persona id that actually ran
   * @param {'success'|'failure'|'incomplete'} [run.outcome]
   * @param {number|null} [run.latencyMs]
   * @param {string|null} [run.model]       real upstream model, admin surface only
   * @param {string|null} [run.providerId]  real provider id, admin surface only
   * @param {string|null} [run.path]        'chat' | 'tool-loop' | 'stream' | 'execution'
   * @param {string|null} [run.requestId]
   */
  async record({ agentId, outcome = 'success', latencyMs = null, model = null, providerId = null, path = null, requestId = null } = {}) {
    const id = String(agentId ?? '').trim();
    if (!id) return null;
    const rows = await this.list();
    const now = new Date().toISOString();
    const entry = rows.find(row => row.agentId === id) ?? {
      id,
      agentId: id,
      runs: 0,
      success: 0,
      failure: 0,
      incomplete: 0,
      totalLatencyMs: 0,
      firstSeenAt: now,
      recent: []
    };
    const bucket = outcome === 'success' ? 'success' : (outcome === 'incomplete' ? 'incomplete' : 'failure');
    entry.runs += 1;
    entry[bucket] += 1;
    if (Number.isFinite(latencyMs)) {
      entry.totalLatencyMs += latencyMs;
      entry.lastLatencyMs = latencyMs;
    }
    entry.lastOutcome = outcome;
    entry.lastAt = now;
    if (model) entry.lastModel = String(model);
    if (providerId) entry.lastProviderId = String(providerId);
    entry.recent = [...(entry.recent ?? []), {
      at: now,
      outcome,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      path: path ?? null,
      requestId: requestId ?? null
    }].slice(-this.maxRecent);
    const next = rows.filter(row => row.agentId !== id);
    next.push(entry);
    await this.store.write(this.collection, next);
    return entry;
  }
}
