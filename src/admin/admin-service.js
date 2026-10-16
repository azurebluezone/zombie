import { createApiKey, hashSecret } from '../auth/application-auth.js';
import { id } from '../core/ids.js';

export class AdminService {
  constructor(store) { this.store=store; }
  async applications() { return this.store.read('applications', []); }
  async createApplication(input={}) {
    const key=createApiKey(); const list=await this.applications();
    const item={id:id('app'),name:String(input.name??'unnamed').slice(0,120),status:'active',expiresAt:input.expiresAt??null,apiKeyHash:hashSecret(key),createdAt:new Date().toISOString(),capabilities:{tools:{}}};
    list.push(item); await this.store.write('applications',list); return {application:{...item,apiKeyHash:undefined},apiKey:key};
  }
  async updateApplication(appId, patch) {
    const list=await this.applications(); const i=list.findIndex(a=>a.id===appId); if(i<0) throw new Error('application_not_found');
    list[i]={...list[i],...patch}; await this.store.write('applications',list); return {...list[i],apiKeyHash:undefined};
  }
  async rotateKey(appId) { const key=createApiKey(); await this.updateApplication(appId,{apiKeyHash:hashSecret(key)}); return {apiKey:key}; }
}
