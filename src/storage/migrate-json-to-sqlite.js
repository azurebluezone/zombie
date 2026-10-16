import { access } from 'node:fs/promises';
import path from 'node:path';
import { SqliteStore } from './sqlite-store.js';
import { JsonStore } from './json-store.js';

export async function migrateJsonToSqlite(dataDir, sqlitePath) {
  const json=new JsonStore(dataDir); await json.init(); const sqlite=new SqliteStore(sqlitePath); await sqlite.init();
  const names=['applications','mcp-endpoints','mcp-permissions','mcp-audit','mcp-connections'];
  const report=[];
  for(const name of names){ const file=path.join(dataDir,`${name}.json`); try{await access(file); const value=await json.read(name,[]); await sqlite.write(name,value); report.push({name,count:value.length,migrated:true});}catch{report.push({name,count:0,migrated:false,reason:'source_missing'});} }
  sqlite.close(); return report;
}
