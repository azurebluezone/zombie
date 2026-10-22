import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TABLES = {
  applications: 'applications',
  'mcp-endpoints': 'mcp_endpoints',
  'mcp-permissions': 'mcp_permissions',
  'mcp-audit': 'mcp_audit',
  'mcp-connections': 'mcp_connections',
  providers: 'providers',
  personas: 'personas',
  evidence: 'evidence',
  tools: 'tools',
  skills: 'skills',
  agents: 'agents',
  transports: 'transports',
  sessions: 'sessions',
  'session-messages': 'session_messages',
  'tool-permissions': 'tool_permissions',
  agentModelMappings: 'agent_model_mappings',
  agentMetrics: 'agent_metrics',
  'mcp-clients': 'mcp_clients',
  'mcp-settings': 'mcp_settings',
  'model-tests': 'model_tests',
};

// Every table starts with the same four bookkeeping columns. `data` is the source
// of truth (JSON), the rest are indexed mirrors. Keep this declaration in one place:
// init() creates a fresh database from it and _ensureColumns() upgrades an existing
// one, so a column added in a later release appears on the next boot without a
// manual migration step.
const BASE_COLUMNS = Object.freeze({
  id: 'TEXT PRIMARY KEY',
  data: 'TEXT NOT NULL',
  created_at: 'TEXT NOT NULL',
  updated_at: 'TEXT NOT NULL',
});

const TABLE_COLUMNS = Object.freeze({
  // Append-only audit log has no updated_at and auto-increments its id.
  'mcp-audit': Object.freeze({ id: 'INTEGER PRIMARY KEY AUTOINCREMENT', data: 'TEXT NOT NULL', created_at: 'TEXT NOT NULL' }),
  // Probe history is append-only; these columns let a plain SELECT rank recent
  // runs without parsing every JSON payload. Types are declared here on purpose:
  // adding `ok` as TEXT to an older database would make SUM/ORDER BY wrong.
  'model-tests': Object.freeze({ ...BASE_COLUMNS, provider: 'TEXT', model: 'TEXT', ok: 'INTEGER', latency_ms: 'INTEGER' }),
});

function columnsFor(name) {
  return TABLE_COLUMNS[name] ?? BASE_COLUMNS;
}

// Records whose JSON payload is mirrored into queryable columns. `data` stays the
// source of truth; these columns exist so an operator can SELECT them directly.
const EXTRA_COLUMNS = {
  agents: { tool_boundary: 'TEXT', working_directory: 'TEXT' },
  'model-tests': { provider: 'TEXT', model: 'TEXT', ok: 'INTEGER', latency_ms: 'INTEGER' },
};

