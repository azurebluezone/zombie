/**
 * Project notes.
 *
 * A note is a short, dated line an agent wants to keep about the folder it is working
 * in: what a file turned out to be, which command worked, what is still broken, what the
 * user asked for in their own words. The runtime already has a syllabus and a memory, but
 * neither has a writer an agent can reach — so an agent that learns something has nowhere
 * to put it, and the next request starts from zero.
 *
 * Path discipline is the whole point of this module. The store never reads
 * `process.cwd()`. Every call takes an absolute project root, and a relative one is
 * refused outright with `note_root_must_be_absolute`. A relative path that silently
 * resolves against whatever directory the shell happened to be in is exactly how "it
 * worked on my machine" happens: the runtime gets launched by a shell, by systemd, by a
 * test runner and by a packaged build, and `npm start` from a different folder would put
 * the notes somewhere nobody looks. This file exists so that does not happen again.
 *
 * Notes are per project root, under `.zombiecoder/agents/notes.json`, next to the
 * syllabus and the memory — so the folder you are working in is the folder that is
 * remembered, and switching to another folder remembers that one instead.
 *
 * Built on Node's own modules only: `node:fs/promises`, `node:path`, `node:crypto`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const NOTES_RELATIVE_PATH = path.join('.zombiecoder', 'agents', 'notes.json');
export const DEFAULT_MAX_NOTES = 500;
export const MAX_NOTE_CHARS = 2000;

/**
 * Resolve a root to an absolute path, or refuse it.
 *
 * `path.resolve()` on a relative input would happily return a path under the current
 * working directory, which is the silent failure we are preventing, so a relative root is
 * an error rather than something to interpret.
 */
export function assertAbsoluteRoot(projectRoot) {
  const text = String(projectRoot ?? '').trim();
  if (!text) throw new Error('note_root_required');
  if (!path.isAbsolute(text)) throw new Error('note_root_must_be_absolute');
  return path.normalize(text);
}

/** The notes file for a project root. Throws unless the root is absolute. */
export function notePath(projectRoot) {
  return path.join(assertAbsoluteRoot(projectRoot), NOTES_RELATIVE_PATH);
}

/**
 * Pick a root from an explicit value first, then a configured default. There is
 * deliberately no third fallback: the working directory is not an answer.
 */
export function resolveNoteRoot(input, { defaultRoot } = {}) {
  if (input !== undefined && input !== null && String(input).trim() !== '') return assertAbsoluteRoot(input);
  if (defaultRoot !== undefined && defaultRoot !== null && String(defaultRoot).trim() !== '') return assertAbsoluteRoot(defaultRoot);
  throw new Error('note_root_required');
}

/**
 * Write via a temporary file in the same directory, then rename it into place. A rename
 * within one filesystem is atomic, so a crash, a kill or a full disk leaves the previous
 * notes intact instead of a half-written file that no longer parses.
 */
async function writeAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

export class NoteStore {
  constructor({ maxNotes = DEFAULT_MAX_NOTES } = {}) {
    this.maxNotes = Math.max(1, Number(maxNotes) || DEFAULT_MAX_NOTES);
  }

  /** Create the notes file if it is missing, and return where it lives. */
  async ensure(projectRoot) {
    const root = assertAbsoluteRoot(projectRoot);
    const file = notePath(root);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeAtomic(file, '[]\n');
    }
    return { root, path: file };
  }

  /**
   * Read the notes. A file that is missing, empty, not an array or not JSON is reported
   * through `warnings` and treated as empty — never deleted, because a file the runtime
   * did not understand may still be the user's own work.
   */
  async read(projectRoot) {
    const root = assertAbsoluteRoot(projectRoot);
    const file = notePath(root);
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { root, path: file, notes: [], warnings: ['notes_not_found'] };
      throw error;
    }
    if (!raw.trim()) return { root, path: file, notes: [], warnings: [] };
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return { root, path: file, notes: [], warnings: ['notes_invalid_json'] };
    }
    if (!Array.isArray(value)) return { root, path: file, notes: [], warnings: ['notes_not_array'] };
    return { root, path: file, notes: value, warnings: [] };
  }

  async append(projectRoot, input = {}) {
    const { root, path: file } = await this.ensure(projectRoot);
    const text = String(input.text ?? '').trim().slice(0, MAX_NOTE_CHARS);
    if (!text) throw new Error('note_text_required');
    const current = await this.read(root);
    const note = {
      id: String(input.id ?? `note_${randomUUID()}`),
      createdAt: String(input.createdAt ?? new Date().toISOString()),
      topic: String(input.topic ?? 'general').trim().slice(0, 120) || 'general',
      text,
      tags: Array.isArray(input.tags)
        ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12)
        : [],
      source: String(input.source ?? 'agent').trim().slice(0, 60) || 'agent'
    };
    const notes = [...current.notes, note].slice(-this.maxNotes);
    await writeAtomic(file, `${JSON.stringify(notes, null, 2)}\n`);
    return { root, path: file, note, count: notes.length };
  }

  async list(projectRoot, { limit = 20, topic, tag } = {}) {
    const { root, path: file, notes, warnings } = await this.read(projectRoot);
    const filtered = notes.filter((n) => (!topic || String(n.topic) === String(topic))
      && (!tag || (Array.isArray(n.tags) && n.tags.includes(String(tag)))));
    const take = Math.max(1, Math.min(200, Number(limit) || 20));
    return { root, path: file, total: notes.length, returned: Math.min(take, filtered.length), notes: filtered.slice(-take), warnings };
  }

  async search(projectRoot, { query = '', limit = 20 } = {}) {
    const { root, path: file, notes, warnings } = await this.read(projectRoot);
    const needle = String(query).trim().toLowerCase();
    const take = Math.max(1, Math.min(200, Number(limit) || 20));
    if (!needle) return { root, path: file, total: notes.length, returned: 0, notes: [], warnings: [...warnings, 'note_query_required'] };
    const matched = notes.filter((n) => JSON.stringify(n).toLowerCase().includes(needle));
    return { root, path: file, total: notes.length, returned: Math.min(take, matched.length), notes: matched.slice(-take), warnings };
  }

  async remove(projectRoot, { id } = {}) {
    const { root, path: file } = await this.ensure(projectRoot);
    const wanted = String(id ?? '').trim();
    if (!wanted) throw new Error('note_id_required');
    const current = await this.read(root);
    const notes = current.notes.filter((n) => String(n.id) !== wanted);
    if (notes.length === current.notes.length) throw new Error('note_not_found');
    await writeAtomic(file, `${JSON.stringify(notes, null, 2)}\n`);
    return { root, path: file, removed: current.notes.length - notes.length, count: notes.length };
  }

  async count(projectRoot) {
    const { notes } = await this.read(projectRoot);
    return notes.length;
  }
}
