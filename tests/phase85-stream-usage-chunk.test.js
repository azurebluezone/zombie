import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalResponseNormalizer, hasCanonicalChoices } from '../src/providers/normalizer/canonical-response.js';

test('phase85 a usage-only stream event carries no canonical choices', () => {
  assert.equal(hasCanonicalChoices({choices: []}), false);
  assert.equal(hasCanonicalChoices({}), false);
  assert.equal(hasCanonicalChoices({choices: [{delta: {content: 'OK'}}]}), true);
});

test('phase85 the normalizer still rejects an empty completion', () => {
  const normalizer = new CanonicalResponseNormalizer();
  const usageOnly = {choices: [], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}};
  assert.equal(hasCanonicalChoices(usageOnly), false);
  assert.throws(
    () => normalizer.normalize(usageOnly, {model: 'm', providerId: 'p'}),
    /provider_response_empty_choices/
  );
});
