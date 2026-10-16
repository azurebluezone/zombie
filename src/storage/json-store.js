import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export class JsonStore {
  constructor(dir) { this.dir = dir; }
  async init() { await mkdir(this.dir, { recursive: true }); }
  file(name) { return path.join(this.dir, `${name}.json`); }
  async read(name, fallback = []) { try { return JSON.parse(await readFile(this.file(name), 'utf8')); } catch { return fallback; } }
  async write(name, value) { await writeFile(this.file(name), JSON.stringify(value, null, 2)); }
}
