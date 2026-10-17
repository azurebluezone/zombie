import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths.js';

const AGENTS_DIR = path.join('.zombiecoder', 'agents');

export class ProjectContextStore {
  /**
   * `defaultRoot` used to be `process.cwd()`: a project root that silently changed with
   * the directory the shell happened to be in. The runtime is launched by a shell, by
   * systemd, by a test runner and by packaged builds, so the fallback is now the runtime's
   * own package root — deterministic, and the same from every working directory. Callers
   * that know the real project (the server passes `config.dataDir`) still win.
   */
  constructor({ defaultRoot = PROJECT_ROOT, allowedRoots = null } = {}) {
    this.defaultRoot = path.resolve(defaultRoot);
    this.allowedRoots = Array.isArray(allowedRoots) && allowedRoots.length ? allowedRoots.map(x => path.resolve(String(x))) : null;
  }
  /**
   * Resolve a project root.
   *
   * `allowAnyRoot` is the agent-scope path: the caller has already been authorized
   * by an agent's persisted tool-access scope, so the runtime's configured
   * allowedRoots are not the boundary any more. The path must still exist — a
   * missing root fails closed rather than silently creating a sandbox.
   */
  root(inputRoot, { allowAnyRoot = false } = {}) {
    const r = path.resolve(inputRoot || this.defaultRoot);
    if (allowAnyRoot) {
      try { return realpathSync(r); } catch { throw new Error('project_root_not_found'); }
    }
    if (this.allowedRoots) {
      const allowedLexical = this.allowedRoots.some(base => r === base || r.startsWith(`${base}${path.sep}`));
      if (!allowedLexical) throw new Error('project_root_not_allowed');
      let actual;
      try { actual = realpathSync(r); } catch { throw new Error('project_root_not_found'); }
      const allowedActual = this.allowedRoots.map(base => { try { return realpathSync(base); } catch { return null; } }).filter(Boolean);
      if (!allowedActual.some(base => actual === base || actual.startsWith(`${base}${path.sep}`))) throw new Error('project_root_not_allowed');
      return actual;
    }
    return r;
  }
  async assertAllowedRoot(inputRoot) { return this.root(inputRoot); }

  /**
   * Mark a root as already authorized.
   *
   * The HTTP layer authorizes a root through the agent's persisted tool-access scope and
   * resolves it with `allowAnyRoot`. Every service that afterwards receives only the
   * resolved path — SSOT, syllabus, memory, auto-setup — re-checks it against
   * `allowedRoots` and refused a folder the caller had just been granted:
   * `project_root_not_allowed` for a root the agent scope allows, which is why a global
   * agent could not be pointed at a project outside `PROJECT_ROOTS` even though the scope
   * says it may name any root on the host. Trusting the resolved root here keeps one
   * authorization decision instead of two that disagree.
   *
   * Call this only for a root that has already been authorized. It is additive: it can
   * widen `allowedRoots`, never narrow it, and a path that does not exist still fails
   * closed rather than being remembered.
   */
  trustRoot(inputRoot) {
    // With no allowlist configured nothing is restricted, so there is nothing to trust.
    if (this.allowedRoots === null || inputRoot == null || String(inputRoot).trim() === '') return null;
    let resolved;
    try { resolved = realpathSync(path.resolve(String(inputRoot))); }
    catch { throw new Error('project_root_not_found'); }
    const alreadyAllowed = this.allowedRoots.some(base => resolved === base || resolved.startsWith(`${base}${path.sep}`));
    if (!alreadyAllowed) this.allowedRoots.push(resolved);
    return resolved;
  }

  ssotPath(root) { return path.join(this.root(root), '.zombiecoder', 'SSOT.md'); }
  syllabusPath(root) { return path.join(this.root(root), AGENTS_DIR, 'syllabus.md'); }
  memoryPath(root) { return path.join(this.root(root), AGENTS_DIR, 'memory.json'); }

  async readText(filePath) { try { return await readFile(filePath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
  async readSSOT(root) { await this.assertAllowedRoot(root); const p=this.ssotPath(root); return { path:p, content:await this.readText(p) }; }
  async readSyllabus(root) { await this.assertAllowedRoot(root); const p=this.syllabusPath(root); return { path:p, content:await this.readText(p) }; }
  async readMemory(root) {
    await this.assertAllowedRoot(root);
    const p=this.memoryPath(root); const raw=await this.readText(p);
    if (!raw) return { path:p, entries:[], warnings:['memory_not_found'] };
    try { const value=JSON.parse(raw); return { path:p, entries:Array.isArray(value)?value:[], warnings:Array.isArray(value)?[]:['memory_not_array'] }; }
    catch { return { path:p, entries:[], warnings:['memory_invalid_json'] }; }
  }

  async ensure(root) {
    const r=this.root(root); await mkdir(path.join(r, '.zombiecoder', 'agents'), {recursive:true});
    const ssot=this.ssotPath(r), syllabus=this.syllabusPath(r), memory=this.memoryPath(r);
    try { await access(ssot); } catch { await writeFile(ssot, `# Project SSOT\n\nStatus: generated\nRoot: ${r}\n`, 'utf8'); }
    try { await access(syllabus); } catch { await writeFile(syllabus, `# Agent Knowledge Syllabus\n\nStatus: initialized\n`, 'utf8'); }
    try { await access(memory); } catch { await writeFile(memory, '[]\n', 'utf8'); }
    return {root:r, ssot, syllabus, memory};
  }
}
