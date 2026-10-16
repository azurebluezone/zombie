import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const background = new Map();
const textResult = (text, extra={}) => ({content:[{type:'text',text:String(text)}],...extra});
const clamp = (v,min,max) => Math.max(min,Math.min(max,Number(v)||min));
function projectRoot(ctx){ if(!ctx?.executionContext?.projectRoot) throw new Error('project_root_required'); return path.resolve(ctx.executionContext.projectRoot); }
// A run whose agent scope is `global` has been granted any-folder reach: declared
// paths resolve outside the project root, and the command allowlist stops being
// the boundary. Every other run keeps the workspace sandbox.
const anyPath = (ctx) => ctx?.executionContext?.allowAnyPath === true;
const anyCommand = (ctx) => ctx?.executionContext?.allowAnyCommand === true;
function within(root,target){ const base=root.endsWith(path.sep)?root:`${root}${path.sep}`; return target===root||target.startsWith(base); }
function safePath(root, input, allowAny=false){ if(typeof input!=='string'||!input.trim()) throw new Error('path_required'); const p=path.resolve(root,input); if(!allowAny&&!within(root,p)) throw new Error('path_outside_project_root'); return p; }
// Directories that are noise for a content search. They are only skipped by
// default: a caller that really needs them passes includeIgnored.
const SKIP_DIRS = new Set(['.git','node_modules','.zombiecoder','vendor','.next','dist','build','coverage']);
const SEARCH_DEADLINE_MS = 10000;
// A walk is bounded three ways (maxFiles, maxDepth, wall-clock deadline) and it
// reports whether it stopped early, so a caller can never mistake a truncated
// scan for "nothing matched". `displayRoot` keeps reported paths relative to the
// project root even when the scan starts elsewhere; anything outside the display
// root is reported absolute instead of as a ../.. chain.
async function walk(root,{maxFiles=3000,maxDepth=12,displayRoot=null,deadlineMs=SEARCH_DEADLINE_MS,includeIgnored=false}={}) {
  const out=[]; const display=displayRoot??root; const until=Date.now()+deadlineMs; let truncated=false;
  const label=(p)=>{const rel=path.relative(display,p);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:p};
  let stat; try{stat=await fs.lstat(root)}catch{return {items:[],truncated:false,missing:true}};
  // A single file is a valid search target: `path` may point at one file.
  if(!stat.isDirectory())return {items:[{path:root,relative:label(root),name:path.basename(root),isDirectory:false}],truncated:false};
  async function visit(dir,depth){ if(depth>maxDepth||out.length>=maxFiles||Date.now()>until){truncated=true;return} let entries;try{entries=await fs.readdir(dir,{withFileTypes:true})}catch{return} for(const e of entries){if(out.length>=maxFiles||Date.now()>until){truncated=true;return}if(!includeIgnored&&SKIP_DIRS.has(e.name))continue;const p=path.join(dir,e.name);out.push({path:p,relative:label(p),name:e.name,isDirectory:e.isDirectory()});if(e.isDirectory())await visit(p,depth+1)}}
  await visit(root,0); return {items:out,truncated};
}
// Resolve the directory a search starts from. Without an explicit `path` the
// scan stays at the project root (the unchanged default). With one, the same
// boundary that guards every other tool applies: a scoped run stays inside its
// root, a global run may point anywhere. A scoped run also re-checks the real
// path, because the lexical check in safePath cannot stop fs.readdir from
// following a symlink out of the root.
async function searchBase(args,getRoot,argPath,allowAny){
  const raw=typeof args.path==='string'?args.path.trim():'';
  const display=getRoot();
  if(!raw)return {dir:display,explicit:false,display};
  const lexical=argPath(raw);
  if(allowAny)return {dir:lexical,explicit:true,display};
  const realRoot=await fs.realpath(display).catch(()=>display);
  const realDir=await fs.realpath(lexical).catch(()=>lexical);
  if(!within(realRoot,realDir))throw new Error('path_outside_project_root');
  return {dir:realDir,explicit:true,display};
}
// A spawned tool gets an explicit environment instead of process.env, so runtime
// secrets (PROVIDER_KEY_*, ADMIN_TOKEN, ...) can never leak into a child process.
// The allowlist is limited to variables an operating system needs to locate and
// run an executable: without PATHEXT/ComSpec/SystemRoot, spawning `npm` (a .cmd
// shim) fails on Windows even though the identical call works on Linux.
const CHILD_ENV_KEYS = ['PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','SystemRoot','windir','ComSpec','PATHEXT','TEMP','TMP','APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','OS','USERNAME','LANG','LC_ALL','TZ'];
const childEnv = () => Object.fromEntries(CHILD_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
async function run(argv,cwd,{timeoutMs=30000,backgroundMode=false,allowAnyCommand=false}={}) { if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'||x.includes('\0'))) throw new Error('argv_array_required'); const bin=argv[0];
  if(!allowAnyCommand){
    const allow=new Set(['node','npm','pnpm','yarn','composer','php','python3','python','git']); if(!allow.has(bin))throw new Error('command_not_allowlisted');
    const sub=argv[1]??'';
    if(bin==='node'&&!['--version','-v','--check','--test'].includes(sub))throw new Error('node_command_not_allowlisted');
    if(['npm','pnpm','yarn'].includes(bin)&&!(['--version','-v','test'].includes(sub)||(sub==='run'&&['test','lint','build','typecheck','check'].includes(argv[2]))))throw new Error('package_command_not_allowlisted');
    if(bin==='git'&&!['status','diff','log','rev-parse','branch'].includes(sub))throw new Error('git_command_not_allowlisted');
    if(bin==='composer'&&!['validate','--version','-V'].includes(sub))throw new Error('composer_command_not_allowlisted');
    if(bin==='php'&&!['-l','--version','-v'].includes(sub))throw new Error('php_command_not_allowlisted');
    if(['python','python3'].includes(bin)&&!(sub==='--version'||sub==='-V'||(sub==='-m'&&argv[2]==='pytest')))throw new Error('python_command_not_allowlisted'); if(bin==='npm'&&['install','i','add','uninstall','remove','update','exec'].includes(argv[1]))throw new Error('package_mutation_requires_separate_approval'); if(bin==='pnpm'&&['install','add','remove','update','dlx'].includes(argv[1]))throw new Error('package_mutation_requires_separate_approval'); if(bin==='yarn'&&['install','add','remove','upgrade'].includes(argv[1]))throw new Error('package_mutation_requires_separate_approval');
  }
  const proc=spawn(bin,argv.slice(1),{cwd, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'], env:childEnv()}); let stdout='',stderr='',timedOut=false; const max=100_000; proc.stdout.on('data',b=>{if(stdout.length<max)stdout+=b.toString().slice(0,max-stdout.length)});proc.stderr.on('data',b=>{if(stderr.length<max)stderr+=b.toString().slice(0,max-stderr.length)});
  if(backgroundMode){const processId=randomUUID();background.set(processId,proc);proc.on('exit',()=>background.delete(processId));return {processId,pid:proc.pid,started:true};}
  const timer=setTimeout(()=>{timedOut=true;proc.kill('SIGTERM');setTimeout(()=>proc.kill('SIGKILL'),1000).unref?.()},timeoutMs); const code=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve)}).finally(()=>clearTimeout(timer)); return {exitCode:code,signal:proc.signal,stdout,stderr,timedOut}; }

