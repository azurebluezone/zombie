import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fromRoot } from '../runtime/paths.js';

function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
function hostFromUrl(value) {
  try { return normalizeId(new URL(value).hostname); } catch { return ''; }
}
function safeErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? 'external_mcp_registration_failed');
  return /^[a-zA-Z0-9_.:-]{1,100}$/.test(code) ? code : 'external_mcp_registration_failed';
}

/** Bounds one outbound discovery call so a slow or dead endpoint cannot stall startup. */
async function withTimeout(promise, ms, code) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves legacy external-MCP declarations without pretending that a declared
 * server is discovered or healthy. Folder definitions take precedence by ID;
 * conflicting URLs are surfaced rather than silently registered under one ID.
 */
export class ExternalMcpRegistry {
  constructor({store, mcpRegistry, root=fromRoot('external-mcp'), envObject=process.env, logger=null}={}) {
    this.store=store; this.mcpRegistry=mcpRegistry; this.root=root; this.env=envObject; this.logger=logger;
  }
  async folderDefinitions() {
    const file=path.join(this.root,'servers.json');
    if(!existsSync(file)) return [];
    let data;
    try { data=JSON.parse(await readFile(file,'utf8')); }
    catch { throw new Error('external_mcp_manifest_invalid_json'); }
    const list=Array.isArray(data?.servers) ? data.servers : [];
    return list.filter(x=>x && (x.url || x.urlEnv)).map(x=>({
      id:normalizeId(x.id ?? x.name ?? hostFromUrl(x.url)),
      name:String(x.name ?? x.id ?? hostFromUrl(x.url)),
      url:x.url ? String(x.url).trim() : null,
      urlEnv:x.urlEnv ? String(x.urlEnv).trim() : null,
      transport:String(x.transport ?? 'http'),
      caFile:x.caFile ? String(x.caFile) : null,
      rejectUnauthorized:x.rejectUnauthorized === false ? false : null,
      enabled:x.enabled!==false,
      source:'folder',
      legacyEntry:x.legacyEntry ?? null,
      purpose:x.purpose ?? null,
      note:x.note ?? null,
      allowHosts:Array.isArray(x.allowHosts)?x.allowHosts:[],
    }));
  }
  _resolveEnvUrl(definition) {
    if (definition.url) return definition.url;
    if (definition.urlEnv && this.env[definition.urlEnv]) return String(this.env[definition.urlEnv]).trim();
    return null;
  }
  envDefinitions() {
    const result=[];
    const urls=String(this.env.EXTERNAL_MCP_URLS ?? '').split(',').map(x=>x.trim()).filter(Boolean);
    for(const url of urls) result.push({id:hostFromUrl(url),name:hostFromUrl(url),url,transport:'http',enabled:true,source:'environment',allowHosts:[]});
    for(const [key,value] of Object.entries(this.env)) {
      if(key === 'EXTERNAL_MCP_URLS' || !key.startsWith('EXTERNAL_MCP_') || !key.endsWith('_URL') || !value) continue;
      const id=normalizeId(key.slice('EXTERNAL_MCP_'.length,-'_URL'.length));
      if(id) result.push({id,name:id,url:String(value).trim(),transport:'http',enabled:true,source:'environment',allowHosts:[]});
    }
    return result;
  }
  async definitions() {
    const folder = (await this.folderDefinitions()).map(item => ({...item, url:this._resolveEnvUrl(item), configurationSource:item.url ? 'folder' : (item.urlEnv && this.env[item.urlEnv] ? 'environment' : 'unconfigured')}));
    const env = this.envDefinitions();
    const seen = new Map();
    const combined=[];
    for (const item of [...folder,...env]) {
      const prior=seen.get(item.id);
      if (prior) {
        // Preserve both declarations so sync can report a conflict; exact duplicates collapse.
        if (prior.url === item.url && prior.enabled === item.enabled) continue;
        combined.push({...item, declarationConflict:true, conflictingSource:prior.source});
        continue;
      }
      seen.set(item.id,item); combined.push(item);
    }
    return combined;
  }
  async sync({discover=false,discoverTimeoutMs=10000,refreshDiscovered=false}={}) {
    const definitions=await this.definitions();
    const existing=await this.mcpRegistry.list();
    const results=[];
    const idsSeen=new Map();
    const conflictIds=new Set(definitions.filter(x=>x.declarationConflict).map(x=>x.id));
    for(const definition of definitions) {
      if (conflictIds.has(definition.id) || definition.declarationConflict || (idsSeen.has(definition.id) && idsSeen.get(definition.id)!==definition.url)) {
        results.push({id:definition.id,status:'identity_conflict',source:definition.source});
        continue;
      }
      idsSeen.set(definition.id,definition.url);
      if (definition.enabled === false) { results.push({id:definition.id,status:'disabled',source:definition.source}); continue; }
      if (!definition.url) { results.push({id:definition.id,status:'configuration_missing',source:definition.configurationSource ?? definition.source}); continue; }
      const currentById=existing.find(x=>x.id===definition.id);
      const currentByUrl=existing.find(x=>x.url===definition.url);
      if (currentById && currentById.url !== definition.url) {
        results.push({id:definition.id,status:'identity_conflict',source:definition.source}); continue;
      }
      if(currentByUrl && currentByUrl.id !== definition.id) {
        results.push({id:definition.id,status:'url_already_registered',source:definition.source}); continue;
      }
      if(currentById || currentByUrl) { results.push({id:(currentById ?? currentByUrl).id,status:'existing',source:'database'}); continue; }
      try {
        const endpoint=await this.mcpRegistry.register({id:definition.id,url:definition.url,name:definition.name,allowHosts:definition.allowHosts,enabled:definition.enabled,transport:definition.transport,caFile:definition.caFile,rejectUnauthorized:definition.rejectUnauthorized});
        results.push({id:endpoint.id,status:'registered',source:definition.source});
      } catch(error) {
        const code=safeErrorCode(error);
        this.logger?.warn?.('external_mcp_registration_failed',{id:definition.id,code});
        results.push({id:definition.id,status:'error',source:definition.source,error:code});
      }
    }
    // Tool discovery costs one outbound call per endpoint, so it runs
    // sequentially (discover() rewrites the whole endpoint list in a single
    // store write, so parallel runs would clobber each other) and never aborts
    // startup. Without this, a freshly installed or copied build registers its
    // endpoints but reports zero tools until an operator triggers discovery by
    // hand — which makes a portable build look broken on a new machine.
    const discovery=[];
    const discoveryFailures=[];
    if (discover) {
      for (const endpoint of await this.mcpRegistry.list()) {
        if (endpoint.enabled === false || !endpoint.url) continue;
        const alreadyDiscovered = endpoint.status === 'discovered' && Array.isArray(endpoint.tools) && endpoint.tools.length > 0;
        if (alreadyDiscovered && !refreshDiscovered) continue;
        try {
          const updated = await withTimeout(this.mcpRegistry.discover(endpoint.id), discoverTimeoutMs, 'mcp_discovery_timeout');
          discovery.push({id:updated.id,toolCount:Array.isArray(updated.tools)?updated.tools.length:0,protocolVersion:updated.protocolVersion ?? null});
        } catch (error) {
          discoveryFailures.push({id:endpoint.id,error:safeErrorCode(error)});
        }
      }
      if (discovery.length) await this.logger?.info?.('external_mcp.tools_discovered',{endpoints:discovery});
      if (discoveryFailures.length) await this.logger?.warn?.('external_mcp.tools_discovery_failed',{endpoints:discoveryFailures});
    }
    return {folderCount:(await this.folderDefinitions()).length,environmentCount:this.envDefinitions().length,definitions:results,discovery,discoveryFailures};
  }
  async status() {
    const definitions=await this.definitions();
    const endpoints=await this.mcpRegistry.list();
    const seen=new Set();
    return definitions.map(def=>{
      const endpoint=endpoints.find(x=>x.id===def.id || (def.url && x.url===def.url));
      const duplicate=seen.has(def.id); seen.add(def.id);
      const configured=Boolean(endpoint || def.url);
      let status;
      if (duplicate || def.declarationConflict) status='identity_conflict';
      else if (def.enabled===false) status='disabled';
      else status=endpoint?.status ?? (def.url ? 'configuration_only' : 'configuration_missing');
      return {id:def.id,name:def.name,configured,configurationSource:endpoint?'database':(def.configurationSource ?? def.source),url:endpoint?.url ?? def.url ?? null,urlEnv:def.urlEnv ?? null,enabled:endpoint?.enabled !== false && def.enabled !== false,status,tools:Array.isArray(endpoint?.tools)?endpoint.tools.length:0,discoveredAt:endpoint?.discoveredAt ?? null,legacyEntry:def.legacyEntry ?? null,purpose:def.purpose ?? null,note:def.note ?? null,transport:endpoint?.transport ?? def.transport ?? 'http',hasCa:Boolean(endpoint?.ca || endpoint?.caFile),tlsVerificationDisabled:endpoint?.rejectUnauthorized === false};
    });
  }
}
