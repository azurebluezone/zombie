import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../src/providers/adapters/ollama.js';
import { GeminiProvider } from '../src/providers/adapters/gemini.js';
import { GroqProvider } from '../src/providers/adapters/groq.js';
import { CloudflareProvider } from '../src/providers/adapters/cloudflare.js';
import { CanonicalResponseNormalizer } from '../src/providers/normalizer/canonical-response.js';
import { EvidenceGate } from '../src/evidence/gate.js';
import { SessionService } from '../src/session/service.js';
import { SessionClient } from '../src/session/client.js';
import { AgentRunner } from '../src/agents/runner.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { PersonaRegistry } from '../src/agents/persona-registry.js';

class MemStore { constructor(){this.m=new Map();} async read(k,d=[]){return this.m.get(k) ?? d;} async write(k,v){this.m.set(k,v);} }

test('provider modules expose explicit capabilities without making a network call', () => {
  const ollama = new OllamaProvider({baseUrl:'http://localhost:11434',mode:'native',networkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
  const gemini = new GeminiProvider({apiKey:'configured-only'});
  const groq = new GroqProvider({apiKey:'configured-only'});
  const cloudflare = new CloudflareProvider({baseUrl:'https://api.cloudflare.com/client/v4/accounts/test/ai/v1',apiKey:'configured-only'});
  for (const p of [ollama, gemini, groq, cloudflare]) {
    assert.equal(p.capabilities.streaming, true);
    assert.equal(p.capabilities.functionCalling, true);
  }
});

test('Gemini native response is adapted before canonical normalization', () => {
  const p = new GeminiProvider({defaultModel:'gemini-test'});
  const raw = {candidates:[{content:{parts:[{text:'hello'},{functionCall:{name:'get_weather',args:{city:'Barisal'}}}]},finishReason:'STOP'}]};
  const canonical = new CanonicalResponseNormalizer().normalize(p.toCanonical(raw),{model:'gemini-test',providerId:'gemini'});
  assert.equal(canonical.choices[0].message.content,'hello');
  assert.equal(canonical.choices[0].message.tool_calls[0].function.name,'get_weather');
  assert.deepEqual(JSON.parse(canonical.choices[0].message.tool_calls[0].function.arguments),{city:'Barisal'});
});

test('Ollama native response is adapted before canonical normalization', () => {
  const p = new OllamaProvider({baseUrl:'http://localhost:11434',mode:'native',defaultModel:'llama3.1:8b',networkPolicy:{allowPlaintextHttp:true,allowPrivateNetwork:true}});
  const raw = {model:'llama3.1:8b',message:{role:'assistant',content:'hello'},done:true,done_reason:'stop'};
  const canonical = new CanonicalResponseNormalizer().normalize(p.toCanonical(raw),{model:raw.model,providerId:'ollama-local'});
  assert.equal(canonical.choices[0].message.content,'hello');
  assert.equal(canonical.choices[0].finish_reason,'stop');
});

test('evidence gate distinguishes observed from verified evidence', async () => {
  const store=new MemStore(); const gate=new EvidenceGate({store});
  assert.equal(gate.canClaimSuccess([{source:'tool',status:'observed',observedAt:new Date().toISOString()}]),false);
  const e=await gate.record({source:'test',status:'verified',summary:'direct test evidence'});
  assert.equal(gate.canClaimSuccess([e]),true);
  assert.equal((await store.read('evidence')).length,1);
});

test('session client never accepts a session belonging to another application', async () => {
  const store=new MemStore(); const service=new SessionService(store); const client=new SessionClient({service});
  const created=await service.create({applicationId:'app-a'});
  assert.equal(await client.resolve({sessionId:created.id,applicationId:'app-b'}).catch(e=>e.message),'session_not_found');
  assert.equal((await client.resolve({sessionId:created.id,applicationId:'app-a'})).id,created.id);
});

test('agent runner resolves registered agent and persona without executing tools', async () => {
  const store=new MemStore(); const agents=new AgentRegistry(store); const personas=new PersonaRegistry(store); const gate=new EvidenceGate({store});
  const runner=new AgentRunner({registry:agents,personas,evidenceGate:gate});
  const prepared=await runner.prepare({agentId:'planner',personaId:'planner',goal:'prepare a plan'});
  assert.equal(prepared.agent.id,'planner'); assert.equal(prepared.persona.id,'planner'); assert.equal(prepared.status,'prepared');
  assert.equal(runner.verify({evidence:[{source:'x',status:'observed',observedAt:new Date().toISOString()}]}).verified,false);
});