export async function execute(args={},ctx={}) { const tool=ctx.toolId; let root=null; const getRoot=()=>root??=(projectRoot(ctx)); const any=anyPath(ctx); const argPath=(v)=>safePath(getRoot(),v,any); const maxOutput=clamp(args.maxOutputChars??100000,1,100000);
 switch(tool){
 case 'read_file': {const p=argPath(args.path);const s=await fs.stat(p);if(!s.isFile())throw new Error('not_a_file');const content=await fs.readFile(p,'utf8');return textResult(content.slice(0,maxOutput),{truncated:content.length>maxOutput,path:path.relative(root,p)});}
 case 'write_file': case 'create_file': {const p=argPath(args.path);if(tool==='create_file'){try{await fs.access(p);throw new Error('file_already_exists')}catch(e){if(e.message==='file_already_exists')throw e;if(e.code!=='ENOENT')throw e}}else if(args.overwriteExisting!==true){try{await fs.access(p);throw new Error('overwrite_confirmation_required')}catch(e){if(e.message==='overwrite_confirmation_required')throw e;if(e.code!=='ENOENT')throw e}} await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,String(args.content??''),'utf8');return textResult(`${tool==='create_file'?'Created':'Written'} ${String(args.content??'').length} characters to ${path.relative(root,p)}`);}
 case 'edit_file': case 'apply_diff': {const p=argPath(args.path);const oldText=String(args.oldText??args.search??'');const newText=String(args.newText??args.replace??'');if(!oldText)throw new Error('old_text_required');const source=await fs.readFile(p,'utf8');const first=source.indexOf(oldText);if(first<0)throw new Error('target_text_not_found');if(source.indexOf(oldText,first+oldText.length)>=0&&args.replaceAll!==true)throw new Error('target_text_not_unique');const updated=args.replaceAll===true?source.split(oldText).join(newText):source.slice(0,first)+newText+source.slice(first+oldText.length);await fs.writeFile(p,updated,'utf8');return textResult(`Updated ${path.relative(root,p)}; replacements=${args.replaceAll===true?source.split(oldText).length-1:1}`);}
 case 'delete_file': {if(args.confirm!==true)throw new Error('delete_confirmation_required');const p=safePath(getRoot(),args.path,any);if(p===root)throw new Error('project_root_delete_forbidden');const s=await fs.lstat(p);if(s.isSymbolicLink())throw new Error('symlink_delete_forbidden');await fs.rm(p,{recursive:args.recursive===true,force:false});return textResult(`Deleted ${path.relative(root,p)}`);}
 case 'list_dir': case 'read_directory': case 'list_directory': {const p=argPath(args.path||'.');const entries=await fs.readdir(p,{withFileTypes:true});return textResult(entries.map(e=>`${e.isDirectory()?'dir':'file'}\t${e.name}${e.isDirectory()?'/':''}`).join('\n')||'(empty directory)');}
 case 'grep_search': case 'regex_search': {const pattern=String(args.pattern??args.query??'');if(!pattern)throw new Error('search_pattern_required');let re;try{const literal=tool==='grep_search'&&args.regex===false;const escaped=pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');re=new RegExp(literal?escaped:pattern,'i')}catch{throw new Error('invalid_regex')}const base=await searchBase(args,getRoot,argPath,any);const {items,truncated,missing}=await walk(base.dir,{maxFiles:clamp(args.maxFiles??3000,1,20000),maxDepth:clamp(args.maxDepth??12,0,64),displayRoot:base.display,includeIgnored:args.includeIgnored===true});const limit=clamp(args.maxResults??200,1,2000);const matches=[];for(const f of items){if(f.isDirectory)continue;let data;try{const st=await fs.stat(f.path);if(st.size>1_000_000)continue;data=await fs.readFile(f.path,'utf8');if(data.includes('\u0000'))continue}catch{continue}const lines=data.split(/\r?\n/);for(let i=0;i<lines.length;i++){if(re.test(lines[i])){matches.push(`${f.relative}:${i+1}:${lines[i].slice(0,500)}`);if(matches.length>=limit)break}}if(matches.length>=limit)break}const note=missing?`\n[path not found: ${base.dir}]`:matches.length>=limit?`\n[truncated at ${limit} matches; narrow with path/pattern or raise maxResults]`:truncated?`\n[scan stopped early at maxFiles/maxDepth/deadline; narrow with path or raise maxFiles]`:'';return textResult((base.explicit?`searched ${base.dir}\n`:'')+(matches.join('\n')||'No matches')+note);}
 case 'file_search': case 'find_files': {const q=String(args.query??args.name??'').toLowerCase();if(!q)throw new Error('file_query_required');const base=await searchBase(args,getRoot,argPath,any);const {items,truncated,missing}=await walk(base.dir,{maxFiles:clamp(args.maxFiles??3000,1,20000),maxDepth:clamp(args.maxDepth??12,0,64),displayRoot:base.display,includeIgnored:args.includeIgnored===true});const limit=clamp(args.maxResults??200,1,2000);const found=items.filter(x=>x.name.toLowerCase().includes(q));const note=missing?`\n[path not found: ${base.dir}]`:found.length>limit?`\n[truncated: showing ${limit} of ${found.length} matches]`:truncated?`\n[scan stopped early at maxFiles/maxDepth/deadline]`:'';return textResult((base.explicit?`searched ${base.dir}\n`:'')+(found.slice(0,limit).map(x=>`${x.isDirectory?'dir':'file'}\t${x.relative}`).join('\n')||'No files found')+note);}
 case 'view_symbol': case 'code_graph': {const symbol=String(args.symbol??args.name??'');if(!symbol)throw new Error('symbol_required');const re=new RegExp(`(?:function\\s+${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\b|class\\s+${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\b|(?:const|let|var)\\s+${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\s*=|${symbol.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\s*\\()`, 'g');const base=await searchBase(args,getRoot,argPath,any);const {items,truncated,missing}=await walk(base.dir,{maxFiles:clamp(args.maxFiles??2000,1,20000),maxDepth:clamp(args.maxDepth??12,0,64),displayRoot:base.display,includeIgnored:args.includeIgnored===true});const files=items.filter(x=>!x.isDirectory);const limit=clamp(args.maxResults??100,1,1000);const out=[];for(const f of files){let s;try{s=await fs.readFile(f.path,'utf8')}catch{continue}if(s.includes('\u0000'))continue;for(const m of s.matchAll(re)){const line=s.slice(0,m.index).split('\n').length;out.push(`${f.relative}:${line}:${s.split('\n')[line-1]?.trim().slice(0,300)}`);if(out.length>=limit)break}if(out.length>=limit)break}const note=missing?`\n[path not found: ${base.dir}]`:out.length>=limit?`\n[truncated at ${limit} references]`:truncated?`\n[scan stopped early at maxFiles/maxDepth/deadline]`:'';return textResult((base.explicit?`searched ${base.dir}\n`:'')+(out.join('\n')||`No references found for ${symbol}`)+note);}
 case 'git_status': case 'git_diff': {const workspace=getRoot();const argv=tool==='git_status'?['git','status','--short','--branch']:['git','diff','--no-ext-diff','--',...(args.path?[path.relative(workspace,argPath(args.path))]:[])];const result=await run(argv,workspace,{timeoutMs:15000});return textResult(JSON.stringify(result));}
 case 'undo': case 'revert_file': {if(args.confirm!==true)throw new Error('revert_confirmation_required');const workspace=getRoot();const p=argPath(args.path);const rel=path.relative(workspace,p);const result=await run(['git','restore','--worktree','--',rel],workspace,{timeoutMs:15000});if(result.exitCode!==0)throw new Error('git_restore_failed');return textResult(`Restored tracked file from index: ${rel}`);}
 case 'run_terminal_command': case 'execute_bash': {const workspace=getRoot();const lexicalCwd=safePath(workspace,args.cwd||'.',any);const cwd=await fs.realpath(lexicalCwd);if(!any&&!within(workspace,cwd))throw new Error('execution_path_symlink_escape');const argv=Array.isArray(args.argv)?args.argv:(typeof args.command==='string'?args.command.trim().split(/\s+/):null);if(!argv?.length)throw new Error('argv_required');const result=await run(argv,cwd,{timeoutMs:clamp(args.timeoutMs??30000,100,120000),backgroundMode:args.background===true,allowAnyCommand:anyCommand(ctx)});return textResult(JSON.stringify(result));}
 case 'kill_process': {const key=String(args.processId??'');const proc=background.get(key);if(!proc)throw new Error('managed_process_not_found');proc.kill('SIGTERM');background.delete(key);return textResult(`Termination requested for managed process ${key}`);}
 case 'task_planner': {const tasks=Array.isArray(args.tasks)?args.tasks.map((x,i)=>({id:i+1,task:String(x).slice(0,500),status:'pending'})):String(args.goal??'').split(/\n|(?<=[.!?])\s+/).map(x=>x.trim()).filter(Boolean).map((task,i)=>({id:i+1,task:task.slice(0,500),status:'pending'}));return textResult(JSON.stringify({goal:String(args.goal??''),tasks,warning:'Plan only; no tasks were executed.'}));}
 case 'todo_manager': {const dir=path.join(getRoot(),'.zombiecoder');const p=path.join(dir,'tasks.json');try{const st=await fs.lstat(dir);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('todo_directory_not_safe')}catch(e){if(e.code!=='ENOENT')throw e;await fs.mkdir(dir,{recursive:true})}let tasks=[];try{tasks=JSON.parse(await fs.readFile(p,'utf8'));if(!Array.isArray(tasks))tasks=[]}catch{};const action=String(args.action??'list');if(action==='list')return textResult(JSON.stringify(tasks));if(action==='add'){if(!args.task)throw new Error('task_required');tasks.push({id:randomUUID(),task:String(args.task).slice(0,500),status:'pending',createdAt:new Date().toISOString()})}else if(action==='complete'||action==='remove'){const i=tasks.findIndex(t=>t.id===args.id);if(i<0)throw new Error('todo_not_found');if(action==='complete')tasks[i].status='completed';else tasks.splice(i,1)}else throw new Error('todo_action_invalid');await fs.writeFile(p,JSON.stringify(tasks,null,2)+'\n','utf8');return textResult(JSON.stringify(tasks));}
 default: throw new Error(`native_tool_not_implemented:${tool}`);
 }
}
