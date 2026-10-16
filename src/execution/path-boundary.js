import path from 'node:path';
import { realpath } from 'node:fs/promises';
function within(root,target){return target===root||target.startsWith(`${root}${path.sep}`)}
export async function resolveExecutionPath(inputPath,{projectRoot,workingDirectory=null,mustExist=false}={}){
  if(!projectRoot)throw new Error('project_root_required');
  const root=await realpath(path.resolve(projectRoot));
  const base=await realpath(path.resolve(workingDirectory||root));
  if(!within(root,base))throw new Error('execution_working_directory_outside_project_root');
  const candidate=path.resolve(base,String(inputPath??''));
  if(!within(root,candidate))throw new Error('execution_path_outside_project_root');
  if(mustExist){const actual=await realpath(candidate);if(!within(root,actual))throw new Error('execution_path_symlink_escape');return actual}
  let probe=candidate;const suffix=[];
  while(true){try{const actual=await realpath(probe);const finalPath=suffix.reverse().reduce((p,part)=>path.join(p,part),actual);if(!within(root,finalPath))throw new Error('execution_path_symlink_escape');return finalPath}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(probe);if(parent===probe)throw new Error('execution_path_invalid');suffix.push(path.basename(probe));probe=parent}}
}
export async function resolveWorkingDirectory(projectRoot,requested=null){return resolveExecutionPath(requested||'.',{projectRoot,workingDirectory:projectRoot,mustExist:true})}
