import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class SyllabusService {
  constructor({contextStore}) { this.contextStore = contextStore; }
  async read(root) { return this.contextStore.readSyllabus(root); }
  async ensure(root) {
    const r=this.contextStore.root(root), p=this.contextStore.syllabusPath(r);
    await mkdir(path.dirname(p), {recursive:true});
    try { await readFile(p,'utf8'); } catch (e) { if(e.code==='ENOENT') await writeFile(p,'# Agent Knowledge Syllabus\n\nStatus: initialized\n\n','utf8'); else throw e; }
    return {path:p};
  }
  async append(root, entry={}) {
    await this.ensure(root);
    const p=this.contextStore.syllabusPath(root);
    const now=entry.date ?? new Date().toISOString();
    const text=`\n## ${String(entry.topic ?? 'Untitled').trim()}\n- Source: ${String(entry.source ?? 'runtime').trim()}\n- Date: ${now}\n- Summary: ${String(entry.summary ?? '').trim()}\n- Status: ${String(entry.status ?? 'observed').trim()}\n- Evidence: ${String(entry.evidence ?? '').trim()}\n`;
    await writeFile(p, (await readFile(p,'utf8')) + text, 'utf8');
    return {path:p,entry:{...entry,date:now}};
  }
}
