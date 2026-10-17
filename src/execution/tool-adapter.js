import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { validateToolArguments } from '../mcp/schema.js';
import { resolveAnyPath, resolveExecutionPath } from './path-boundary.js';
function executionStatusAllowed(status){return status==='ENABLED'||status==='VERIFIED'}
async function loadTool(entry,toolRoot){const root=await realpath(path.resolve(toolRoot));const file=path.resolve(root,String(entry??''));if(file!==root&&!file.startsWith(`${root}${path.sep}`))throw new Error('tool_entry_outside_tool_root');const actual=await realpath(file);if(actual!==root&&!actual.startsWith(`${root}${path.sep}`))throw new Error('tool_entry_symlink_escape');const module=await import(pathToFileURL(actual).href);const execute=module.execute??module.default;if(typeof execute!=='function')throw new Error('tool_execute_export_required');return execute}
// A declared path is resolved against the project root by default. An agent whose
// persisted scope is `global` has been granted any-folder reach, so its declared
// paths resolve without the project-root sandbox (symlink escape still applies).
async function resolveDeclaredPaths(args,tool,context){const fields=Array.isArray(tool?.metadata?.pathArguments)?tool.metadata.pathArguments.map(String):[];if(!fields.length)return args;const next=structuredClone(args);for(const field of fields){if(typeof next[field]!=='string')continue;const mustExist=tool.metadata?.pathMustExist===true;next[field]=context?.allowAnyPath===true?await resolveAnyPath(next[field],{workingDirectory:context?.workingDirectory,mustExist}):await resolveExecutionPath(next[field],{projectRoot:context?.projectRoot,workingDirectory:context?.workingDirectory,mustExist})}return next}
export class ToolExecutionAdapter {
  constructor({registry,toolRoot='./tools',logger=null,policy=null}={}){this.registry=registry;this.toolRoot=toolRoot;this.logger=logger;this.policy=policy}
  /**
   * Ask the policy, and keep the answer.
   *
   * This used to throw a bare `tool_not_permitted`, which cannot tell "this application
   * was never granted the tool" apart from "an operator switched the tool off" or "the
   * tool is missing from ZOMBIECODER_TOOLS". All three are one-line fixes once you can
   * tell them apart, and all three looked identical from the outside. The public message
   * stays `tool_not_permitted` so the error contract is unchanged; the reason goes to the
   * log and onto the error object.
   */
  async assertPermitted(applicationId,toolId){
    if(!this.policy)return;
    const decision=await this.policy.decision(applicationId,toolId);
    if(decision.allowed)return;
    await this.logger?.warn?.('tool.permission_denied',{toolId,applicationId:applicationId??null,reason:decision.reason,settingSource:decision.setting?.source??null,explicit:decision.setting?.explicit===true});
    const error=new Error('tool_not_permitted');
    error.reason=decision.reason;
    throw error;
  }
  async execute({prepared,input={},applicationId,context}={}){
    if(!prepared?.consent?.allowed)throw new Error('execution_consent_required');if(!prepared?.contract?.goal)throw new Error('execution_contract_required');if(!input.toolId)throw new Error('tool_id_required');
    const tool=await this.registry.resolve(input.toolId);
    await this.assertPermitted(applicationId,tool.id);
    if(!executionStatusAllowed(tool.status))throw new Error('tool_not_enabled_for_execution');if(!tool.entry)throw new Error('tool_entry_required');
    const args=input.arguments??{};const schemaTool=tool.metadata?.toolSchema?{inputSchema:tool.metadata.toolSchema}:null;if(schemaTool)validateToolArguments(schemaTool,args);
    const safeArgs=await resolveDeclaredPaths(args,tool,context);
    await this.logger?.info?.('tool.execution.started',{toolId:tool.id,toolVersion:tool.version,applicationId,requestId:context?.requestId??null});
    const execute=await loadTool(tool.entry,this.toolRoot);
    const result=await execute(safeArgs,{applicationId:applicationId??null,goal:prepared.contract.goal,expectedOutcome:prepared.contract.expectedOutcome,toolId:tool.id,toolVersion:tool.version,executionContext:context??null});
    // applicationId/requestId are part of the started event too: without them a
    // completion cannot be correlated to the caller that triggered it.
    await this.logger?.info?.('tool.execution.completed',{toolId:tool.id,toolVersion:tool.version,status:'completed',applicationId,requestId:context?.requestId??null});
    // Evidence must carry source/status/observedAt: /v1/execution/run validates
    // every item, and the old {type,status:'returned'} shape made the route fail
    // with a 400 after the tool had already executed.
    const evidence={source:`tool:${tool.id}`,status:'observed',confidence:'direct-execution-return',observedAt:new Date().toISOString(),summary:`Tool ${tool.id} returned a result; independent verification is still required`};
    return {status:'completed',target:'tool',toolId:tool.id,toolVersion:tool.version,result,evidence:[evidence]};
  }
}
