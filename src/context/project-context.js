import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const AGENTS_DIR = path.join('.zombiecoder', 'agents');

export class ProjectContextStore {
  constructor({ defaultRoot = process.cwd(), allowedRoots = null } = {}) {
    this.defaultRoot = path.resolve(defaultRoot);
    this.allowedRoots = Array.isArray(allowedRoots) && allowedRoots.length ? allowedRoots.map(x => path.resolve(String(x))) : null;
  }
  root(inputRoot) {
    const r = path.resolve(inputRoot || this.defaultRoot);
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
