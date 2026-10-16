import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { maskEvidenceForPublic, maskEvidenceSource, maskRouteForPublic, ZOMBIE_PROVIDER_NAME } from '../src/providers/masking/provider-mask.js';

test('phase50 provider evidence source is masked on the public surface', () => {
  assert.equal(maskEvidenceSource('provider:ollama-local'), `provider:${ZOMBIE_PROVIDER_NAME}`);
  assert.equal(maskEvidenceSource('provider:gemini'), `provider:${ZOMBIE_PROVIDER_NAME}`);
  // Tool provenance is not provider identity and must stay intact.
  assert.equal(maskEvidenceSource('tool:create_file'), 'tool:create_file');
  assert.equal(maskEvidenceSource(null), '');
});

test('phase50 maskEvidenceForPublic masks every item and never mutates the input', () => {
  const internal = [
    { source: 'provider:ollama-local', status: 'observed', summary: 'upstream response' },
    { source: 'tool:create_file', status: 'observed', summary: 'tool result' }
  ];
  const frozen = JSON.parse(JSON.stringify(internal));
  const masked = maskEvidenceForPublic(internal);
  assert.deepEqual(internal, frozen, 'internal evidence must stay untouched');
  assert.equal(masked[0].source, `provider:${ZOMBIE_PROVIDER_NAME}`);
  assert.equal(masked[1].source, 'tool:create_file');
  assert.equal(maskEvidenceForPublic(null), null);
});

test('phase50 public route summary exposes counts, never the candidate table', () => {
  const internalRoute = {
    routeId: 'route_1',
    providerId: 'ollama-local',
    model: 'qwen2.5:1.5b',
    publicModel: 'zombie-mini',
    requiredCapabilities: ['chat-completions'],
    candidates: [
      { providerId: 'ollama-local', model: 'qwen2.5:1.5b', priority: 1, nativeFunctionCalling: true },
      { providerId: 'gemini', model: 'gemini-2.5-flash', priority: 4, nativeFunctionCalling: true }
    ],
    reason: 'explicit_model_alias',
    status: 'selected'
  };
  const masked = maskRouteForPublic(internalRoute);
  assert.equal(masked.providerId, 'masked');
  assert.equal(masked.model, 'zombie-mini');
  assert.equal(masked.candidateCount, 2);
  assert.equal('candidates' in masked, false);
  const text = JSON.stringify(masked);
  for (const token of ['ollama-local', 'qwen2.5', 'gemini', 'gemini-2.5-flash']) {
    assert.ok(!text.includes(token), `route summary leaked ${token}`);
  }
});

test('phase50 every non-admin client response masks evidence and route metadata', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    if (!/return send\(res,/.test(line)) return;
    const context = lines.slice(Math.max(0, index - 6), index + 1).join('\n');
    if (context.includes('adminOk(req)')) return; // admin surfaces are internal by design
    if (/\bevidence:/.test(line) && !/evidence:maskEvidenceForPublic\(/.test(line)) offenders.push(`unmasked evidence -> ${line.trim().slice(0, 120)}`);
    if (/\bresult:safeResult\b/.test(line)) offenders.push(`unmasked run result -> ${line.trim().slice(0, 120)}`);
    if (/route:await smartRouter\.route/.test(line)) offenders.push(`unmasked route -> ${line.trim().slice(0, 120)}`);
  });
  assert.deepEqual(offenders, [], `client-facing payloads must be masked:\n${offenders.join('\n')}`);
});

test('phase50 legacy unified input binds a system prompt so the route is reachable', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("url.pathname==='/api/input'"));
  const body = handler.slice(0, handler.indexOf('legacyCompatibility:true'));
  assert.ok(body.includes('boundMessages'), 'legacy shim must bind a system prompt when the caller sends none');
  assert.ok(/role:'system'/.test(body), 'legacy shim must inject a system role');
});
