import { ComponentRegistry } from '../registry/catalog.js';

// Declared transport surface. The status recorded here is only the *declared*
// state: it is reconciled against observable runtime state by
// syncRuntimeState() once the transport servers have actually been started.
// A transport that is not running must never be reported as VERIFIED.
const DEFAULT_TRANSPORTS = [
  {id:'http', name:'HTTP', version:'1.0.0', capabilities:['request-response'], status:'REGISTERED', source:'runtime-contract'},
  {id:'https', name:'HTTPS', version:'1.0.0', capabilities:['request-response','encrypted-transport'], status:'UNVERIFIED', source:'runtime-contract'},
  {id:'uds', name:'Unix Domain Socket', version:'1.0.0', capabilities:['local-ipc'], status:'UNVERIFIED', source:'runtime-contract'},
  {id:'sse', name:'Server-Sent Events', version:'1.0.0', capabilities:['streaming'], status:'REGISTERED', source:'runtime-contract'},
  {id:'websocket', name:'WebSocket', version:'1.0.0', capabilities:['bidirectional-streaming'], status:'NOT_IMPLEMENTED', source:'legacy-api-feature-inventory'}
];

// Registry entries that a started transport server actually proves.
const RUNTIME_BACKED = {http:'http', https:'https', uds:'uds'};
// SSE is delivered as an HTTP response mode and never binds its own listener, so
// its status is reconciled from the reported mode instead of being left as-is.
const SSE_ID = 'sse';

export class TransportRegistry extends ComponentRegistry {
  constructor(store) {
    super(store, {collection:'transports', type:'transport', defaults:DEFAULT_TRANSPORTS});
  }

  /**
   * Reconciles declared transport status with observable runtime state.
   *   VERIFIED   — the server for this transport is listening right now
   *   BROKEN     — the transport was enabled in config but failed to start
   *   UNVERIFIED — the transport is not intended to run in this deployment
   *   REGISTERED — declared and delivered without a listener of its own (SSE)
   * Transports with no runtime backing at all (e.g. websocket) are left untouched.
   */
  async syncRuntimeState({servers = {}, config = {}, sseMode = null} = {}) {
    const intended = {http:true, https:config?.https?.enabled === true, uds:config?.uds?.enabled === true};
    const current = await this.list();
    let changed = false;
    const now = new Date().toISOString();
    const next = current.map(item => {
      const key = RUNTIME_BACKED[item.id];
      if (!key) {
        if (item.id !== SSE_ID) return item;
        const listening = Boolean(servers[SSE_ID]);
        const status = listening ? 'VERIFIED' : (sseMode ? 'REGISTERED' : 'UNVERIFIED');
        const mode = sseMode ?? null;
        if (item.status === status && item.metadata?.deliveryMode === mode && item.metadata?.runtimeListening === listening) return item;
        changed = true;
        return {...item, status, metadata:{...(item.metadata ?? {}), runtimeListening:listening, deliveryMode:mode, runtimeCheckedAt:now}, updatedAt:now};
      }
      const listening = Boolean(servers[key]);
      const status = listening ? 'VERIFIED' : (intended[key] ? 'BROKEN' : 'UNVERIFIED');
      if (item.status === status && item.metadata?.runtimeListening === listening) return item;
      changed = true;
      return {...item, status, metadata:{...(item.metadata ?? {}), runtimeListening:listening, intendedEnabled:intended[key], runtimeCheckedAt:now}, updatedAt:now};
    });
    if (changed) await this.store.write(this.collection, next);
    return next;
  }
}
