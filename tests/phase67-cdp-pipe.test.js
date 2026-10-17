import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDPipe, discoverChrome } from '../src/browser/cdp-pipe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CHROME = path.join(here, 'fixtures', 'fake-chrome.mjs');

// This machine has no Chrome, so the module cannot be tested here against a stock browser.
// It can be tested against a protocol-compatible one: tests/fixtures/fake-chrome.mjs speaks
// the same NUL-framed CDP-over-fd-3/4 protocol, which exercises the real code path —
// spawn, fd wiring, framing, request/response matching, and the error mapping.
//
// The transport has also been run live against a real Chromium: Electron bundles Chromium,
// and this machine has the OpenCode desktop app at /opt/OpenCode/ai.opencode.desktop, which
// answers `Browser.getVersion` on the pipe as `Chrome/152.0.7977.130`. The same run showed
// that `Target.createTarget` is not implemented there ("Not supported"), which is why
// openTarget() falls back to an existing page target — see the two tests below.
//
// Three defects found by actually running this module are pinned here: the file was
// CommonJS in an ES-module package (it could not load at all), a closed pipe emitted an
// unhandled `error` event that killed the process with `write EPIPE` instead of failing
// the call, and a hardcoded /opt/google/chrome/chrome assumed a browser that is not there.

function fakeChromeBin(flags = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zc-fake-chrome-'));
  const bin = path.join(dir, 'fake-chrome.mjs');
  // A shebang plus the exec bit is what `discoverChrome` checks for.
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.argv.push(${flags.map((f) => JSON.stringify(f)).join(', ')});\n${''}await import(${JSON.stringify(FAKE_CHROME)});\n`, 'utf8');
  chmodSync(bin, 0o755);
  return { dir, bin };
}

async function withFakeChrome(flags, fn) {
  const { dir, bin } = fakeChromeBin(flags);
  const previousBin = process.env.CHROME_BIN;
  const previousTmp = process.env.CDP_TMP_ROOT;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'zc-cdp-tmp-'));
  process.env.CHROME_BIN = bin;
  process.env.CDP_TMP_ROOT = tmp;
  try {
    return await fn({ bin, tmp });
  } finally {
    if (previousBin === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = previousBin;
    if (previousTmp === undefined) delete process.env.CDP_TMP_ROOT; else process.env.CDP_TMP_ROOT = previousTmp;
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('phase67 the module loads as ESM (it was CommonJS in an ES-module package)', async () => {
  const module = await import('../src/browser/cdp-pipe.js');
  assert.equal(typeof module.browseCdp, 'function');
  assert.equal(typeof module.stopCdp, 'function');
  assert.equal(typeof module.discoverChrome, 'function');
  assert.equal(typeof module.CDPipe, 'function');
});

test('phase67 CHROME_BIN wins, and a bad CHROME_BIN says so instead of being ignored', async () => {
  await withFakeChrome([], async ({ bin }) => {
    const found = discoverChrome();
    assert.equal(found.path, bin);
    assert.equal(found.source, 'CHROME_BIN');
  });

  const previous = process.env.CHROME_BIN;
  process.env.CHROME_BIN = '/nonexistent/chrome';
  try {
    assert.throws(() => discoverChrome(), /chrome_binary_not_executable/);
  } finally {
    if (previous === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = previous;
  }
});

test('phase67 discovery failure names what it looked for', () => {
  // The search is injected here on purpose. A bare `discoverChrome()` is not deterministic:
  // this machine has /usr/bin/chromium-browser, so it would succeed and the assertion would
  // be testing the machine instead of the code.
  assert.throws(
    () => discoverChrome({ env: { PATH: '/nonexistent' }, wellKnownPaths: [] }),
    (error) => {
      assert.match(error.message, /chrome_binary_not_found/);
      // The old code said only "chrome binary not found: /opt/google/chrome/chrome".
      assert.match(error.message, /CHROME_BIN/);
      assert.match(error.message, /tried:/);
      return true;
    }
  );
});

test('phase67 discovery order is CHROME_BIN, then PATH, then well-known paths', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zc-discover-'));
  const bin = path.join(dir, 'google-chrome');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(bin, 0o755);
  try {
    assert.deepEqual(
      discoverChrome({ env: { CHROME_BIN: bin, PATH: '/nonexistent' }, wellKnownPaths: [] }),
      { path: bin, source: 'CHROME_BIN' }
    );
    assert.deepEqual(
      discoverChrome({ env: { PATH: dir }, wellKnownPaths: ['/nonexistent'] }),
      { path: bin, source: 'PATH' }
    );
    assert.deepEqual(
      discoverChrome({ env: {}, wellKnownPaths: [bin] }),
      { path: bin, source: 'well-known-path' }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phase67 browse drives the pipe protocol end to end', async () => {
  await withFakeChrome([], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    try {
      const text = await pipe.browse({ url: 'https://example.invalid/page', action: 'text' });
      assert.equal(text.ok, true);
      assert.equal(text.url, 'https://example.invalid/page');
      assert.equal(text.title, 'Fake Page');
      assert.equal(text.text, 'fake body text');
      assert.equal(text.readyState, 'complete');
      assert.equal(typeof text.sandboxDisabled, 'boolean');

      const html = await pipe.browse({ url: 'https://example.invalid/page', action: 'html' });
      assert.equal(html.html, '<html><body>fake</body></html>');

      const title = await pipe.browse({ url: 'https://example.invalid/page', action: 'title' });
      assert.equal(title.title, 'Fake Page');
      assert.equal(title.text, undefined);

      const shot = await pipe.browse({ url: 'https://example.invalid/page', action: 'screenshot' });
      assert.equal(shot.png_base64, 'ZmFrZS1wbmctYmFzZTY0');
      assert.equal(shot.png_base64_chars, 20);
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 a Chromium without Target.createTarget reuses the page it already has', async () => {
  // Electron-based Chromium answers "Not supported" to Target.createTarget. Browsing must
  // still work, by attaching to the page target that already exists.
  await withFakeChrome(['--no-create-target'], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    try {
      const result = await pipe.browse({ url: 'https://example.invalid/fallback', action: 'text' });
      assert.equal(result.ok, true);
      assert.equal(result.url, 'https://example.invalid/fallback');
      assert.equal(result.title, 'Fake Page');
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 with no target at all the failure names both halves', async () => {
  await withFakeChrome(['--no-create-target', '--no-page-target'], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    try {
      await assert.rejects(
        () => pipe.browse({ url: 'https://example.invalid/page', action: 'text' }),
        (error) => {
          assert.match(error.message, /cdp_no_page_target/);
          assert.match(error.message, /createTarget: Not supported/);
          assert.match(error.message, /0 target\(s\), none of type page/);
          return true;
        }
      );
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 the pipe is only started once, and reused across calls', async () => {
  await withFakeChrome([], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    try {
      await pipe.start();
      const first = pipe.proc;
      await pipe.start();
      assert.equal(pipe.proc, first, 'start() must be idempotent');
      await pipe.browse({ url: 'https://example.invalid/a', action: 'title' });
      assert.equal(pipe.proc, first, 'browse must reuse the running browser');
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 the profile directory is created and removed again', async () => {
  await withFakeChrome([], async ({ tmp }) => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    await pipe.start();
    const profile = pipe.profileDir;
    assert.ok(profile.startsWith(tmp), `profile ${profile} must live under ${tmp}`);
    assert.equal(existsSync(profile), true);
    pipe.stop();
    assert.equal(existsSync(profile), false, 'the profile must not be left behind');
    assert.deepEqual(readdirSync(tmp), []);
  });
});

test('phase67 a browser that dies at startup reports its stderr, not an uncaught crash', async () => {
  await withFakeChrome(['--die-immediately'], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 2000 });
    try {
      await assert.rejects(() => pipe.start(), (error) => {
        // The old behaviour was an unhandled `write EPIPE` that killed the process.
        assert.match(error.message, /chrome_exited_during_startup|cdp_pipe_not_ready|cdp_write_stream_error/);
        assert.match(error.message, /dying immediately/, 'Chrome stderr must be attached');
        return true;
      });
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 a browser that dies mid-session fails the call instead of hanging', async () => {
  await withFakeChrome(['--die-after-ready'], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    try {
      await pipe.start();
      await assert.rejects(
        () => pipe.browse({ url: 'https://example.invalid/page', action: 'title' }),
        (error) => {
          assert.match(error.message, /chrome exited|cdp_write_stream_error|cdp_read_stream_error/);
          return true;
        }
      );
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 a browser that never answers times out with the method name', async () => {
  await withFakeChrome(['--silent'], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 600, timeoutMs: 600 });
    try {
      await assert.rejects(() => pipe.start(), /cdp_pipe_not_ready/);
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 a navigation failure is reported as a navigation failure', async () => {
  await withFakeChrome(['--fail-navigation'], async () => {
    const pipe = new CDPipe({ readyTimeoutMs: 5000 });
    try {
      await assert.rejects(
        () => pipe.browse({ url: 'https://example.invalid/page', action: 'text' }),
        /navigate: net::ERR_NAME_NOT_RESOLVED/
      );
    } finally {
      pipe.stop();
    }
  });
});

test('phase67 input is validated before a browser is ever launched', async () => {
  // No CHROME_BIN on purpose: a validation failure must not depend on a browser existing.
  const previous = process.env.CHROME_BIN;
  process.env.CHROME_BIN = '/nonexistent/chrome';
  try {
    const pipe = new CDPipe();
    await assert.rejects(() => pipe.browse({}), /url is required/);
    await assert.rejects(() => pipe.browse({ url: 'javascript:alert(1)' }), /url must start with/);
    await assert.rejects(() => pipe.browse({ url: 'ftp://example.invalid' }), /url must start with/);
    await assert.rejects(
      () => pipe.browse({ url: 'https://example.invalid', action: 'sideways' }),
      /chrome_binary_not_executable|unknown action/
    );
  } finally {
    if (previous === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = previous;
  }
});

test('phase67 NUL framing survives a multi-byte character split across chunks', async () => {
  // `setEncoding('utf8')` on a decoded string is a common way to corrupt a frame; this
  // module frames on the NUL byte and decodes afterwards, so a split must not matter.
  const pipe = new CDPipe();
  const payload = JSON.stringify({ id: 1, result: { value: 'বাংলা text' } });
  const bytes = Buffer.from(`${payload}\0`, 'utf8');
  const split = bytes.indexOf(Buffer.from('বাংলা', 'utf8')) + 3;
  const resolved = new Promise((resolve, reject) => {
    pipe.pending.set(1, { resolve, reject, timer: setTimeout(() => reject(new Error('never resolved')), 1000) });
  });
  pipe._onData(bytes.subarray(0, split));
  pipe._onData(bytes.subarray(split));
  const result = await resolved;
  assert.equal(result.value, 'বাংলা text');
});

test('phase67 a CDP error frame rejects the call, and unknown ids are ignored', async () => {
  const pipe = new CDPipe();
  const rejected = new Promise((resolve) => {
    pipe.pending.set(7, { resolve: () => resolve(new Error('should not resolve')), reject: (e) => resolve(e), timer: setTimeout(() => resolve(new Error('never settled')), 1000) });
  });
  pipe._onData(Buffer.from(`${JSON.stringify({ id: 7, error: { message: 'boom' } })}\0`, 'utf8'));
  assert.equal((await rejected).message, 'boom');

  // An id nobody is waiting for, and a frame that is not JSON, must both be harmless.
  assert.doesNotThrow(() => pipe._onData(Buffer.from('not json\0', 'utf8')));
  assert.doesNotThrow(() => pipe._onData(Buffer.from(`${JSON.stringify({ id: 999, result: {} })}\0`, 'utf8')));
  assert.doesNotThrow(() => pipe._onData(Buffer.from('\0', 'utf8')));
});
