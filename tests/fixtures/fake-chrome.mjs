#!/usr/bin/env node
/**
 * A protocol-compatible stand-in for Chrome's `--remote-debugging-pipe` channel.
 *
 * The runtime cannot assume a Chrome binary exists — this machine has only Firefox — but
 * the pipe contract can still be verified: this script reads NUL-framed CDP JSON from file
 * descriptor 3 and writes replies to file descriptor 4, exactly as Chrome does. That makes
 * the real code path testable: spawn, fd 3/4 wiring, NUL framing, request/response
 * matching, timeouts, and the error mapping.
 *
 * Behaviour switches, via argv:
 *   --die-immediately   exit before answering anything (startup-failure path)
 *   --die-after-ready   answer Browser.getVersion, then exit (mid-session failure path)
 *   --fail-navigation   answer Page.navigate with errorText (navigation-failure path)
 *   --silent            accept messages and never answer (timeout path)
 *   --no-create-target  refuse Target.createTarget the way Electron does ("Not supported")
 *                       and expose one already-open page target instead
 */

import fs from 'node:fs';

// Chrome's pipe convention: the browser READS fd 3 and WRITES fd 4. The parent therefore
// writes into stdio[3] and reads from stdio[4]. Getting this backwards makes the fixture
// silently mute, which is exactly how it behaved before this line was corrected.
const READ_FD = 3;
const WRITE_FD = 4;
const argv = process.argv.slice(2);
const dieImmediately = argv.includes('--die-immediately');
const dieAfterReady = argv.includes('--die-after-ready');
const failNavigation = argv.includes('--fail-navigation');
const silent = argv.includes('--silent');
const noCreateTarget = argv.includes('--no-create-target');
const noPageTarget = argv.includes('--no-page-target');

if (dieImmediately) {
  process.stderr.write('fake-chrome: dying immediately as requested\n');
  process.exit(3);
}

let buffer = Buffer.alloc(0);
let navigatedUrl = 'about:blank';
let readyAnswered = false;
const seen = [];

function send(message) {
  fs.writeSync(WRITE_FD, Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])]));
}

function reply(id, result) {
  send({ id, result: result ?? {} });
}

function replyError(id, message) {
  send({ id, error: { code: -32000, message } });
}

function evaluate(expression) {
  if (expression === 'document.readyState') return 'complete';
  if (expression === 'location.href') return navigatedUrl;
  if (expression === 'document.title') return 'Fake Page';
  if (expression.includes('outerHTML')) return '<html><body>fake</body></html>';
  if (expression.includes('innerText')) return 'fake body text';
  return null;
}

function handle(message) {
  const { id, method, params = {}, sessionId } = message;
  seen.push({ method, sessionId: sessionId ?? null, params });
  if (silent) return;
  // Deterministic mid-session death: answer the readiness ping, then exit on the very next
  // message instead of replying. A timed exit races the caller and can pass by luck.
  if (dieAfterReady && method !== 'Browser.getVersion') {
    process.exit(4);
  }
  switch (method) {
    case 'Browser.getVersion':
      readyAnswered = true;
      return reply(id, { protocolVersion: '1.3', product: 'FakeChrome/1.0' });
    case 'Target.createTarget':
      if (noCreateTarget) return replyError(id, 'Not supported');
      return reply(id, { targetId: 'fake-target-1' });
    case 'Target.getTargets':
      return reply(id, {
        targetInfos: noPageTarget
          ? []
          : noCreateTarget
            ? [{ targetId: 'fake-existing-page', type: 'page', url: 'about:blank', attached: false }]
            : [{ targetId: 'fake-target-1', type: 'page', url: 'about:blank', attached: true }]
      });
    case 'Target.attachToTarget':
      return reply(id, { sessionId: 'fake-session-1' });
    case 'Target.closeTarget':
      return reply(id, { success: true });
    case 'Page.enable':
    case 'Runtime.enable':
      return reply(id, {});
    case 'Page.navigate':
      if (failNavigation) return reply(id, { errorText: 'net::ERR_NAME_NOT_RESOLVED' });
      navigatedUrl = params.url ?? navigatedUrl;
      return reply(id, { frameId: 'fake-frame-1' });
    case 'Runtime.evaluate':
      return reply(id, { result: { type: 'string', value: evaluate(String(params.expression ?? '')) } });
    case 'Page.captureScreenshot':
      return reply(id, { data: 'ZmFrZS1wbmctYmFzZTY0' });
    default:
      return replyError(id, `fake-chrome: unknown method ${method}`);
  }
}

// A read on the inherited pipe. If the fd is non-blocking, EAGAIN means "nothing yet" —
// sleeping a millisecond beats spinning, which would burn a whole core per fake browser
// and starve the test that is waiting for the reply.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (true) {
  const chunk = Buffer.alloc(65536);
  let bytes;
  try {
    bytes = fs.readSync(READ_FD, chunk, 0, chunk.length, null);
  } catch (error) {
    if (error.code === 'EAGAIN') {
      sleep(1);
      continue;
    }
    if (error.code === 'EOF' || error.code === 'EPIPE') break;
    throw error;
  }
  if (bytes === 0) break;
  buffer = Buffer.concat([buffer, chunk.subarray(0, bytes)]);
  let index;
  while ((index = buffer.indexOf(0)) !== -1) {
    const raw = buffer.subarray(0, index).toString('utf8');
    buffer = buffer.subarray(index + 1);
    if (!raw) continue;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    handle(message);
  }
}

process.exit(readyAnswered ? 0 : 5);
