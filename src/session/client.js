export class SessionClient {
  constructor({service}){ this.service=service; }
  async resolve({sessionId, applicationId, createIfMissing=false, userId=null}={}){
    if(sessionId){ const found=await this.service.get(sessionId,applicationId); if(found) return found; if(!createIfMissing) throw new Error('session_not_found'); }
    if(createIfMissing) return this.service.create({applicationId,userId});
    return null;
  }
}
