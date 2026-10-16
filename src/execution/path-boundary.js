import path from 'node:path';
import { realpath } from 'node:fs/promises';
// `path.sep` is already on the root when the root *is* the separator ('/'), so a
// naive `${root}${path.sep}` would build '//' and reject every real child.
function within(root,target){const base=root.endsWith(path.sep)?root:`${root}${path.sep}`;return target===root||target.startsWith(base)}
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
/**
 * Resolve a declared path with no project-root sandbox.
 *
 * This is the `global` agent scope: the operator has declared the agent may work
 * in any folder, so the only boundary left is the filesystem root of the target.
 * The symlink-escape and must-exist rules still apply, which keeps the resolution
 * honest without inventing a sandbox the operator did not ask for.
 */
export async function resolveAnyPath(inputPath,{workingDirectory=null,mustExist=false}={}){
  const base=path.resolve(workingDirectory||process.cwd());
  const candidate=path.resolve(base,String(inputPath??''));
  const root=path.parse(candidate).root;
  return resolveExecutionPath(candidate,{projectRoot:root,workingDirectory:root,mustExist});
}
export async function resolveWorkingDirectory(projectRoot,requested=null){return resolveExecutionPath(requested||'.',{projectRoot,workingDirectory:projectRoot,mustExist:true})}
