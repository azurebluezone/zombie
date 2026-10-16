import path from 'node:path';
import { SqliteStore } from './sqlite-store.js';
import { migrateJsonToSqlite } from './migrate-json-to-sqlite.js';

export async function createStore(config){
  const sqlitePath=path.resolve(config.sqlitePath || path.join(config.dataDir,'runtime.sqlite'));
  const store=new SqliteStore(sqlitePath); await store.init();
  if(config.migrateJsonOnStart) await migrateJsonToSqlite(config.dataDir,sqlitePath);
  return store;
}
