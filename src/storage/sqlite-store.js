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
  }
  _table(name) { const t = TABLES[name]; if (!t) throw new Error(`sqlite_collection_not_supported:${name}`); return t; }
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
    const upsert=this.db.prepare(`INSERT INTO ${table}(id,data,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`);
    this.db.exec('BEGIN');
    try {
      for(const item of value) { if(!item?.id) throw new Error(`sqlite_record_id_required:${name}`); keep.add(item.id); upsert.run(String(item.id),JSON.stringify(item),item.createdAt??now,now); }
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
    const stmt=this.db.prepare(`INSERT INTO ${table}(id,data,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`);
    stmt.run(String(item.id), JSON.stringify(item), item.createdAt ?? now, now); return item;
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
