import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { assertSafeMcpUrl } from './security.js';
import { protectOutbound } from '../network/circuit-breaker.js';
import { RUNTIME_VERSION, RUNTIME_USER_AGENT } from '../runtime/version.js';

// MCP protocol versions this runtime can speak, newest first. The client requests
// the newest one during `initialize`; a server that answers with an older version
// is honoured (the spec tells the client to keep the server's version in
// MCP-Protocol-Version), but a version we do not implement must fail closed
// instead of silently talking a protocol we cannot parse.
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
const MAX_RESPONSE_BYTES = 2_000_000;

function stableCode(value, fallback='mcp_remote_error') {
  const code=String(value??'').trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g,'_').slice(0,80);
  return code || fallback;
}
function parseJson(raw) {
  try { return JSON.parse(raw); } catch { throw new Error('mcp_invalid_response'); }
}
function parseSse(raw, expectedId) {
  const events=[];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* ignore non-JSON keepalives; final validation below fails closed */ }
  }
  if (!events.length) throw new Error('mcp_empty_sse');
  const matching=expectedId===undefined ? null : events.find(event=>String(event?.id)===String(expectedId));
  if (expectedId!==undefined && !matching && events.some(event=>event?.id!==undefined)) throw new Error('mcp_response_id_mismatch');
  const response=matching ?? events.filter(event=>event?.jsonrpc==='2.0' && (event.id!==undefined || event.error)).at(-1);
  if (!response) throw new Error('mcp_response_id_not_found');
  return response;
}
function parseResponse(raw, contentType, expectedId) {
  if (String(contentType).toLowerCase().includes('text/event-stream')) return parseSse(raw, expectedId);
  const parsed=parseJson(raw);
  if (expectedId!==undefined && parsed?.id!==undefined && String(parsed.id)!==String(expectedId)) throw new Error('mcp_response_id_mismatch');
  return parsed;
}

async function postJson(url, payload, {timeoutMs=10000,sessionId,lookup,protocolVersion=LATEST_MCP_PROTOCOL_VERSION,notification=false,extraHeaders={}}={}) {
  return protectOutbound(url, () => new Promise((resolve,reject)=>{
    const target=new URL(url);
    if(!['https:','http:'].includes(target.protocol)) return reject(new Error('mcp_protocol_forbidden'));
    const request=target.protocol==='https:'?httpsRequest:httpRequest;
    const headers={'content-type':'application/json','accept':'application/json, text/event-stream','user-agent':RUNTIME_USER_AGENT,'mcp-protocol-version':protocolVersion};
    if(sessionId) headers['mcp-session-id']=sessionId;
    for (const [key, value] of Object.entries(extraHeaders ?? {})) if (value != null) headers[key]=String(value);
    const req=request(target,{method:'POST',timeout:timeoutMs,headers,lookup},res=>{
      let raw='';let bytes=0;res.setEncoding('utf8');
      res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>MAX_RESPONSE_BYTES){req.destroy(new Error('mcp_response_too_large'));return;}raw+=chunk;});
      res.on('end',()=>{
        const returnedSessionId=res.headers['mcp-session-id']??sessionId??null;
        if(notification && [200,202,204].includes(res.statusCode) && !raw.trim()) return resolve({body:null,sessionId:returnedSessionId,protocolVersion:res.headers['mcp-protocol-version']??protocolVersion,statusCode:res.statusCode});
        if(res.statusCode<200||res.statusCode>=300){const error=new Error(`mcp_http_${res.statusCode}`);error.statusCode=res.statusCode;error.mcpCode=`mcp_http_${res.statusCode}`;return reject(error);}
        if(notification && !raw.trim()) return resolve({body:null,sessionId:returnedSessionId,protocolVersion:res.headers['mcp-protocol-version']??protocolVersion,statusCode:res.statusCode});
        try {
          const response=parseResponse(raw,res.headers['content-type']??'',payload?.id);
          resolve({body:response,sessionId:returnedSessionId,protocolVersion:res.headers['mcp-protocol-version']??protocolVersion,statusCode:res.statusCode});
        } catch(error) { reject(error); }
      });
    });
    req.on('timeout',()=>req.destroy(new Error('mcp_timeout')));
    req.on('error',error=>reject(error));
    req.end(JSON.stringify(payload));
  }), {operation:notification?'mcp.notification':'mcp.request'});
}

function assertRpcSuccess(response, stage) {
  if (!response?.body) throw new Error(`mcp_${stage}_empty_response`);
  if (response.body.error) {
    const remoteCode=Number.isFinite(Number(response.body.error.code))?String(Number(response.body.error.code)):'unknown';
    // The upstream JSON-RPC message is the only place the real cause is stated
    // ("path outside allowed roots", "ENOENT ..."), so keep a bounded copy for
    // logs and the admin audit trail instead of collapsing everything into
    // mcp_tool_call_failed with no explanation.
    const remoteMessage=String(response.body.error.message ?? '').replace(/\s+/g,' ').trim().slice(0,240);
    const error=new Error(`mcp_${stage}_failed`); error.mcpCode=stableCode(`mcp_${stage}_failed`); error.remoteCode=remoteCode; if(remoteMessage) error.remoteMessage=remoteMessage; throw error;
  }
  if (response.body.jsonrpc !== '2.0' || response.body.id === undefined || !response.body.result) throw new Error(`mcp_${stage}_invalid_rpc_response`);
  return response.body.result;
}

/**
 * Opens the optional server-to-client SSE channel defined by Streamable HTTP.
 * Initialization is still performed with POST initialize; this GET does not
 * replace the MCP initialize/notifications/initialized handshake.
 * Returns after HTTP headers arrive and keeps the stream open until close().
 */
