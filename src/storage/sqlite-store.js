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
};

// Records whose JSON payload is mirrored into queryable columns. `data` stays the
// source of truth; these columns exist so an operator can SELECT them directly.
const EXTRA_COLUMNS = {
  agents: ['tool_boundary', 'working_directory'],
};

const EXTRA_VALUES = {
  tool_boundary: item => (item.toolBoundary == null || String(item.toolBoundary).trim() === '' ? null : String(item.toolBoundary)),
  working_directory: item => (item.workingDirectory == null || String(item.workingDirectory).trim() === '' ? null : String(item.workingDirectory)),
};

export class SqliteStore {
  constructor(file) { this.filePath = path.resolve(file); this.db = null; }
  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_endpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_permissions (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_messages (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_permissions (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_model_mappings (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_metrics (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_created ON session_messages(json_extract(data,'$.sessionId'), created_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_created_at ON mcp_audit(created_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_connections_session ON mcp_connections(json_extract(data,'$.sessionId'));
      CREATE INDEX IF NOT EXISTS idx_mcp_connections_lease ON mcp_connections(json_extract(data,'$.leaseExpiresAt'));
    `);
    this._ensureColumns();
  }
  // Some records carry a few fields that operators want to query without parsing
  // the JSON payload. They stay in `data` as the source of truth and are mirrored
  // into real columns here, so a plain SELECT shows them.
  _ensureColumns() {
    for (const [table, columns] of Object.entries(EXTRA_COLUMNS)) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const name of columns) {
        if (existing.has(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
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
    const extra=EXTRA_COLUMNS[name] ?? [];
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
    const stmt=this._upsertStatement(table, EXTRA_COLUMNS[name] ?? []);
    stmt.run(...this._rowValues(item, now, EXTRA_COLUMNS[name] ?? [])); return item;
  }
  async deleteById(name, id) {
    const table=this._table(name); const stmt=this.db.prepare(`DELETE FROM ${table} WHERE id=?`); return stmt.run(String(id)).changes;
  }
  async deleteWhere(name, predicate) {
    const table=this._table(name); const rows=await this.read(name, []); const keep=rows.filter(item=>!predicate(item));
    if (keep.length !== rows.length) await this.write(name, keep); return rows.length-keep.length;
  }
  async findWhere(name, predicate) { const rows=await this.read(name, []); return rows.filter(predicate); }

  close(){ this.db?.close(); }
}
