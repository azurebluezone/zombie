import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ProjectMemoryService {
  constructor({contextStore, maxEntries=500}) { this.contextStore=contextStore; this.maxEntries=Math.max(1,Number(maxEntries)||500); }
  async ensure(root) { const r=this.contextStore.root(root), p=this.contextStore.memoryPath(r); await mkdir(path.dirname(p),{recursive:true}); try { await readFile(p,'utf8'); } catch(e){ if(e.code==='ENOENT') await writeFile(p,'[]\n','utf8'); else throw e; } return {path:p}; }
  async read(root) { return this.contextStore.readMemory(root); }
  async append(root, input={}) {
    await this.ensure(root); const p=this.contextStore.memoryPath(root); const current=await this.read(root);
    const entry={id:input.id ?? `mem_${randomUUID()}`,createdAt:input.createdAt ?? new Date().toISOString(),scope:input.scope ?? 'project',kind:input.kind ?? 'note',content:input.content ?? '',source:input.source ?? 'runtime',status:input.status ?? 'observed'};
    const next=[...current.entries,entry].slice(-this.maxEntries); await writeFile(p,JSON.stringify(next,null,2)+'\n','utf8'); return entry;
  }
  async recent(root, limit=10) { const r=await this.read(root); return r.entries.slice(-Math.max(1,Number(limit)||10)); }
  async relevant(root, terms=[]) { const r=await this.read(root); const needles=(Array.isArray(terms)?terms:[]).map(x=>String(x).toLowerCase()).filter(Boolean); if(!needles.length) return r.entries.slice(-10); return r.entries.filter(e=>needles.some(n=>JSON.stringify(e).toLowerCase().includes(n))).slice(-20); }
}
