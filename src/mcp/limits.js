export class AppLimits {
  constructor({windowMs=60000,maxRequests=60,maxConcurrent=4}={}) { this.windowMs=windowMs; this.maxRequests=maxRequests; this.maxConcurrent=maxConcurrent; this.state=new Map(); }
  acquire(appId){ const now=Date.now(); let s=this.state.get(appId); if(!s||now-s.started>=this.windowMs) s={started:now,count:0,concurrent:0}; if(s.count>=this.maxRequests) throw new Error('application_rate_limited'); if(s.concurrent>=this.maxConcurrent) throw new Error('application_concurrency_limited'); s.count++; s.concurrent++; this.state.set(appId,s); let released=false; return ()=>{if(released)return;released=true;s.concurrent=Math.max(0,s.concurrent-1);}; }
}
