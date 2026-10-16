import { validateEvidence } from '../context/evidence.js';

const TERMINAL = new Set(['verified','rejected','conflicting','expired']);

export class EvidenceGate {
  constructor({store, maxItems=20}={}) { this.store=store; this.maxItems=maxItems; }
  validate(items=[]) { return items.map(validateEvidence); }
  canClaimSuccess(evidence=[]) {
    const valid=this.validate(evidence);
    return valid.length > 0 && valid.some(x => x.status === 'verified');
  }
  requireVerified(evidence=[], message='verified_evidence_required') {
    if (!this.canClaimSuccess(evidence)) throw new Error(message);
    return true;
  }
  async record({id, contextId=null, source, status, confidence='unknown', summary='', observedAt=new Date().toISOString(), scope=null}={}) {
    const item=validateEvidence({source,status,confidence,summary,observedAt,scope,contextId});
    const list=await this.store.read('evidence',[]);
    const record={id:id ?? `evidence_${Date.now()}`, contextId, ...item};
    const next=[...list.filter(x=>x.id!==record.id),record].slice(-this.maxItems);
    await this.store.write('evidence',next); return record;
  }
  static isTerminal(status){ return TERMINAL.has(status); }
}
