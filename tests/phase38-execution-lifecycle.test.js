import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionLifecycle, assertSystemPrompt } from '../src/execution/lifecycle.js';
import { sanitizeSessionMetadata } from '../src/session/metadata.js';

test('phase38: system prompt is mandatory at execution boundary', () => {
  assert.throws(() => assertSystemPrompt([{role:'user',content:'x'}]), /system_prompt_required/);
  const result = assertSystemPrompt([{role:'system',content:'bounded prompt'},{role:'user',content:'x'}]);
  assert.equal(result.present, true);
  assert.ok(result.digest);
});

test('phase38: session metadata accepts lifecycle state but strips unknown fields', () => {
  const result = sanitizeSessionMetadata({executionState:'fallback',lastProvider:'p1',verificationState:'unverified',secret:'no'});
  assert.equal(result.executionState,'fallback');
  assert.equal(result.lastProvider,'p1');
  assert.equal(result.verificationState,'unverified');
  assert.equal(result.secret,undefined);
});

test('phase38: lifecycle records provider observation through evidence gate', async () => {
  const calls=[];
  const lifecycle = new ExecutionLifecycle({
    evidenceGate:{record:async x=>calls.push(x)},
    logger:null,
  });
  const record=await lifecycle.providerObserved({sessionId:'s1',applicationId:'a1',providerId:'p1',model:'m1',canonical:{object:'chat.completion',id:'r1',choices:[{message:{role:'assistant',content:'ok'}}]},evidence:null});
  assert.equal(record.status,'observed');
  assert.equal(calls.length,1);
  assert.equal(calls[0].contextId,'s1');
});


test('phase38: lifecycle fallback updates session metadata', async () => {
  const updates=[];
  const lifecycle = new ExecutionLifecycle({sessions:{updateMetadata:async (...args)=>updates.push(args)}});
  await lifecycle.providerFailure({sessionId:'s1',applicationId:'a1',providerId:'bad',model:'m1',error:new Error('down'),attempt:1,remainingCandidates:1});
  assert.equal(updates[0][2].executionState,'fallback');
  assert.equal(updates[0][2].fallbackRemaining,'1');
});
