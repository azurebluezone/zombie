import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPolicy, resolveTaskProfile } from '../src/execution/task-policy.js';
import { reconciliationReport, RECONCILIATION_DECISIONS } from '../src/compatibility/legacy/reconciliation.js';


test('web research gets only the web-search surface', () => {
  const policy = buildTaskPolicy({goal:'search the web for current documentation', toolIds:['web_search','read_file','write_file','exec']});
  assert.equal(policy.profileId, 'web_research');
  assert.deepEqual(policy.effectiveToolIds, ['web_search']);
  assert.deepEqual(policy.deniedRequestedTools, ['read_file','write_file','exec']);
  assert.equal(policy.evidence.requireSource, true);
});

test('file-line requests require a locator and only file evidence tools', () => {
  const policy = buildTaskPolicy({goal:'answer with the exact file path and line number', toolIds:['read_file','web_search','exec']});
  assert.equal(policy.profileId, 'file_evidence');
  assert.deepEqual(policy.effectiveToolIds, ['read_file']);
  assert.equal(policy.evidence.requireLocator, true);
});

test('compile profile requires explicit consent and execution evidence', () => {
  const policy = buildTaskPolicy({goal:'run tests and compile the project', toolIds:['read_file','exec','compiler_check','web_search']});
  assert.equal(policy.profileId, 'compile_verify');
  assert.equal(policy.consentRequired, true);
  assert.deepEqual(policy.effectiveToolIds, ['read_file','exec','compiler_check']);
  assert.equal(policy.verification, 'execution_and_test_evidence');
});

test('workspace writes are scoped as a task purpose, not a generic chat capability', () => {
  const profile = resolveTaskProfile({goal:'create a file for this project'});
  assert.equal(profile.id, 'workspace_write');
  assert.equal(profile.consentRequired, true);
});

test('legacy reconciliation is decisioned by purpose and does not claim parity', () => {
  const report = reconciliationReport();
  assert.equal(report.behaviorParityVerified, false);
  assert.ok(report.counts[RECONCILIATION_DECISIONS.MERGE] > 0);
  assert.ok(report.items.some(x => x.id === 'anti-dote.type-safety' && x.decision === 'MERGE'));
  assert.ok(report.items.some(x => x.id === 'web-function' && x.decision === 'REPLACE'));
  assert.ok(report.items.some(x => x.id === 'legacy-git-downloader' && x.decision === 'BLOCK'));
});
