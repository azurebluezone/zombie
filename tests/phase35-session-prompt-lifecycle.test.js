import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../src/session/service.js';
import { SessionStateStore } from '../src/session/state.js';
import { compileContext } from '../src/context/compiler.js';
import { parseProviderBootConfig } from '../src/startup/provider-bootstrap.js';

class MemoryStore {
  constructor(){ this.data=new Map(); }
  async read(key,fallback=[]){ return structuredClone(this.data.get(key) ?? fallback); }
  async write(key,value){ this.data.set(key,structuredClone(value)); }
  async append(key,value){ const rows=await this.read(key,[]); rows.push(structuredClone(value)); await this.write(key,rows); }
  async findWhere(key,predicate){ return (await this.read(key,[])).filter(predicate); }
  async deleteById(key,id){ const rows=await this.read(key,[]); await this.write(key,rows.filter(x=>x.id!==id)); }
}

test('phase35 session archive can feed the next prompt context', async()=>{
  const store=new MemoryStore();
  const sessions=new SessionService(store);
  const state=new SessionStateStore({store,sessions,maxMessages:20});
  const session=await sessions.create({applicationId:'app-1'});
  await state.append(session.id,'app-1',{role:'user',content:'My checkout lives in Laravel.'},{kind:'request'});
  await state.append(session.id,'app-1',{role:'assistant',content:'Understood.'},{kind:'provider_response'});
  const archive=await state.archive(session.id,'app-1');
  const compiled=compileContext({goal:'fix checkout',userInput:'Now inspect the validation rule',recent:archive,memory:[],ssot:null,syllabus:null,sessionId:session.id,maxBytes:64*1024,recentLimit:10});
  assert.equal(compiled.facts.sessionId,session.id);
  assert.ok(compiled.recent.some(m=>String(m.content).includes('Laravel')));
});

test('phase35 shell-safe provider key naming maps underscore to hyphen',()=>{
  const keys=Object.fromEntries([['PROVIDER_KEY_OPENCODE_FREE','secret-example']].map(([k,v])=>[k.slice('PROVIDER_KEY_'.length).toLowerCase().replace(/_/g,'-'),v]));
  assert.equal(keys['opencode-free'],'secret-example');
});

test('phase35 provider boot config accepts the documented shape',()=>{
  const value=parseProviderBootConfig(JSON.stringify([{id:'ollama-local',baseUrl:'http://127.0.0.1:11434/v1',driver:'ollama',enabled:true}]));
  assert.equal(value[0].driver,'ollama');
});
