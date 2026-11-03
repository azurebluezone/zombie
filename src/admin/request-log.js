// Metadata-only request log for real API traffic.
//
// The operator needs to answer "what hit the runtime, did it work, how slow was
// it" after a restart. Copying prompts or credentials into SQLite would turn a
// diagnostic tool into a data leak, so this stores routing/status metadata only.
// Recording can be switched off at runtime; old rows stay readable, because
// "stop recording" must not mean "delete what already happened".

const SETTINGS_ID = 'request-recording';
const DEFAULT_MAX_ROWS = 5000;

function integerInRange(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

export class RequestLog {
  constructor({ store, maxRows = DEFAULT_MAX_ROWS, now = () => new Date(), random = Math.random } = {}) {
    if (!store) throw new Error('request_log_store_required');
    this.store = store;
    this.maxRows = integerInRange(maxRows, DEFAULT_MAX_ROWS, 1, 100000);
    this.now = now;
    this.random = random;
    this.recording = true;
    this.updatedAt = null;
  }

  // The flag lives in SQLite so it survives a restart. It is cached in memory so
  // the response path does not read the settings table on every request.
  async init() {
    const row = (await this.store.read('settings', [])).find(item => item.id === SETTINGS_ID);
    this.recording = row ? row.recording !== false : true;
    this.updatedAt = row?.updatedAt ?? null;
    return this.settings();
  }

  settings() {
    return { id: SETTINGS_ID, recording: this.recording, maxRows: this.maxRows, updatedAt: this.updatedAt };
  }

  async setRecording(value) {
    const recording = value === true;
    const updatedAt = this.now().toISOString();
    // append() is an upsert by id, so unrelated settings rows are not touched.
    await this.store.append('settings', { id: SETTINGS_ID, recording, updatedAt });
    this.recording = recording;
    this.updatedAt = updatedAt;
    return this.settings();
  }

  // Called from res.end, which is synchronous. store.append() performs its INSERT
  // synchronously before returning the promise, so the row exists by the time a
  // follow-up HTTP request can read it; the promise chain only handles pruning.
  // A logging failure must never turn a served request into a failed one.
  record(entry = {}) {
    if (!this.recording) return null;
    const at = this.now().toISOString();
    const row = {
      id: `rl_${this.now().getTime()}_${this.random().toString(16).slice(2, 10)}`,
      requestId: stringOrNull(entry.requestId),
      applicationId: stringOrNull(entry.applicationId),
      operation: stringOrNull(entry.operation),
      method: stringOrNull(entry.method),
      path: stringOrNull(entry.path),
      status: Number.isFinite(Number(entry.status)) ? Math.trunc(Number(entry.status)) : null,
      ok: entry.ok === true,
      outcome: stringOrNull(entry.outcome),
      agentId: stringOrNull(entry.agentId),
      providerId: stringOrNull(entry.providerId),
      model: stringOrNull(entry.model),
      stream: entry.stream === true,
      latencyMs: Math.max(0, Math.trunc(Number(entry.latencyMs) || 0)),
      at
    };
    Promise.resolve(this.store.append('requests', row))
      .then(() => this.store.prune?.('requests', this.maxRows))
      .catch(() => {});
    return row;
  }

  async list({ limit = 50, before = null, applicationId = null, status = null, ok = null } = {}) {
    const take = integerInRange(limit, 50, 1, 500);
    let rows = await this.store.read('requests', []);
    if (applicationId) rows = rows.filter(row => row.applicationId === String(applicationId));
    if (status !== null && status !== undefined && status !== '') rows = rows.filter(row => Number(row.status) === Number(status));
    if (ok !== null && ok !== undefined && ok !== '') {
      const wanted = ok === true || ok === 'true' || ok === 1 || ok === '1';
      rows = rows.filter(row => row.ok === wanted);
    }
    if (before) rows = rows.filter(row => String(row.at ?? '') < String(before));
    rows.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    return { requests: rows.slice(0, take), total: rows.length, limit: take, recording: this.recording };
  }
}
