import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['.git','.zombiecoder','node_modules','vendor','.venv','venv','dist','build','.cache']);
const MAX_ENTRIES = 200;

async function scanDir(root, relative = '', depth = 0, out = []) {
  if (depth > 4 || out.length >= MAX_ENTRIES) return out;
  let entries = [];
  try { entries = await (await import('node:fs/promises')).readdir(path.join(root, relative), {withFileTypes:true}); } catch { return out; }
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.DS_Store')) continue;
    const rel = path.join(relative, entry.name).replaceAll(path.sep,'/');
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) await scanDir(root, rel, depth + 1, out);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

function detectTech(files) {
  const set = new Set();
  if (files.some(x=>x.endsWith('package.json'))) set.add('Node.js');
  if (files.some(x=>x.endsWith('.php') || x.includes('composer.json'))) set.add('PHP');
  if (files.some(x=>x.endsWith('.py') || x.endsWith('requirements.txt'))) set.add('Python');
  if (files.some(x=>x.endsWith('.ts') || x.endsWith('.tsx'))) set.add('TypeScript');
  if (files.some(x=>x.endsWith('.js') || x.endsWith('.jsx'))) set.add('JavaScript');
  if (files.some(x=>x.includes('docker') || x.endsWith('Dockerfile'))) set.add('Docker');
  if (files.some(x=>x.toLowerCase().includes('laravel'))) set.add('Laravel');
  return [...set];
}

export class SSOTService {
  constructor({contextStore}) { this.contextStore = contextStore; }
  async build(root, {reason='manual_refresh'} = {}) {
    const r = this.contextStore.root(root);
    const files = await scanDir(r);
    const now = new Date().toISOString();
    const tech = detectTech(files);
    return {schemaVersion:'1.0', status:'generated', provenance:{source:'runtime-project-scanner', reason, generatedAt:now}, project:{root:r, technologies:tech, fileCount:files.length, structure:files}, boundaries:{ssot:'project state and detected structure', syllabus:'knowledge/reference entries', memory:'conversation/session-derived project notes'}, warnings: files.length >= MAX_ENTRIES ? ['structure_truncated'] : []};
  }
  format(doc) {
    return `# Project SSOT\n\n- Status: ${doc.status}\n- Schema: ${doc.schemaVersion}\n- Generated: ${doc.provenance.generatedAt}\n- Reason: ${doc.provenance.reason}\n- Root: ${doc.project.root}\n- File count observed: ${doc.project.fileCount}\n\n## Detected Technologies\n${doc.project.technologies.length ? doc.project.technologies.map(x=>`- ${x}`).join('\n') : '- none detected'}\n\n## Project Structure\n${doc.project.structure.map(x=>`- ${x}`).join('\n') || '- empty'}\n\n## Context Boundaries\n- SSOT: ${doc.boundaries.ssot}\n- Syllabus: ${doc.boundaries.syllabus}\n- Memory: ${doc.boundaries.memory}\n\n## Warnings\n${doc.warnings.length ? doc.warnings.map(x=>`- ${x}`).join('\n') : '- none'}\n`;
  }
  async refresh(root, options={}) {
    const doc = await this.build(root, options);
    const target = this.contextStore.ssotPath(root);
    await mkdir(path.dirname(target), {recursive:true});
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, this.format(doc), 'utf8');
    await rename(tmp, target);
    return {path:target, document:doc};
  }
  async read(root) { return this.contextStore.readSSOT(root); }
}
