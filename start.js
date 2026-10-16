#!/usr/bin/env node
'use strict';

// Cross-platform launcher. Never kills an arbitrary process just because a port is busy.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RUNTIME_PHASE } from './src/runtime/version.js';

const root = path.dirname(fileURLToPath(import.meta.url));
// ENV_FILE lets an operator keep deployment configuration outside the build
// output, so the launcher must read exactly the same file the server will read.
// Otherwise the launcher would take PORT from one file while src/server.js took
// it from another, and a rebuild that removed the in-tree .env would make the
// launcher fall back to the default port and refuse to start.
const envFile = path.resolve(root, process.env.ENV_FILE || '.env');
const pidFile = path.join(root, '.zombiecoder-runtime.pid');
const childEnv = { ...process.env };
function loadDotEnv(file) {
  if (!existsSync(file)) return { loaded: 0 };
  let loaded = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || Object.hasOwn(process.env, m[1])) continue;
    childEnv[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); loaded++;
  }
  return { loaded };
}
const envResult = loadDotEnv(envFile);
const portRaw = childEnv.PORT ?? '9999';
const effectivePort = Number(portRaw);
const effectiveHost = childEnv.HOST || '127.0.0.1';
const runtimeId = childEnv.RUNTIME_ID || `runtime-${effectivePort}`;
const runtimePhase = childEnv.RUNTIME_PHASE || String(RUNTIME_PHASE);
childEnv.RUNTIME_ID = runtimeId;
childEnv.RUNTIME_PHASE = runtimePhase;
childEnv.INSTANCE_ID = childEnv.INSTANCE_ID || randomUUID();
// Pin the resolved path so the server cannot end up reading a different .env.
childEnv.ENV_FILE = envFile;

function log(message) { console.log(`[ZombieCoder] ${message}`); }
function command(args, cmd = process.platform === 'win32' ? 'powershell.exe' : 'ps') {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}
function processCommandLine(pid) {
  if (process.platform === 'win32') return command(['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\").CommandLine`]);
  return command(['-p',String(pid),'-o','args=']);
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopPid(pid) {
  if (!pidAlive(pid)) return { stopped: false, reason: 'pid_not_running' };
  const cmd = processCommandLine(pid);
  const expected = path.join(root, 'src', 'server.js');
  if (!cmd || !cmd.includes(expected)) return { stopped: false, reason: 'pid_command_line_mismatch' };
  try { process.kill(pid, 'SIGTERM'); } catch { return { stopped: false, reason: 'terminate_failed' }; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (!pidAlive(pid)) return { stopped: true }; await new Promise(r => setTimeout(r, 100)); }
  // Do not force-kill after timeout: report and leave it for operator inspection.
  return { stopped: false, reason: 'terminate_timeout' };
}
function portBusy() {
  return new Promise(resolve => {
    const s = createConnection({ host: effectiveHost, port: effectivePort });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}
function listenerDiagnostics() {
  if (process.platform === 'win32') {
    const out = command(['-NoProfile','-Command',`Get-NetTCPConnection -State Listen -LocalPort ${effectivePort} -ErrorAction SilentlyContinue | Select-Object -Property LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String`]);
    return out || 'No Windows listener details available. Check: netstat -ano | findstr :' + effectivePort;
  }
  const ss = command(['-ltnp'], 'ss');
  const rows = ss.split('\n').filter(line => line.includes(`:${effectivePort} `) || line.endsWith(`:${effectivePort}`));
  return rows.join('\n') || `No ss listener details available. Check: sudo lsof -nP -iTCP:${effectivePort} -sTCP:LISTEN`;
}

if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) {
  console.error(`[ZombieCoder] Invalid PORT=${String(portRaw)}. Expected an integer from 1 to 65535.`); process.exit(2);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`[ZombieCoder] Node.js >=22.5.0 required; found ${process.versions.node}.`); process.exit(2);
}
log(`launcher=${path.join(root, 'start.js')}`);
log(`node=${process.execPath} version=${process.versions.node}`);
log(`env_file=${envFile} loaded_keys=${envResult.loaded} explicit_PORT=${Object.hasOwn(childEnv,'PORT') ? 'set' : 'default'} host=${effectiveHost} port=${effectivePort}`);
log(`runtime_id=${runtimeId} phase=${runtimePhase} platform=${process.platform}`);

if (process.argv.includes('--stop')) {
  if (!existsSync(pidFile)) { log('no PID file found; nothing to stop'); process.exit(0); }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid < 1) { console.error('[ZombieCoder] Invalid PID file; refusing termination.'); process.exit(2); }
  const result = await stopPid(pid);
  if (result.stopped) { try { unlinkSync(pidFile); } catch {} log(`stopped runtime pid=${pid}`); process.exit(0); }
  console.error(`[ZombieCoder] Did not stop pid=${pid}: ${result.reason}. Inspect manually.`); process.exit(2);
}

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(pid) && pidAlive(pid)) {
    const result = await stopPid(pid);
    if (!result.stopped) { console.error(`[ZombieCoder] Existing PID ${pid} not stopped (${result.reason}); refusing duplicate launch.`); process.exit(2); }
  }
  try { unlinkSync(pidFile); } catch {}
}
if (await portBusy()) {
  console.error(`[ZombieCoder] port ${effectiveHost}:${effectivePort} is already in use.`);
  console.error('[ZombieCoder] Listener diagnostics:'); console.error(listenerDiagnostics());
  console.error('[ZombieCoder] No process was killed. Stop the owner deliberately or choose a different PORT.'); process.exit(2);
}
const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true });
writeFileSync(pidFile, String(child.pid));
log(`spawned server_pid=${child.pid} command=${path.join(root, 'src', 'server.js')}`);
const cleanup = () => { try { if (readFileSync(pidFile,'utf8').trim()===String(child.pid)) unlinkSync(pidFile); } catch {} };
child.on('exit', (code, signal) => { cleanup(); log(`server_exit code=${code ?? 'null'} signal=${signal ?? 'none'}`); process.exit(code ?? (signal ? 1 : 0)); });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { log(`forward_signal=${signal}`); try { child.kill(signal); } catch {} });