// Exported so a test can assert the live schema, not a copy of it.
export const SQLITE_SCHEMA = Object.freeze({ tables: TABLES, columnsFor, extraColumns: EXTRA_COLUMNS });

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_session_messages_session_created ON session_messages(json_extract(data,'$.sessionId'), created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_audit_created_at ON mcp_audit(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_connections_session ON mcp_connections(json_extract(data,'$.sessionId'))`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_connections_lease ON mcp_connections(json_extract(data,'$.leaseExpiresAt'))`,
  `CREATE INDEX IF NOT EXISTS idx_model_tests_provider_model ON model_tests(provider, model, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_model_tests_created_at ON model_tests(created_at)`,
];

const EXTRA_VALUES = {
  tool_boundary: item => (item.toolBoundary == null || String(item.toolBoundary).trim() === '' ? null : String(item.toolBoundary)),
  working_directory: item => (item.workingDirectory == null || String(item.workingDirectory).trim() === '' ? null : String(item.workingDirectory)),
  provider: item => String(item.providerId ?? ''),
  model: item => String(item.model ?? ''),
  ok: item => (item.ok === true ? 1 : 0),
  latency_ms: item => (Number.isFinite(Number(item.latencyMs)) ? Math.trunc(Number(item.latencyMs)) : null),
};

export class SqliteStore {
  constructor(file) { this.filePath = path.resolve(file); this.db = null; }
  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      -- WAL + synchronous=NORMAL can drop the last commits on a power cut. This
      -- runtime runs from a USB stick where power loss is the expected failure,
      -- and the write volume is tiny, so pay the fsync and keep every ACKed write.
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
    `);
    for (const name of Object.keys(TABLES)) {
      const table = TABLES[name];
      const columns = Object.entries(columnsFor(name)).map(([column, type]) => `${column} ${type}`).join(', ');
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${columns})`);
    }
    // Existing databases may predate a table or a mirror column. Add what is
    // missing before creating indexes that depend on those columns.
    this._ensureColumns();
    for (const sql of INDEXES) this.db.exec(sql);
  }
  // Some records carry a few fields that operators want to query without parsing
  // the JSON payload. They stay in `data` as the source of truth and are mirrored
  // into real columns here, so a plain SELECT shows them.
  _ensureColumns() {
    for (const [name, columns] of Object.entries(EXTRA_COLUMNS)) {
      const table = this._table(name);
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const [column, type] of Object.entries(columns)) {
        if (existing.has(column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }
  _table(name) { const t = TABLES[name]; if (!t) throw new Error(`sqlite_collection_not_supported:${name}`); return t; }
  _upsertStatement(table, extra = []) {
    const columns = ['id', 'data', 'created_at', 'updated_at', ...extra];
    const updates = ['data=excluded.data', 'updated_at=excluded.updated_at', ...extra.map(c => `${c}=excluded.${c}`)];
    return this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${updates.join(',')}`);
  }
  _rowValues(item, now, extra = []) {
    return [String(item.id), JSON.stringify(item), item.createdAt ?? now, now, ...extra.map(c => EXTRA_VALUES[c](item))];
  }
  async read(name, fallback=[]) {
    const table=this._table(name);
    if(name==='mcp-audit') {
      return this.db.prepare(`SELECT data FROM ${table} ORDER BY id ASC`).all().map(r=>JSON.parse(r.data));
    }
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`).all().map(r=>JSON.parse(r.data));
  }
  async write(name, value) {
    if (!Array.isArray(value)) throw new Error('sqlite_store_requires_array');
    const table=this._table(name); const now=new Date().toISOString();
    if(name==='mcp-audit') {
      const insert=this.db.prepare(`INSERT INTO ${table}(data,created_at) VALUES(?,?)`);
      this.db.exec('BEGIN'); try { this.db.prepare(`DELETE FROM ${table}`).run(); for(const item of value) insert.run(JSON.stringify(item), item.timestamp ?? now); this.db.exec('COMMIT'); } catch(e) { this.db.exec('ROLLBACK'); throw e; }
      return;
    }
    const existing=this.db.prepare(`SELECT id FROM ${table}`).all().map(r=>r.id);
    const keep=new Set();
    const extra=Object.keys(EXTRA_COLUMNS[name] ?? {});
    const upsert=this._upsertStatement(table, extra);
    this.db.exec('BEGIN');
    try {
      for(const item of value) { if(!item?.id) throw new Error(`sqlite_record_id_required:${name}`); keep.add(item.id); upsert.run(...this._rowValues(item, now, extra)); }
      const del=this.db.prepare(`DELETE FROM ${table} WHERE id=?`); for(const old of existing) if(!keep.has(old)) del.run(old);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async append(name, item) {
    const table=this._table(name); const now=new Date().toISOString();
    if (!item?.id) throw new Error(`sqlite_record_id_required:${name}`);
    if (name === 'mcp-audit') {
      const stmt=this.db.prepare(`INSERT INTO ${table}(data,created_at) VALUES(?,?)`);
      stmt.run(JSON.stringify(item), item.timestamp ?? now); return item;
    }
    const extra=Object.keys(EXTRA_COLUMNS[name] ?? {});
    const stmt=this._upsertStatement(table, extra);
    stmt.run(...this._rowValues(item, now, extra)); return item;
  }
  async deleteById(name, id) {
    const table=this._table(name); const stmt=this.db.prepare(`DELETE FROM ${table} WHERE id=?`); return stmt.run(String(id)).changes;
  }
  async deleteWhere(name, predicate) {
    const table=this._table(name); const rows=await this.read(name, []); const keep=rows.filter(item=>!predicate(item));
    if (keep.length !== rows.length) await this.write(name, keep); return rows.length-keep.length;
  }
  async findWhere(name, predicate) { const rows=await this.read(name, []); return rows.filter(predicate); }

  /** Keep the newest `keep` rows of an append-only collection. */
  async prune(name, keep = 1000) {
    const table = this._table(name);
    const limit = Math.max(0, Math.trunc(Number(keep) || 0));
    return this.db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY rowid DESC LIMIT -1 OFFSET ?)`).run(limit).changes;
  }

  close(){ this.db?.close(); }
}
