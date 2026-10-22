#!/usr/bin/env bash
# Consistent SQLite backup with zero dependencies (node:sqlite `VACUUM INTO`).
# Safe while the runtime is running: VACUUM INTO reads a single transaction, so
# the copy is never half-written, which plain `cp` on a WAL database can produce.
#
# Usage: ./scripts/backup-runtime.sh [db-path] [out-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${1:-$ROOT/data/runtime.sqlite}"
OUT_DIR="${2:-$ROOT/backups}"

if [ ! -f "$DB" ]; then
  echo "backup: no database at $DB" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/runtime-$STAMP.sqlite"

DB_PATH="$DB" OUT_PATH="$OUT" node <<'JS'
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.env.DB_PATH;
const outPath = process.env.OUT_PATH;
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("VACUUM INTO '" + outPath.replace(/'/g, "''") + "'");
const check = new DatabaseSync(outPath);
const tables = check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
const integrity = check.prepare('PRAGMA integrity_check').get();
check.close();
db.close();
console.log(JSON.stringify({ out: outPath, tables: Number(tables.n), integrity: integrity.integrity_check }));
JS

# Keep the newest 14 copies; power-loss protection must not become a disk leak.
ls -1t "$OUT_DIR"/runtime-*.sqlite 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "backup: ok"