export async function openMcpEventStream(endpoint, {sessionId,protocolVersion=endpoint.protocolVersion??LATEST_MCP_PROTOCOL_VERSION,onEvent=()=>{},timeoutMs=30000}={}) {
  const safe=await assertSafeMcpUrl(endpoint.url,{...(endpoint.networkPolicy??{}),allowHosts:endpoint.allowHosts??[]});
  return protectOutbound(endpoint.url,()=>new Promise((resolve,reject)=>{
    const target=new URL(endpoint.url);const request=target.protocol==='https:'?httpsRequest:httpRequest;
    const headers={accept:'text/event-stream','user-agent':RUNTIME_USER_AGENT,'mcp-protocol-version':protocolVersion};if(sessionId)headers['mcp-session-id']=sessionId;
    const req=request(target,{method:'GET',headers,lookup:safe.lookup,timeout:timeoutMs},res=>{
      if(res.statusCode!==200||!String(res.headers['content-type']??'').toLowerCase().includes('text/event-stream')){
        res.resume();const error=new Error(`mcp_event_stream_http_${res.statusCode??0}`);error.statusCode=res.statusCode??502;reject(error);return;
      }
      let buffer='';let closed=false;
      const close=()=>{if(closed)return;closed=true;res.destroy();req.destroy();};
      res.setEncoding('utf8');res.on('data',chunk=>{
        buffer+=chunk;
        if(Buffer.byteLength(buffer)>MAX_RESPONSE_BYTES){close();return;}
        let boundary;
        while((boundary=buffer.search(/\r?\n\r?\n/))>=0){
          const block=buffer.slice(0,boundary);const sep=buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];buffer=buffer.slice(boundary+sep.length);
          const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if(!data||data==='[DONE]')continue;
          try{onEvent(JSON.parse(data));}catch{/* Keep the stream alive; callers decide how to report malformed server events. */}
        }
      });
      res.on('error',()=>{});res.on('close',()=>{closed=true;});
      resolve({sessionId:res.headers['mcp-session-id']??sessionId??null,protocolVersion:res.headers['mcp-protocol-version']??protocolVersion,close});
    });
    req.on('timeout',()=>req.destroy(new Error('mcp_timeout')));req.on('error',reject);req.end();
  }),{operation:'mcp.event_stream.get'});
}

export async function discoverMcpTools(endpoint) {
  const safe=await assertSafeMcpUrl(endpoint.url,{...(endpoint.networkPolicy??{}),allowHosts:endpoint.allowHosts??[]});
  const initializeId=`zc-init-${randomUUID()}`;
  const clientDir = String(process.env.MCP_CLIENT_DIR ?? '').trim();
  const extraHeaders = clientDir ? {'x-mcp-client-dir': clientDir} : {};
  const init=await postJson(endpoint.url,{jsonrpc:'2.0',id:initializeId,method:'initialize',params:{protocolVersion:LATEST_MCP_PROTOCOL_VERSION,capabilities:{roots:{listChanged:false}},clientInfo:{name:'zombiecoder-runtime',version:RUNTIME_VERSION}}},{lookup:safe.lookup,protocolVersion:LATEST_MCP_PROTOCOL_VERSION,extraHeaders});
  const initResult=assertRpcSuccess(init,'initialize');
  const requestedVersion=LATEST_MCP_PROTOCOL_VERSION;
  const negotiatedVersion=String(initResult.protocolVersion??init.protocolVersion??requestedVersion);
  if (!MCP_PROTOCOL_VERSIONS.includes(negotiatedVersion)) {
    // Fail closed: we must not continue with a protocol revision we cannot parse.
    const error=new Error(`mcp_protocol_version_unsupported:${negotiatedVersion}`);
    error.mcpCode=`mcp_protocol_version_unsupported:${negotiatedVersion}`;
    error.protocolVersion=negotiatedVersion;
    error.serverInfo=initResult.serverInfo??null;
    throw error;
  }
  const sessionId=init.sessionId??null;
  await postJson(endpoint.url,{jsonrpc:'2.0',method:'notifications/initialized',params:{}},{sessionId,lookup:safe.lookup,protocolVersion:negotiatedVersion,notification:true});
  const listId=`zc-list-${randomUUID()}`;
  const listed=await postJson(endpoint.url,{jsonrpc:'2.0',id:listId,method:'tools/list',params:{}},{sessionId,lookup:safe.lookup,protocolVersion:negotiatedVersion});
  const result=assertRpcSuccess(listed,'tools_list');
  const tools=Array.isArray(result.tools)?result.tools:[];
  return {initialize:init.body,sessionId:listed.sessionId??sessionId,protocolVersion:listed.protocolVersion??negotiatedVersion,requestedProtocolVersion:requestedVersion,versionNegotiated:negotiatedVersion!==requestedVersion,tools};
}

export async function callMcpTool(endpoint,toolName,argumentsValue={}, {sessionId,protocolVersion}={}) {
  const safe=await assertSafeMcpUrl(endpoint.url,{...(endpoint.networkPolicy??{}),allowHosts:endpoint.allowHosts??[]});
  const requestId=`zc-call-${randomUUID()}`;
  const response=await postJson(endpoint.url,{jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:toolName,arguments:argumentsValue}},{sessionId:sessionId??endpoint.sessionId,lookup:safe.lookup,protocolVersion:protocolVersion??endpoint.protocolVersion??LATEST_MCP_PROTOCOL_VERSION});
  return assertRpcSuccess(response,'tool_call');
}
