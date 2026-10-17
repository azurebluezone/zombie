#!/usr/bin/env node
/**
 * cdp-pipe.js — headless Chrome over `--remote-debugging-pipe` (zero HTTP on the control
 * channel).
 *
 * Chrome is launched with `--remote-debugging-pipe`, so CDP JSON messages travel over the
 * inherited pipe: Chrome **reads fd 3** and **writes fd 4**, NUL-terminated. The parent
 * therefore writes into `stdio[3]` and reads from `stdio[4]`. There is no debug port, no TCP,
 * no WebSocket and no HTTP anywhere in the control channel, so nothing on the machine can
 * reach in and talk to the DevTools socket. The page itself may load http(s)/file URLs —
 * that is Chrome doing its job; this module never opens a socket.
 *
 * Zero dependencies, ESM (this package is `"type": "module"`).
 *
 * What changed and why
 * --------------------
 * The previous version was CommonJS in an ES-module package, so it could not load at all
 * (`ReferenceError: require is not defined in ES module scope`). It also hardcoded
 * `/opt/google/chrome/chrome`, a path that does not exist on most machines, and
 * `/tmp/zombiecoder` for its profile. This version:
 *
 *   - finds a browser instead of assuming one: `CHROME_BIN`, then `PATH`, then the
 *     well-known location for the platform, and says what it looked for when it fails;
 *   - keeps Chrome's own sandbox. `--no-sandbox` is added only when it is asked for
 *     (`CDP_NO_SANDBOX=1`) or when the process is already root, where Chrome refuses to
 *     start otherwise — and the returned result says which;
 *   - uses `os.tmpdir()`, not a hardcoded `/tmp`, and removes its profile directory when
 *     the browser stops, so repeated runs do not fill the disk;
 *   - keeps a bounded tail of Chrome's stderr and attaches it to failures, because a
 *     silent stderr is how "it just does not work" happens;
 *   - frames on the NUL **byte** and decodes afterwards, instead of splitting a decoded
 *     string;
 *   - waits for the pipe to answer instead of sleeping for a fixed 400 ms;
 *   - bounds every payload it returns;
 *   - kills its browser on process exit, so a crash does not leave Chrome behind.
 *
 * Public API:
 *   browseCdp({ url, action, timeoutMs, maxOutputChars }) → { ok, url, title, ... }
 *   stopCdp()
 *   discoverChrome()
 * CLI self-test:
 *   node src/browser/cdp-pipe.js <url> [text|html|title|screenshot]
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as FS, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 10000;
const DEFAULT_MAX_OUTPUT_CHARS = 4_000_000;
const STDERR_TAIL_CHARS = 2000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Executable names to look for on PATH, in order of preference. */
const PATH_CANDIDATES = Object.freeze([
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'chrome-headless-shell',
  'headless_shell'
]);

function wellKnownCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
    ];
  }
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Chromium', 'Application', 'chrome.exe')
    ]);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome'
  ];
}

