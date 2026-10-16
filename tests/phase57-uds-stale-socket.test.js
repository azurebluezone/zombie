import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTransportServers, stopTransportServers, isSocketBound } from '../src/transport/server.js';

async function tempDir() { return mkdtemp(path.join(tmpdir(), 'zc-phase57-uds-')); }

function baseConfig(socketPath, { required = true } = {}) {
  return { port: 0, host: '127.0.0.1', https: { enabled: false }, uds: { enabled: true, required, path: socketPath } };
}

function collectingLogger() {
  const events = [];
  const push = level => (event, fields) => { events.push({ level, event, fields }); return Promise.resolve(); };
  return { events, info: push('info'), warn: push('warn'), error: push('error') };
}

const handler = (req, res) => res.end('ok');

// Waiting on 'exit' after the child is already gone would never settle, so check first.
function waitForExit(child, timeoutMs = 10000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ alreadyGone: true });
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function waitForStdout(child, marker, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`stdout never contained ${marker}`)), timeoutMs);
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes(marker)) { clearTimeout(timer); resolve(out); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('child exited before it was ready')); });
  });
}

// A killed process cannot unlink its socket file, which is how the residue is born.
async function leaveKilledSocketResidue(socketPath) {
  const child = spawn(process.execPath, ['-e', 'const net=require("node:net");net.createServer().listen(process.env.SOCK,()=>console.log("listening"));'], {
    env: { ...process.env, SOCK: socketPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForStdout(child, 'listening');
  const exited = waitForExit(child);
  child.kill('SIGKILL');
  await exited;
}

test('phase57 a socket file left by a killed owner is residue, a live one is not', { timeout: 30000 }, async t => {
  const dir = await tempDir();
  const live = createServer(handler);
  t.after(async () => {
    await new Promise(resolve => live.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const socketPath = path.join(dir, 'residue.sock');
  await leaveKilledSocketResidue(socketPath);
  assert.equal((await stat(socketPath)).isSocket(), true, 'the file survives the killed owner');
  assert.equal(await isSocketBound(socketPath), false, 'no owner -> no /proc/net/unix entry');

  const livePath = path.join(dir, 'live.sock');
  await new Promise(resolve => live.listen(livePath, resolve));
  assert.equal(await isSocketBound(livePath), true, 'a listening socket is listed');
});

test('phase57 a stale socket no longer blocks startup and is replaced', { timeout: 30000 }, async t => {
  const dir = await tempDir();
  const socketPath = path.join(dir, 'stale.sock');
  const logger = collectingLogger();
  let servers = null;
  t.after(async () => {
    if (servers) await stopTransportServers(servers);
    await rm(dir, { recursive: true, force: true });
  });
  await leaveKilledSocketResidue(socketPath);

  servers = await startTransportServers({ handler, config: baseConfig(socketPath), logger, runtimeIdentity: { runtimeId: 'runtime-test' } });
  assert.ok(servers.uds, 'uds transport starts despite the leftover file');
  const warning = logger.events.find(e => e.event === 'runtime.uds.stale_socket_removed');
  assert.ok(warning, 'the removal is never silent');
  assert.equal(warning.level, 'warn');
  assert.equal(warning.fields.path, socketPath);
  assert.equal(await isSocketBound(socketPath), true, 'the path now belongs to this runtime');
});

test('phase57 a socket held by a live listener still fails closed and is not removed', { timeout: 30000 }, async t => {
  const dir = await tempDir();
  const socketPath = path.join(dir, 'live.sock');
  const live = createServer(handler);
  await new Promise(resolve => live.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise(resolve => live.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(
    () => startTransportServers({ handler, config: baseConfig(socketPath), logger: collectingLogger(), runtimeIdentity: { runtimeId: 'runtime-test' } }),
    /uds_path_already_exists/
  );
  assert.equal((await stat(socketPath)).isSocket(), true, 'the other runtime keeps its socket');
  assert.equal(await isSocketBound(socketPath), true);
});

test('phase57 a failed start leaves no listener behind', { timeout: 30000 }, async t => {
  const dir = await tempDir();
  const socketPath = path.join(dir, 'busy.sock');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/transport/server.js', import.meta.url).href;
  const script = `
    const net = await import('node:net');
    const { startTransportServers } = await import(process.env.MODULE_URL);
    const live = net.createServer();
    await new Promise(resolve => live.listen(process.env.SOCK, resolve));
    try {
      await startTransportServers({ handler: (q, s) => s.end('ok'), config: { port: 0, host: '127.0.0.1', https: { enabled: false }, uds: { enabled: true, required: true, path: process.env.SOCK } }, logger: null, runtimeIdentity: { runtimeId: 'leak-test' } });
      console.log('unexpected-start');
    } catch (error) {
      console.log('rejected:' + error.message);
    }
    await new Promise(resolve => live.close(resolve));
    console.log('child-done');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SOCK: socketPath, MODULE_URL: moduleUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const exited = await waitForExit(child, 15000);
  assert.ok(!exited.timedOut, 'the child must exit on its own: a leaked http listener would keep it alive');
  assert.match(out, /rejected:uds_path_already_exists/, `child output: ${out}`);
  assert.match(out, /child-done/, `child output: ${out}`);
  assert.equal(exited.code, 0, `child exit code ${exited.code}`);
});

test('phase57 a missing socket path starts cleanly and logs no removal', { timeout: 30000 }, async t => {
  const dir = await tempDir();
  const logger = collectingLogger();
  const servers = await startTransportServers({ handler, config: baseConfig(path.join(dir, 'absent.sock')), logger, runtimeIdentity: { runtimeId: 'runtime-test' } });
  t.after(async () => {
    await stopTransportServers(servers);
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok(servers.uds);
  assert.equal(logger.events.filter(e => e.event === 'runtime.uds.stale_socket_removed').length, 0, 'nothing to remove, nothing to log');
});
