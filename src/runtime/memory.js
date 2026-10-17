/**
 * Memory reporting for the runtime log.
 *
 * A runtime that nobody measures is a runtime that dies at 3 a.m. with "JavaScript heap out
 * of memory" and leaves no history to explain it. This keeps a cheap, bounded record: one
 * snapshot at startup and one every interval, written as the `runtime.memory` event, plus
 * the same snapshot on demand for `/v1/admin/metrics`.
 *
 * `process.memoryUsage()` is the source of truth. Nothing here estimates, samples or
 * smooths — an operator needs the number, not a trend line drawn from invented data.
 *
 * The bytes are reported alongside the megabytes because bytes are what code compares and
 * megabytes are what a human reads.
 */

const MB = 1024 * 1024;

const toMb = (bytes) => Math.round((Number(bytes) || 0) / MB * 10) / 10;

/**
 * One snapshot. Never throws: a runtime must not fall over because a diagnostic failed.
 */
export function memorySnapshot() {
  let usage = {};
  try {
    usage = process.memoryUsage() ?? {};
  } catch {
    usage = {};
  }

  const rss = Number(usage.rss) || 0;
  const heapTotal = Number(usage.heapTotal) || 0;
  const heapUsed = Number(usage.heapUsed) || 0;
  const external = Number(usage.external) || 0;
  const arrayBuffers = Number(usage.arrayBuffers) || 0;

  return {
    rssBytes: rss,
    heapTotalBytes: heapTotal,
    heapUsedBytes: heapUsed,
    externalBytes: external,
    arrayBuffersBytes: arrayBuffers,
    // `null`, not 0, when the denominator is missing — "unknown" and "empty" are different.
    heapUsedPct: heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 1000) / 10 : null,
    rssMb: toMb(rss),
    heapUsedMb: toMb(heapUsed),
    heapTotalMb: toMb(heapTotal),
    externalMb: toMb(external),
    uptimeSeconds: Math.round(Number(process.uptime()) || 0)
  };
}

/**
 * Write `runtime.memory` once now, then every `intervalMs` until `stop()` is called.
 *
 * `intervalMs <= 0` disables the interval but still records the startup snapshot, so an
 * operator can turn the noise off without losing the baseline.
 *
 * `label` names the first write, so the startup line is distinguishable from the periodic
 * ones in a log tail.
 */
export function startMemoryMonitor({ logger = null, intervalMs = 60000, label = 'startup' } = {}) {
  const write = (phase) => {
    if (!logger || typeof logger.info !== 'function') return;
    try {
      const pending = logger.info('runtime.memory', { phase, ...memorySnapshot() });
      // The logger chains writes; a rejected chain must not surface as an unhandled
      // rejection in the middle of serving a request.
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* reporting memory must never be the reason the runtime stops */
    }
  };

  write(label);

  const every = Number(intervalMs);
  let timer = null;
  if (Number.isFinite(every) && every > 0) {
    timer = setInterval(() => write('interval'), every);
    // A metrics timer must never hold the process open, and must never delay an exit.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    snapshot: memorySnapshot,
    log: write,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
