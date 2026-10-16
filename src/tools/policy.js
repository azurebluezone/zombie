import { randomUUID } from 'node:crypto';

export class ToolPolicy {
  constructor(store, {configResolver=null}={}) { this.store=store; this.configResolver=configResolver; }
  async list(){return this.store.read('tool-permissions',[])}
  async grant({applicationId,toolId}){if(!applicationId||!toolId)throw new Error('application_id_and_tool_required');const list=await this.list();const existing=list.find(x=>x.applicationId===applicationId&&x.toolId===toolId&&x.effect==='allow');if(existing)return existing;const item={id:`toolperm_${randomUUID()}`,applicationId,toolId,effect:'allow',createdAt:new Date().toISOString()};list.push(item);await this.store.write('tool-permissions',list);return item}
  async revoke(applicationId,toolId){const list=await this.list();const next=list.filter(x=>!(x.applicationId===applicationId&&x.toolId===toolId));await this.store.write('tool-permissions',next);return next.length!==list.length}
  async permissionAllowed(applicationId,toolId){const list=await this.list();return list.some(x=>x.applicationId===applicationId&&x.toolId===toolId&&x.effect==='allow')}
  async decision(applicationId,toolId){
    const permission = await this.permissionAllowed(applicationId,toolId);
    const setting = this.configResolver ? await this.configResolver.toolSetting(applicationId,toolId) : {enabled:null,source:'unconfigured'};
    if (setting.enabled === false) return {allowed:false,reason:'tool_disabled_by_configuration',permission,setting};
    if (!permission) return {allowed:false,reason:'tool_not_permitted',permission,setting};
    return {allowed:true,reason:'allowed',permission,setting};
  }
  async allowed(applicationId,toolId){return (await this.decision(applicationId,toolId)).allowed}
}
