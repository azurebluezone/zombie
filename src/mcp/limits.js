/*
 * Per-application ceilings.
 *
 * The machinery here has always been per-application — the window state is keyed by
 * appId — but the ceiling itself was a single pair of numbers from the environment,
 * so every user shared one budget. That is the wrong shape for the business: a
 * client paying for one shop and a client paying for five are not the same load, and
 * one runaway script should hit its own ceiling rather than everyone's.
 *
 * So the ceiling now resolves per call: the application's own numbers when it has
 * them, the runtime's otherwise. `null` means "unset" and falls through; a number
 * means "this, for this user". Nothing else changes — the same window, the same two
 * error codes, the same release function.
 */
export class AppLimits {
  constructor({windowMs=60000,maxRequests=60,maxConcurrent=4}={}) {
    this.windowMs=windowMs;
    this.maxRequests=maxRequests;
    this.maxConcurrent=maxConcurrent;
    this.state=new Map();
  }

  /**
   * The ceiling that applies to one application.
   * @param {{limits?:{rateLimit?:number|null,concurrency?:number|null}}|null} application
   */
  ceilingFor(application=null) {
    const own=application?.limits ?? null;
    const pick=(value,fallback)=>Number.isInteger(value)&&value>0?value:fallback;
    return {
      maxRequests:pick(own?.rateLimit,this.maxRequests),
      maxConcurrent:pick(own?.concurrency,this.maxConcurrent)
    };
  }

  acquire(appId, application=null){
    const now=Date.now();
    const {maxRequests,maxConcurrent}=this.ceilingFor(application);
    let s=this.state.get(appId);
    if(!s||now-s.started>=this.windowMs) s={started:now,count:0,concurrent:0};
    if(s.count>=maxRequests) throw new Error('application_rate_limited');
    if(s.concurrent>=maxConcurrent) throw new Error('application_concurrency_limited');
    s.count++; s.concurrent++; this.state.set(appId,s);
    let released=false;
    return ()=>{if(released)return;released=true;s.concurrent=Math.max(0,s.concurrent-1);};
  }
}
