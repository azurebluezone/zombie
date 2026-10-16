import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSystemPrompt, buildSystemMessage } from '../src/agents/system-prompt.js';
import { SessionService } from '../src/session/service.js';

class MemoryStore {
  constructor(){ this.data=new Map(); }
  async read(k, fallback=[]){ return structuredClone(this.data.get(k) ?? fallback); }
  async write(k,v){ this.data.set(k, structuredClone(v)); }
}

test('phase23 system prompt binds identity, goal, context, evidence and masked provider rules', () => {
  const prompt=buildAgentSystemPrompt({
    constitution:{rules:['Never fabricate evidence.']},
    agent:{id:'code-guru',role:'architecture'},
    persona:{id:'code-guru',name:'Code Guru',role:'architecture'},
    goal:'Fix auth redirect',
    expectedOutcome:'redirect test passes',
    projectRoot:'/tmp/project',
    ssot:{content:'# SSOT\nFramework: Node.js'},
    syllabus:{content:'# Syllabus\nKnown auth issue'},
    memory:[{status:'observed',content:'Previous attempt was unverified'}],
    session:{id:'sess_1',status:'active',metadata:{editor:'vscode',osPlatform:'linux'}},
    route:{requiredCapabilities:['chat_completions','function_calling']},
    tools:['filesystem.read']
  });
  assert.match(prompt,/ZOMBIECODER CORE SYSTEM CONTRACT/);
  assert.match(prompt,/Fix auth redirect/);
  assert.match(prompt,/redirect test passes/);
  assert.match(prompt,/Framework: Node\.js/);
  assert.match(prompt,/Previous attempt was unverified/);
  assert.match(prompt,/provider.*runtime-managed/);
  assert.match(prompt,/Tool availability never implies permission/);
  assert.doesNotMatch(prompt,/gemini|groq|ollama/i);
});

test('phase23 system message is a provider-neutral system role', () => {
  const message=buildSystemMessage({agent:{id:'bug-hunter'},persona:{name:'Bug Hunter'},goal:'Inspect bug'});
  assert.equal(message.role,'system');
  assert.equal(typeof message.content,'string');
  assert.match(message.content,/Inspect bug/);
});

test('phase23 session metadata is application-owned and safely mergeable', async () => {
  const store=new MemoryStore();
  const sessions=new SessionService(store);
  const created=await sessions.create({applicationId:'app_1',metadata:{editor:'vscode'}});
  const updated=await sessions.updateMetadata(created.id,'app_1',{clientVersion:'1.2.3',osPlatform:'linux'});
  assert.deepEqual(updated.metadata,{editor:'vscode',clientVersion:'1.2.3',osPlatform:'linux'});
  assert.equal(await sessions.updateMetadata(created.id,'app_2',{editor:'bad'}),null);
});
