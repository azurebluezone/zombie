import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRuntimeGeneratedSSOT } from './ssot.js';

export class AutoSetupService {
  constructor({contextStore, ssot, syllabus, memory}) { this.contextStore=contextStore; this.ssot=ssot; this.syllabus=syllabus; this.memory=memory; }
  async ensure(root, {refreshSSOT=false}={}) {
    const r=this.contextStore.root(root), base=path.join(r,'.zombiecoder');
    await mkdir(base,{recursive:true});
    const files={
      'version.json': JSON.stringify({schemaVersion:'1.0',runtime:'zombiecoder-runtime',managedBy:'auto-setup',updatedAt:new Date().toISOString()},null,2)+'\n',
      'mcp-config.json': JSON.stringify({schemaVersion:'1.0',mcp:{endpoints:[],permissions:'default-deny'}},null,2)+'\n',
      'vscode.json': JSON.stringify({runtime:'zombiecoder',transport:'http',chatCompletions:'/v1/chat/completions'},null,2)+'\n',
      'jetbrains.json': JSON.stringify({runtime:'zombiecoder',transport:'http',chatCompletions:'/v1/chat/completions'},null,2)+'\n',
      'editor-config.json': JSON.stringify({schemaVersion:'1.0',runtime:'zombiecoder'},null,2)+'\n'
    };
    const created=[]; for(const [name,content] of Object.entries(files)){const p=path.join(base,name); try{await readFile(p,'utf8');}catch(e){if(e.code==='ENOENT'){await writeFile(p,content,'utf8');created.push(p);}else throw e;}}
    await this.contextStore.ensure(r);
    const current = await this.ssot.read(r);
    if(refreshSSOT || !current.content.trim() || !isRuntimeGeneratedSSOT(current.content)) {
      // A file the runtime did not write is not project state it can vouch for, and
      // the "only when empty" rule would keep that file forever: a stale line such as
      // "HTTP_401" was being handed to the model as project truth on every request.
      // The original is kept beside the file so nothing an operator wrote is lost.
      if(current.content.trim() && !isRuntimeGeneratedSSOT(current.content)) {
        const archive=path.join(base,'SSOT.imported.md');
        try{await readFile(archive,'utf8');}catch(e){if(e.code==='ENOENT')await writeFile(archive,current.content,'utf8');else throw e;}
      }
      await this.ssot.refresh(r,{reason: refreshSSOT ? 'auto_setup_forced' : 'auto_setup'});
    }
    await this.syllabus.ensure(r); await this.memory.ensure(r);
    return {root:r,base,created,ssot:this.contextStore.ssotPath(r),syllabus:this.contextStore.syllabusPath(r),memory:this.contextStore.memoryPath(r)};
  }
}
