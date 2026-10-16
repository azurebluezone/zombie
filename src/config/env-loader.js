import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths.js';

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIndex = value.search(/\s+#/);
      if (commentIndex >= 0) value = value.slice(0, commentIndex);
    }
    values[match[1]] = stripQuotes(value);
  }
  return values;
}

export function loadEnvFile({cwd = PROJECT_ROOT, file = process.env.ENV_FILE || '.env', override = false} = {}) {
  if (process.env.ENV_LOADER_ENABLED === 'false') return {loaded:false, path:null, keys:[], skipped:'disabled'};
  const filePath = path.resolve(cwd, file);
  if (!existsSync(filePath)) return {loaded:false, path:filePath, keys:[], skipped:'not_found'};
  const values = parseEnv(readFileSync(filePath, 'utf8'));
  const loaded = [];
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return {loaded:true, path:filePath, keys:loaded, totalKeys:Object.keys(values).length, override};
}
