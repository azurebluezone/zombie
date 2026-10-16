import { randomUUID } from 'node:crypto';
import { sanitizeSessionMetadata } from './metadata.js';
export class SessionService {
  constructor(store){this.store=store}
  async _save(s){if(typeof this.store.append==='function')await this.store.append('sessions',s);else{const list=await this.store.read('sessions',[]);await this.store.write('sessions',list.map(x=>x.id===s.id?s:x))}return s}
  async create({applicationId,userId=null,metadata={}}={}){if(!applicationId)throw new Error('application_id_required');const now=new Date().toISOString();const session={id:`sess_${randomUUID()}`,applicationId,userId,metadata:sanitizeSessionMetadata(metadata),status:'active',createdAt:now,updatedAt:now};if(typeof this.store.append==='function')await this.store.append('sessions',session);else{const list=await this.store.read('sessions',[]);list.push(session);await this.store.write('sessions',list)}return session}
  async get(id,applicationId){const rows=typeof this.store.findWhere==='function'?await this.store.findWhere('sessions',x=>x.id===id):await this.store.read('sessions',[]);const s=rows.find(x=>x.id===id);if(!s||(applicationId&&s.applicationId!==applicationId))return null;return s}
  async updateMetadata(id,applicationId,metadata={}){const s=await this.get(id,applicationId);if(!s)return null;s.metadata={...(s.metadata||{}),...sanitizeSessionMetadata(metadata)};s.updatedAt=new Date().toISOString();return this._save(s)}
  async touch(id,applicationId){const s=await this.get(id,applicationId);if(!s)return null;s.updatedAt=new Date().toISOString();return this._save(s)}
  async close(id,applicationId){const s=await this.get(id,applicationId);if(!s)return null;s.status='closed';s.updatedAt=new Date().toISOString();return this._save(s)}
}
