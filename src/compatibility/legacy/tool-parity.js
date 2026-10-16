/**
 * Source-derived legacy tool inventory. This is a migration ledger, not a claim
 * that similarly named runtime tools already have behavioral parity.
 */
export const LEGACY_TOOL_INVENTORY = Object.freeze([
  {id:'read_file', legacyName:'read_file', legacySource:'api.js MCP_TOOLS + executeMcpTool switch (extracted api.zip)', category:'filesystem', runtimeId:'read_file', status:'compatibility-contract-tested-security-hardened', compatibilityContractTested:true, securityDifference:'Runtime enforces project-root containment; legacy api.js defaults AGENT_FS_SCOPE to unrestricted.' , parityEvidence:'Phase 41 tests compare text envelope, missing/non-file handling, 100000-character cap and root boundary.'},
  {id:'write_file', legacyName:'write_file', legacySource:'api.js MCP_TOOLS + executeMcpTool switch (extracted api.zip)', category:'filesystem', runtimeId:'write_file', status:'compatibility-contract-tested-security-hardened', compatibilityContractTested:true, securityDifference:'Runtime enforces project-root containment; legacy api.js defaults AGENT_FS_SCOPE to unrestricted.', parityEvidence:'Phase 41 tests compare MCP text envelope, recursive parent creation and legacy string-length message.'},
  {id:'list_directory', legacyName:'list_directory', legacySource:'api.js MCP_TOOLS + executeMcpTool switch (extracted api.zip)', category:'filesystem', runtimeId:'list_directory', status:'compatibility-contract-tested-security-hardened', compatibilityContractTested:true, securityDifference:'Runtime enforces project-root containment; legacy api.js defaults AGENT_FS_SCOPE to unrestricted.', parityEvidence:'Phase 41 tests compare text listing, directory slash suffixes and missing/not-directory handling.'},
  {id:'public_api', legacyName:'public-api-mcp', legacySource:'external mcp/public-api-mcp.js', category:'external-mcp', runtimeId:'public_api', status:'declared-unverified'},
  {id:'facebook_ads', legacyName:'facebook-ads-mcp', legacySource:'external mcp/facebook-ads-mcp.js', category:'external-mcp', runtimeId:'facebook_ads', status:'declared-unverified'},
  {id:'ocr', legacyName:'ocr-mcp', legacySource:'external mcp/ocr-mcp.js', category:'external-mcp', runtimeId:'ocr', status:'declared-unverified'},
  {id:'tts', legacyName:'tts-mcp', legacySource:'external mcp/tts-mcp.js', category:'external-mcp', runtimeId:'tts', status:'declared-unverified'},
  {id:'screen_recorder', legacyName:'screen-recorder-mcp', legacySource:'external mcp/screen-recorder-mcp.js', category:'external-mcp', runtimeId:null, status:'not-migrated'},
  {id:'skill_mcp_tool', legacyName:'skill-mcp-tool', legacySource:'external mcp/skill-mcp-tool.js', category:'skills', runtimeId:null, status:'partial-registry-only'},
  {id:'combined_external_mcp', legacyName:'combined', legacySource:'external mcp/combined.js', category:'external-mcp-composition', runtimeId:null, status:'not-migrated'}
]);

export function toolParityReport(runtimeTools=[]) {
  const byId=new Map(runtimeTools.map(tool=>[tool.id,tool]));
  const items=LEGACY_TOOL_INVENTORY.map(item=>{
    const runtime= item.runtimeId ? byId.get(item.runtimeId) : null;
    let status=item.status;
    if(item.runtimeId && !runtime) status='missing-runtime-registration';
    if(runtime && runtime.status==='UNVERIFIED' && item.status==='runtime-present-parity-unverified') status='runtime-present-parity-unverified';
    if(runtime && item.status==='declared-unverified') status=runtime.status==='UNVERIFIED'?'declared-unverified':'runtime-present-parity-unverified';
    return {...item,runtimeRegistered:Boolean(runtime),runtimeStatus:runtime?.status??null,compatibilityContractTested:item.compatibilityContractTested===true,behaviorParityVerified:false};
  });
  const counts={}; for(const item of items) counts[item.status]=(counts[item.status]??0)+1;
  return {source:'extracted legacy api.zip api.js plus legacy project file inventory',behaviorParityVerified:false,compatibilityContractTested:items.some(item=>item.compatibilityContractTested),counts,items};
}
