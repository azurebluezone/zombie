import { id } from '../core/ids.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export class McpConnections {
  constructor(store, {leaseMs=DEFAULT_LEASE_MS}={}) { this.store=store; this.leaseMs=leaseMs; }
  async list() { return this.store.read('mcp-connections', []); }
  async upsert(input={}) {
    const runtimeId=String(input.runtimeId??'').trim();
    const clientId=String(input.clientId??'').trim();
    if(!runtimeId || !clientId) throw new Error('runtime_id_and_client_id_required');
    const now=new Date().toISOString(); const list=await this.list();
    const existing=list.find(x => x.connectionId===input.connectionId) || list.find(x => x.runtimeId===runtimeId && x.clientId===clientId && x.status==='active');
    const connectionId=String(existing?.connectionId || input.connectionId || id('conn'));
    const sessionId=String(input.sessionId || existing?.sessionId || id('sess'));
    const leaseMs=Math.max(1000,Number(input.leaseMs||this.leaseMs));
    const item={...(existing||{}), id:connectionId, runtimeId,clientId,connectionId,sessionId,status:'active',lastSeenAt:now,leaseExpiresAt:new Date(Date.now()+leaseMs).toISOString(),updatedAt:now,createdAt:existing?.createdAt||now,endpointId:input.endpointId??existing?.endpointId??null};
    const next=existing?list.map(x=>x.connectionId===connectionId?item:x):[...list,item]; await this.store.write('mcp-connections',next); return item;
  }
  async resolve(input={}) {
    const list=await this.list(); const now=Date.now();
    const found=list.find(x => (input.connectionId && x.connectionId===input.connectionId) || (input.sessionId && x.sessionId===input.sessionId) || (input.runtimeId && input.clientId && x.runtimeId===input.runtimeId && x.clientId===input.clientId));
    if(!found) return null;
    if(found.leaseExpiresAt && Date.parse(found.leaseExpiresAt)<=now) {
      await this.expire(found.connectionId); return null;
    }
    return found;
  }
  async touch(connectionId, patch={}) {
    const list=await this.list(); const current=list.find(x=>x.connectionId===connectionId); if(!current) throw new Error('mcp_connection_not_found');
    const now=new Date().toISOString(); const item={...current,...patch,status:'active',lastSeenAt:now,leaseExpiresAt:new Date(Date.now()+Math.max(1000,Number(patch.leaseMs||this.leaseMs))).toISOString(),updatedAt:now};
    await this.store.write('mcp-connections',list.map(x=>x.connectionId===connectionId?item:x)); return item;
  }
  async expire(connectionId) { const list=await this.list(); const now=new Date().toISOString(); const next=list.map(x=>x.connectionId===connectionId?{...x,status:'expired',expiredAt:now,updatedAt:now}:x); await this.store.write('mcp-connections',next); return next.find(x=>x.connectionId===connectionId); }
  async cleanupExpired() { const list=await this.list(); const now=Date.now(); const next=list.map(x=>x.status==='active'&&x.leaseExpiresAt&&Date.parse(x.leaseExpiresAt)<=now?{...x,status:'expired',expiredAt:new Date().toISOString(),updatedAt:new Date().toISOString()}:x); await this.store.write('mcp-connections',next); return next.filter(x=>x.status==='expired').length; }
}