/** Is this a file we could actually execute? Existence alone is not enough. */
function isExecutable(candidate) {
  if (!candidate || !existsSync(candidate)) return false;
  try {
    accessSync(candidate, process.platform === 'win32' ? FS.F_OK : FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bare command name against PATH, without a shell. */
function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      for (const variant of [name + ext.toLowerCase(), name + ext.toUpperCase(), name + ext]) {
        const candidate = path.join(dir, variant);
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Find a browser to drive.
 *
 * Order: an explicit `CHROME_BIN`, then PATH, then the platform's well-known locations.
 * A failure lists everything that was tried — "chrome binary not found" on its own leaves
 * the operator with nothing to act on.
 *
 * `env`, `platform` and `wellKnownPaths` can be supplied so the search is testable without
 * depending on what happens to be installed on the machine running the test.
 */
export function discoverChrome(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const wellKnown = options.wellKnownPaths ?? wellKnownCandidates(platform, env);
  const explicit = String(env.CHROME_BIN ?? '').trim();
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(`chrome_binary_not_executable: CHROME_BIN=${explicit}`);
    }
    return { path: explicit, source: 'CHROME_BIN' };
  }
  for (const name of PATH_CANDIDATES) {
    const found = findOnPath(name, env, platform);
    if (found) return { path: found, source: 'PATH' };
  }
  for (const candidate of wellKnown) {
    if (isExecutable(candidate)) return { path: candidate, source: 'well-known-path' };
  }
  const tried = [...PATH_CANDIDATES, ...wellKnown].join(', ');
  throw new Error(`chrome_binary_not_found: set CHROME_BIN. tried: ${tried}`);
}

/** The profile root: an explicit override, else the platform temp directory. */
function profileRoot() {
  const override = String(process.env.CDP_TMP_ROOT ?? '').trim();
  return override || path.join(os.tmpdir(), 'zombiecoder');
}

/** Chrome refuses to start as root without `--no-sandbox`; nobody should have to. */
function runningAsRoot() {
  if (process.platform === 'win32') return false;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export class CDPipe {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.proc = null;
    this.msgId = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buffer = Buffer.alloc(0);
    this.toChild = null;
    this.fromChild = null;
    this.exited = false;
    this.profileDir = null;
    this.stderrTail = '';
    this.sandboxDisabled = false;
    this.browserPath = null;
    this._onExit = null;
  }

  /** Launch Chrome and wait until the pipe answers. */
  async start() {
    if (this.proc) return this;

    const chrome = discoverChrome();
    this.browserPath = chrome.path;
    this.sandboxDisabled = process.env.CDP_NO_SANDBOX === '1' || runningAsRoot();

    this.profileDir = String(process.env.CDP_USER_DATA_DIR ?? '').trim()
      || path.join(profileRoot(), `cdp-pipe-profile-${process.pid}-${Date.now()}`);
    mkdirSync(this.profileDir, { recursive: true });

    const headless = process.env.CDP_HEADLESS === '0' ? [] : ['--headless=new'];
    const args = [
      ...headless,
      '--remote-debugging-pipe',
      ...(this.sandboxDisabled ? ['--no-sandbox'] : []),
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${this.profileDir}`,
      'about:blank'
    ];

    // fd 3 = CDP write channel, fd 4 = CDP read channel. stdout/stderr are drained so a
    // chatty Chrome can never block on a full pipe.
    this.proc = spawn(chrome.path, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    this.toChild = this.proc.stdio[3];
    this.fromChild = this.proc.stdio[4];
    // A pipe that closes under us emits `error` on the stream. Without a listener Node
    // turns that into an uncaught exception and the whole process dies with
    // `write EPIPE` instead of the caller getting a failed tool call.
    this.toChild.on('error', (error) => this._failAll(`cdp_write_stream_error: ${error.message}`));
    this.fromChild.on('error', (error) => this._failAll(`cdp_read_stream_error: ${error.message}`));
    this.fromChild.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      // Keep the tail instead of discarding it: a Chrome that dies at startup explains
      // itself on stderr, and that explanation is the only useful thing in the failure.
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.proc.stdout.on('data', () => {});
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`chrome exited (${reason})${this.stderrSuffix()}`));
      }
      this.pending.clear();
    });

    // A crash between spawn and exit must not leave Chrome running.
    this._onExit = () => this.stop();
    process.once('exit', this._onExit);

    await this.waitForPipe();
    return this;
  }

  stderrSuffix() {
    const tail = this.stderrTail.trim();
    return tail ? ` | chrome stderr: ${tail}` : '';
  }

  /** Reject every in-flight call with one reason. */
  _failAll(reason) {
    if (!this.pending.size) return;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Ask the browser something and wait for the answer. This replaces a fixed 400 ms
   * sleep: a sleep that is too short fails on a slow machine and too long wastes time on
   * a fast one, and neither says which happened.
   */
  async waitForPipe() {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(`chrome_exited_during_startup${this.stderrSuffix()}`);
      try {
        await this.send('Browser.getVersion', {}, undefined, { timeoutMs: Math.min(2000, this.readyTimeoutMs) });
        return true;
      } catch (error) {
        lastError = error;
        await delay(100);
      }
    }
    throw new Error(`cdp_pipe_not_ready after ${this.readyTimeoutMs}ms: ${lastError?.message ?? 'no response'}${this.stderrSuffix()}`);
  }

  /** Frame on the NUL byte, then decode. Splitting a decoded string works by luck. */
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
    let index;
    while ((index = this.buffer.indexOf(0)) !== -1) {
      const raw = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 1);
      if (!raw) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue; // not our frame; CDP events we do not subscribe to are ignored
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || 'cdp error'));
        else entry.resolve(message.result || {});
      }
    }
  }

  send(method, params, sessionId, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.toChild) return reject(new Error('chrome not running'));
      const id = ++this.msgId;
      const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${budget}ms: ${method}`));
      }, budget);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.toChild.write(`${JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) })}\0`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`cdp_write_failed: ${error.message}`));
      }
    });
  }

  /**
   * Get a page to drive.
   *
   * Preferred: a fresh target, so the caller's browsing cannot disturb a page someone
   * else is using. Electron-based Chromium (an Electron app bundles Chromium and answers
   * on the same pipe) does not implement `Target.createTarget` and replies "Not
   * supported", so fall back to the page target that already exists. The transport is the
   * point, not the tab.
   */
  async openTarget() {
    try {
      const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      return { targetId, sessionId, created: true };
    } catch (error) {
      const listing = await this.send('Target.getTargets').then(
        (value) => ({ value }),
        (listError) => ({ error: listError })
      );
      const infos = Array.isArray(listing.value?.targetInfos) ? listing.value.targetInfos : [];
      const page = infos.find((t) => t.type === 'page' && t.attached !== true) ?? infos.find((t) => t.type === 'page');
      if (!page) {
        // Say why both halves failed; "it did not work" is not a diagnosis.
        const because = listing.error
          ? `createTarget: ${error.message}; getTargets: ${listing.error.message}`
          : `createTarget: ${error.message}; ${infos.length} target(s), none of type page`;
        throw new Error(`cdp_no_page_target (${because})`);
      }
      const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      return { targetId: page.targetId, sessionId, created: false };
    }
  }

  async eval(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return result.result ? result.result.value : null;
  }

  /**
   * Open a URL in a fresh target and return the requested view of it.
   *
   * `action` is one of `text` (default), `html`, `title`, `url` or `screenshot`. Every
   * string payload is bounded by `maxOutputChars`; a screenshot that exceeds it fails
   * with `screenshot_too_large` rather than returning base64 that has been cut in half and
   * no longer decodes.
   */
  async browse(options = {}) {
    const { url, action = 'text', maxOutputChars } = options;
    // `timeout_ms` is the original spelling; `timeoutMs` matches the rest of the runtime.
    const requestedTimeout = options.timeoutMs ?? options.timeout_ms;
    if (!url || typeof url !== 'string') throw new Error('url is required');
    const target = url.trim();
    if (!/^(https?:|file:|data:)/i.test(target)) {
      throw new Error('url must start with http:// https:// file:// or data:');
    }
    const budget = Number(requestedTimeout) > 0 ? Number(requestedTimeout) : this.timeoutMs;
    const cap = Number(maxOutputChars) > 0 ? Number(maxOutputChars) : DEFAULT_MAX_OUTPUT_CHARS;

    await this.start();
    const { targetId, sessionId, created } = await this.openTarget();
    try {
      await this.send('Page.enable', {}, sessionId);
      await this.send('Runtime.enable', {}, sessionId);
      const navigation = await this.send('Page.navigate', { url: target }, sessionId, { timeoutMs: budget });
      if (navigation.errorText) throw new Error(`navigate: ${navigation.errorText}`);

      const deadline = Date.now() + budget;
      let ready = 'loading';
      while (ready === 'loading' && Date.now() < deadline) {
        ready = (await this.eval('document.readyState', sessionId)) || 'loading';
        if (ready === 'loading') await delay(250);
      }

      const finalUrl = (await this.eval('location.href', sessionId)) || target;
      const title = (await this.eval('document.title', sessionId)) || '';
      const out = { ok: true, url: finalUrl, title, readyState: ready, sandboxDisabled: this.sandboxDisabled };

      const bounded = (text, label) => {
        const value = String(text ?? '');
        if (value.length <= cap) return value;
        return `${value.slice(0, cap)}\n[truncated ${label}: showing ${cap} of ${value.length} characters]`;
      };

      if (action === 'html') {
        out.html = bounded(await this.eval('document.documentElement.outerHTML', sessionId), 'html');
      } else if (action === 'title' || action === 'url') {
        // already collected above
      } else if (action === 'screenshot') {
        const shot = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId, { timeoutMs: budget });
        const data = String(shot.data ?? '');
        if (data.length > cap) throw new Error(`screenshot_too_large: ${data.length} base64 characters exceeds maxOutputChars=${cap}`);
        out.png_base64 = data;
        out.png_base64_chars = data.length;
      } else if (action === 'text') {
        out.text = bounded(await this.eval('document.body ? document.body.innerText : ""', sessionId), 'text');
      } else {
        throw new Error(`unknown action: ${action} (expected text, html, title, url or screenshot)`);
      }
      return out;
    } finally {
      // Only close what we opened: an Electron target belongs to the application.
      if (created) {
        try {
          await this.send('Target.closeTarget', { targetId });
        } catch {
          /* the target may already be gone */
        }
      }
    }
  }

  /** Stop the browser and remove its profile directory. */
  stop() {
    const proc = this.proc;
    this.proc = null;
    if (this._onExit) {
      process.removeListener('exit', this._onExit);
      this._onExit = null;
    }
    if (proc && !this.exited) {
      try {
        this.toChild?.end();
      } catch {
        /* already closed */
      }
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.toChild = null;
    this.fromChild = null;
    if (this.profileDir) {
      try {
        rmSync(this.profileDir, { recursive: true, force: true });
      } catch {
        /* a locked profile is not worth failing over */
      }
      this.profileDir = null;
    }
  }
}

// One browser for the process, reused across calls; replaced when it dies.
let shared = null;

export async function browseCdp(options) {
  if (!shared || shared.exited) shared = new CDPipe();
  return shared.browse(options || {});
}

export function stopCdp() {
  if (shared) shared.stop();
  shared = null;
}

// ─── CLI self-test (pipe only; this script opens no socket) ──────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const url = process.argv[2] || 'about:blank';
    const action = process.argv[3] || 'text';
    const pipe = new CDPipe();
    try {
      const result = await pipe.browse({ url, action });
      if (action === 'screenshot') {
        console.log(JSON.stringify({ ...result, png_base64: `<${result.png_base64_chars} base64 chars>` }, null, 2));
      } else {
        const copy = { ...result };
        if (copy.html) copy.html = `${copy.html.slice(0, 400)}…`;
        if (copy.text) copy.text = copy.text.slice(0, 800);
        console.log(JSON.stringify(copy, null, 2));
      }
    } finally {
      pipe.stop();
    }
  })().catch((error) => {
    console.error('FAIL:', error.message);
    process.exit(1);
  });
}
