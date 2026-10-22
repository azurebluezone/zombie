#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const outputIndex=args.indexOf('--output');
const outputValue=outputIndex>=0?args[outputIndex+1]:args.find(arg=>arg.startsWith('--output='))?.slice('--output='.length);
if(outputIndex>=0&&!outputValue)throw new Error('build_output_path_required');
const output=path.resolve(root,outputValue??'dist/zombiecoder-runtime');
const relativeOutput=path.relative(root,output);
const outputContainsRoot=path.relative(output,root);
if(!relativeOutput||(!path.isAbsolute(outputContainsRoot)&&outputContainsRoot!=='..'&&!outputContainsRoot.startsWith(`..${path.sep}`)))throw new Error('build_output_must_not_replace_project_root');
const protectedRoots=['src','tools','scripts','tests','data','external-mcp','docs','schemas'];
if(protectedRoots.some(name=>relativeOutput===name||relativeOutput.startsWith(`${name}${path.sep}`)))throw new Error('build_output_inside_source_tree');

const packageMarker='.zombiecoder-build.json';
const stage=path.join(path.dirname(output),`.${path.basename(output)}.tmp-${process.pid}-${randomUUID()}`);
const backup=path.join(path.dirname(output),`.${path.basename(output)}.old-${process.pid}-${randomUUID()}`);
const entries=['start.js','package.json','README.md','CHANGELOG.md','IMPLEMENTATION_MANIFEST.md','.env.example','src','tools','external-mcp','schemas','scripts','docs','integration'];
const excluded=new Set(['.git','.vscode','.env','node_modules','data','logs','tests','dist','build','.zombiecoder','.zombiecoder-runtime.pid']);
async function exists(file){try{return await lstat(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
// A package writes its launcher PID inside its own directory. Replacing that
// directory while the instance is running destroys its .env, database and logs
// mid-flight, so refuse instead of silently breaking a live deployment.
function runningPackagePid(directory){
  try{
    const pid=Number(readFileSync(path.join(directory,'.zombiecoder-runtime.pid'),'utf8').trim());
    if(!Number.isInteger(pid)||pid<2)return null;
    process.kill(pid,0);
    return pid;
  }catch{return null}
}
async function walk(directory,prefix=''){
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.name===packageMarker)continue;
    const full=path.join(directory,entry.name),relative=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory())files.push(...await walk(full,relative));
    else if(entry.isFile())files.push(relative);
  }
  return files;
}

await mkdir(path.dirname(output),{recursive:true});
const existing=await exists(output);
if(existing){
  if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('build_output_not_plain_directory');
  let marker;
  try{marker=JSON.parse(await readFile(path.join(output,packageMarker),'utf8'));}catch{}
  if(marker?.application!=='zombiecoder-runtime-build'||marker.schemaVersion!==1)throw new Error('build_output_exists_and_is_not_managed');
  const livePid=runningPackagePid(output);
  if(livePid)throw new Error(`build_output_in_use_by_running_runtime_stop_it_first_pid_${livePid}`);
}

try{
  await mkdir(stage,{recursive:true});
  for(const entry of entries){
    const source=path.join(root,entry);
    if(!(await exists(source)))continue;
    await cp(source,path.join(stage,entry),{recursive:true,force:true,filter(sourcePath){
      const relative=path.relative(root,sourcePath);
      return !relative.split(path.sep).some(part=>excluded.has(part));
    }});
  }
  const packageJson=JSON.parse(await readFile(path.join(stage,'package.json'),'utf8'));
  const dependencies=Object.keys(packageJson.dependencies??{});
  if(dependencies.length)throw new Error('build_external_dependencies_require_explicit_packaging');
  const files=(await walk(stage)).sort();
  if(!files.includes('src/server.js')||!files.includes('tools/common/read_file.js')||!files.includes('external-mcp/servers.json'))throw new Error('build_runtime_files_missing');
  const invalidState=files.find(file=>/(^|\/)(\.env|data|logs|node_modules|tests|\.git)(\/|$)|\.(sqlite|sqlite-wal|sqlite-shm|db)$/i.test(file));
  if(invalidState)throw new Error(`build_contains_runtime_state:${invalidState}`);
  for(const file of files.filter(name=>/\.(?:mjs|js)$/i.test(name))){
    const check=spawnSync(process.execPath,['--check',path.join(stage,file)],{cwd:stage,encoding:'utf8'});
    if(check.status!==0)throw new Error(`build_syntax_check_failed:${file}:${String(check.stderr||check.stdout).trim().slice(0,300)}`);
  }
  const checksums={};
  for(const file of files)checksums[file]=createHash('sha256').update(await readFile(path.join(stage,file))).digest('hex');
  await writeFile(path.join(stage,packageMarker),JSON.stringify({schemaVersion:1,application:'zombiecoder-runtime-build',version:packageJson.version,nodeRequired:packageJson.engines?.node??'>=22.5.0',dependencies:[],fileCount:files.length,sha256:checksums},null,2)+'\n');
  if(existing)await rename(output,backup);
  await rename(stage,output);
  if(existing)await rm(backup,{recursive:true,force:true});
  console.log(JSON.stringify({output,version:packageJson.version,files:files.length,dependencies:0,syntaxChecks:files.filter(name=>/\.(?:mjs|js)$/i.test(name)).length,verified:true},null,2));
}catch(error){
  await rm(stage,{recursive:true,force:true});
  if(await exists(backup)&&!(await exists(output)))await rename(backup,output);
  throw error;
}
