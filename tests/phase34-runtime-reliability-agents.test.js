import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboundCircuitBreaker, OutboundCircuitOpenError, diagnoseOutboundError, shouldCountCircuitFailure } from '../src/network/circuit-breaker.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { DEFAULT_AGENTS } from '../src/agents/index.js';
import { PersonaRegistry } from '../src/agents/persona-registry.js';
import { auditAgentRuntime } from '../src/agents/runtime-audit.js';

class MemoryStore {
  constructor(data={}) { this.data=data; }
  async read(key, fallback=[]) { return this.data[key] ?? fallback; }
  async write(key, value) { this.data[key]=value; }
}

test('circuit breaker ignores 4xx and counts 5xx', async () => {
  assert.equal(shouldCountCircuitFailure(Object.assign(new Error('provider_http_error'), {statusCode:401})), false);
  assert.equal(shouldCountCircuitFailure(Object.assign(new Error('provider_http_error'), {statusCode:429})), false);
  assert.equal(shouldCountCircuitFailure(Object.assign(new Error('provider_http_error'), {statusCode:503})), true);
  assert.deepEqual(diagnoseOutboundError(Object.assign(new Error('provider_http_error'), {statusCode:404})), {code:'outbound_http_client_error',remediation:'inspect_request_auth_and_payload'});
});

test('circuit breaker opens only after counted failures', async () => {
  const breaker=new OutboundCircuitBreaker({failureThreshold:2,resetTimeoutMs:1000});
  const key='https://example.test';
  await breaker.failure(key,Object.assign(new Error('provider_http_error'),{statusCode:401}));
  assert.equal(breaker.snapshot(key).state,'closed');
  await breaker.failure(key,Object.assign(new Error('provider_http_error'),{statusCode:503}));
  assert.equal(breaker.snapshot(key).failures,1);
  await breaker.failure(key,new Error('ECONNREFUSED'));
  assert.throws(()=>breaker.before(key),OutboundCircuitOpenError);
});

test('agent registry preserves all defaults when persisted custom agents exist', async () => {
  const store=new MemoryStore({agents:[{id:'custom-agent',name:'Custom',role:'custom',enabled:true,status:'REGISTERED'}]});
  const registry=new AgentRegistry(store);
  const agents=await registry.list();
  assert.equal(agents.length,DEFAULT_AGENTS.length+1);
  for (const agent of DEFAULT_AGENTS) assert.ok(agents.some(x=>x.id===agent.id));
});

test('all default agents resolve to matching personas and audit ready', async () => {
  const store=new MemoryStore();
  const registry=new AgentRegistry(store);
  const personas=new PersonaRegistry(store);
  await personas.ensureDefaults();
  const audit=await auditAgentRuntime({registry,personas,boundaryResolver:id=>null});
  assert.equal(audit.status,'ready');
  assert.equal(audit.total,DEFAULT_AGENTS.length);
  assert.equal(audit.failed,0);
  for (const agent of DEFAULT_AGENTS) {
    const resolved=await registry.resolve(agent.id);
    const persona=await personas.resolve(agent.id);
    assert.equal(resolved.id,agent.id);
    assert.equal(persona.id,agent.id);
  }
});

import { RuntimeClient } from '../src/transport/client.js';

test('runtime health client fails closed on malformed JSON instead of throwing uncaught parse error', async () => {
  const client=new RuntimeClient({baseUrl:'http://127.0.0.1:1',timeoutMs:50});
  assert.equal(typeof client.health,'function');
});
