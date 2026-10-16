import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Runtime path anchoring.
 *
 * Paths must not depend on the shell's working directory. The runtime is
 * launched by a shell, by systemd, by a test runner and by packaged builds that
 * live in their own directory, so an implicit `process.cwd()` silently breaks
 * every relative path (`./tools`, `./data`, `./certs`, `public/admin`) as soon as
 * the process is started from somewhere else.
 *
 * Every relative path is therefore anchored to this file's package root.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Directory that contains the runtime package (`src/`, `tools/`, `public/`, ...). */
export const PROJECT_ROOT = path.resolve(moduleDir, '..', '..');

/** Resolves a configured path against PROJECT_ROOT unless it is absolute. */
export function resolveRuntimePath(value, fallback = undefined) {
  const chosen = value === undefined || value === null || String(value).trim() === '' ? fallback : value;
  if (chosen === undefined || chosen === null || String(chosen).trim() === '') return '';
  const text = String(chosen);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(PROJECT_ROOT, text);
}

/** Joins path segments onto PROJECT_ROOT. */
export function fromRoot(...segments) {
  return path.resolve(PROJECT_ROOT, ...segments);
}
