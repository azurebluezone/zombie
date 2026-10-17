import test from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot, startMemoryMonitor } from '../src/runtime/memory.js';

// Memory reporting exists so that "it died overnight" has a history attached to it. The
// module is small on purpose: `process.memoryUsage()` is the only source of truth, and a
// diagnostic that throws is worse than no diagnostic, so every path here is non-fatal.

const MB = 1024 * 1024;

test('phase68 a snapshot reports heap and RSS in bytes and in MB', () => {
  const snap = memorySnapshot();
  for (const key of ['rssBytes', 'heapTotalBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes']) {
    assert.equal(typeof snap[key], 'number', `${key} must be a number`);
    assert.ok(snap[key] >= 0, `${key} must not be negative`);
  }
  assert.ok(snap.rssBytes > 0, 'a running process has a resident set');
  assert.ok(snap.heapTotalBytes > 0);
  assert.ok(snap.heapUsedBytes > 0);
  assert.ok(snap.heapUsedBytes <= snap.heapTotalBytes, 'used heap cannot exceed the heap total');

  // The MB fields must be derived from the bytes, not reported independently.
  assert.equal(snap.rssMb, Math.round(snap.rssBytes / MB * 10) / 10);
  assert.equal(snap.heapUsedMb, Math.round(snap.heapUsedBytes / MB * 10) / 10);
  assert.equal(snap.heapTotalMb, Math.round(snap.heapTotalBytes / MB * 10) / 10);
  assert.equal(typeof snap.heapUsedPct, 'number');
  assert.ok(snap.heapUsedPct > 0 && snap.heapUsedPct <= 100);
  assert.ok(snap.uptimeSeconds >= 0);
});

test('phase68 the startup snapshot is written once, and is labelled', () => {
  const events = [];
  const logger = { info: (event, fields) => { events.push({ event, fields }); return Promise.resolve(); } };
  const monitor = startMemoryMonitor({ logger, intervalMs: 0 });
  try {
    assert.equal(events.length, 1, 'exactly one startup write');
    assert.equal(events[0].event, 'runtime.memory');
    assert.equal(events[0].fields.phase, 'startup');
    assert.ok(events[0].fields.rssBytes > 0);
    assert.ok(events[0].fields.heapUsedMb > 0);
  } finally {
    monitor.stop();
  }
});

test('phase68 intervalMs=0 keeps the startup line and writes nothing else', async () => {
  const phases = [];
  const logger = { info: (event, fields) => { phases.push(fields.phase); return Promise.resolve(); } };
  const monitor = startMemoryMonitor({ logger, intervalMs: 0, label: 'startup' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(phases, ['startup'], 'no periodic line when the interval is disabled');
  } finally {
    monitor.stop();
  }
});

test('phase68 the interval keeps writing until stop() is called', async () => {
  const phases = [];
  const logger = { info: (event, fields) => { phases.push(fields.phase); return Promise.resolve(); } };
  const monitor = startMemoryMonitor({ logger, intervalMs: 20, label: 'boot' });
  try {
    assert.deepEqual(phases, ['boot']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(phases.length >= 3, `expected at least 3 writes, saw ${phases.length}`);
    assert.ok(phases.slice(1).every((phase) => phase === 'interval'), 'later writes are interval writes');
  } finally {
    monitor.stop();
  }

  const afterStop = phases.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(phases.length, afterStop, 'stop() must end the interval');
});

test('phase68 a missing, silent or broken logger never takes the runtime down', () => {
  assert.doesNotThrow(() => startMemoryMonitor({ intervalMs: 0 }).stop(), 'no logger at all');
  assert.doesNotThrow(() => startMemoryMonitor({ logger: {}, intervalMs: 0 }).stop(), 'logger without info()');
  const throwing = { info() { throw new Error('disk full'); } };
  assert.doesNotThrow(() => startMemoryMonitor({ logger: throwing, intervalMs: 0 }).stop(), 'a throwing logger');
  // A rejected write is swallowed rather than surfacing as an unhandled rejection; node
  // reports an unhandled rejection as a test failure, so this asserts by not failing.
  const rejecting = { info() { return Promise.reject(new Error('write failed')); } };
  assert.doesNotThrow(() => startMemoryMonitor({ logger: rejecting, intervalMs: 0 }).stop(), 'a rejecting logger');
});
