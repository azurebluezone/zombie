import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_API_FEATURES, FEATURE_STATUS, legacyFeatureReport } from '../../src/compatibility/legacy/feature-registry.js';

test('legacy api inventory has explicit status and modular target for every feature', () => {
  assert.ok(LEGACY_API_FEATURES.length > 0);
  for (const feature of LEGACY_API_FEATURES) {
    assert.ok(feature.id);
    assert.ok(feature.target);
    assert.ok(Object.values(FEATURE_STATUS).includes(feature.status));
  }
});

test('legacy audit never reports behavioral parity as verified', () => {
  const report = legacyFeatureReport();
  assert.equal(report.source, 'api.md');
  assert.equal(report.behaviorParityVerified, false);
  assert.ok(report.warnings.length > 0);
});

test('known legacy websocket and rate-limit capabilities remain visible as warnings', () => {
  const report = legacyFeatureReport();
  const ws = report.features.find(x => x.id === 'transport.websocket');
  const rl = report.features.find(x => x.id === 'route.rate-limit');
  assert.equal(ws.status, FEATURE_STATUS.NOT_IMPLEMENTED);
  assert.equal(rl.status, FEATURE_STATUS.NOT_IMPLEMENTED);
});
