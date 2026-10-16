import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract, createExecutionPlan, requireConsent } from '../src/execution/contract.js';
import { ExecutionOrchestrator } from '../src/execution/orchestrator.js';

test('execution contract requires a goal and stays non-executing', () => {
  assert.throws(() => createGoalContract({}), /goal_required/);
  const c=createGoalContract({goal:'inspect project',expectedOutcome:'evidence collected'});
  const p=createExecutionPlan(c,[{description:'read files',risk:'low'}]);
  assert.equal(p.executionStatus,'not_started');
});

test('consent is an explicit boundary', () => {
  const c=createGoalContract({goal:'change configuration'});
  const p=createExecutionPlan(c,[{description:'modify config',risk:'high'}]);
  assert.equal(requireConsent(p).allowed,false);
  assert.equal(requireConsent(p,{granted:true}).allowed,true);
});

test('orchestrator prepare never executes', async () => {
  const o=new ExecutionOrchestrator();
  const r=await o.prepare({goal:'review code',consent:false});
  assert.equal(r.execution.status,'not_started');
  assert.equal(r.consent.status,'consent_required');
  const disconnected = new ExecutionOrchestrator();
  await assert.rejects(() => disconnected.execute(), /execution_adapter_not_connected/);
});
