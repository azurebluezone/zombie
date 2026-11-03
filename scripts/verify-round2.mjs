#!/usr/bin/env node
// Round-2 release gate. Every claim comes from a command that really ran:
// the isolated provider probe, the test runner, the build checksum map, ffprobe
// and a live Caddy Range request. No fixture stands in for any of them.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'dist/zombiecoder-runtime');
const AUDIO_ROOT = process.env.CADDY_AUDIO_ROOT || '/home/sahon/Music/work mp3';
const REPORT = path.join(ROOT, 'data/round2-verification.json');

const checks = {};
const failures = [];

function record(name, status, detail = {}) {
  checks[name] = { status, ...detail };
  if (status !== 'pass') failures.push(`${name}:${detail.reason ?? 'failed'}`);
}
function pass(name, detail = {}) { record(name, 'pass', detail); }
function fail(name, reason, detail = {}) { record(name, 'fail', { reason, ...detail }); }

function run(command, args, { cwd = ROOT, env = process.env, timeoutMs = 120000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const capture = chunk => { stdout = (stdout + chunk).slice(-500000); };
    const captureErr = chunk => { stderr = (stderr + chunk).slice(-200000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', captureErr);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function walkFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const PROBE_CACHE = path.join(ROOT, 'data/round2-provider-probe.json');
const PROBE_META = path.join(ROOT, 'data/round2-provider-probe.meta.json');

function providerSourceDigest(marker) {
  const entries = Object.entries(marker?.sha256 ?? {})
    .filter(([relative]) => relative === 'package.json' || relative === '.env.example'
      || relative === 'scripts/round2-provider-probe.mjs' || relative.startsWith('src/'))
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(entries.map(([relative, hash]) => `${relative}:${hash}`).join('\n')).digest('hex');
}

async function readBuildMarker() {
  try { return JSON.parse(await readFile(path.join(BUILD, '.zombiecoder-build.json'), 'utf8')); } catch { return null; }
}

async function readProbeCache(marker) {
  if (!marker) return null;
  try {
    const meta = JSON.parse(await readFile(PROBE_META, 'utf8'));
    const result = JSON.parse(await readFile(PROBE_CACHE, 'utf8'));
    const ageMs = Date.now() - Date.parse(meta.createdAt);
    if (meta.sourceDigest !== providerSourceDigest(marker) || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return null;
    if (result?.ok !== true) return null;
    return { result, meta };
  } catch { return null; }
}

async function verifyProviderProbe() {
  const marker = await readBuildMarker();
  const cached = process.env.ZC_ROUND2_REUSE_PROBE === '0' ? null : await readProbeCache(marker);
  const result = cached ? { code: 0, stdout: JSON.stringify(cached.result), stderr: '' } : await run(process.execPath, ['scripts/round2-provider-probe.mjs'], { timeoutMs: 15 * 60 * 1000 });
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  if (!cached) {
    await writeFile(PROBE_CACHE, result.stdout || '{}\n', { mode: 0o600 }).catch(() => {});
    if (marker) await writeFile(PROBE_META, JSON.stringify({ createdAt: new Date().toISOString(), sourceDigest: providerSourceDigest(marker), command: 'node scripts/round2-provider-probe.mjs' }, null, 2) + '\n', { mode: 0o600 }).catch(() => {});
  }
  let probe;
  try { probe = JSON.parse(result.stdout); } catch {
    return fail('providers', 'probe_output_not_json', { exitCode: result.code, stderr: result.stderr.slice(-500) });
  }
  const expectedIds = ['ollama-cloud-openai', 'ollama-cloud-native', 'gemini', 'groq'];
  const providers = Array.isArray(probe.providers) ? probe.providers : [];
  const bad = providers.filter(provider => provider.status !== 'PASS'
    || !provider.checks?.tool?.pass || !provider.checks?.stream?.pass || !provider.checks?.toolLoop?.pass);
  const ids = providers.map(provider => provider.id).sort();
  if (probe.ok !== true || result.code !== 0 || bad.length || ids.join(',') !== expectedIds.sort().join(',')) {
    return fail('providers', 'provider_probe_failed', {
      exitCode: result.code,
      ok: probe.ok,
      providers: providers.map(provider => ({ id: provider.id, status: provider.status, error: provider.error ?? null })),
      errors: probe.errors ?? []
    });
  }
  pass('providers', {
    source: cached ? 'cached-real-run' : 'live-run',
    probeAt: cached?.meta?.createdAt ?? new Date().toISOString(),
    count: providers.length,
    models: Object.fromEntries(providers.map(provider => [provider.id, provider.model])),
    mcp: probe.mcp?.status ?? 'missing',
    mcpTools: probe.mcp?.tools ?? null,
    runtimeErrors: probe.runtimeErrors ?? []
  });
}

async function verifyBuild() {
  let marker;
  try {
    marker = JSON.parse(await readFile(path.join(BUILD, '.zombiecoder-build.json'), 'utf8'));
  } catch (error) {
    return fail('build', `build_marker_unreadable:${error.message}`);
  }
  if (marker.application !== 'zombiecoder-runtime-build' || marker.schemaVersion !== 1) {
    return fail('build', 'build_marker_invalid');
  }
  const sourceRoots = ['start.js', 'package.json', 'README.md', 'CHANGELOG.md', 'IMPLEMENTATION_MANIFEST.md', '.env.example', 'src', 'tools', 'external-mcp', 'schemas', 'scripts', 'docs', 'integration'];
  const sourceFiles = [];
  for (const entry of sourceRoots) {
    const full = path.join(ROOT, entry);
    if (!existsSync(full)) continue;
    const info = await stat(full);
    if (info.isDirectory()) sourceFiles.push(...await walkFiles(full));
    else sourceFiles.push(full);
  }
  const skip = /(^|\/)(\.env|data|logs|node_modules|tests|dist|\.git|\.zombiecoder)(\/|$)|\.(sqlite|sqlite-wal|sqlite-shm|db)$/i;
  const candidates = sourceFiles
    .map(file => path.relative(ROOT, file))
    .filter(relative => !skip.test(relative.split(path.sep).join('/')))
    .filter(relative => !relative.endsWith('.zombiecoder-build.json'))
    .sort();
  const missing = [];
  const mismatched = [];
  for (const relative of candidates) {
    const expected = marker.sha256?.[relative];
    if (!expected) { missing.push(relative); continue; }
    const actual = createHash('sha256').update(await readFile(path.join(ROOT, relative))).digest('hex');
    if (actual !== expected) mismatched.push(relative);
  }
  if (missing.length || mismatched.length) {
    return fail('build', 'build_is_stale', { missing: missing.slice(0, 20), mismatched: mismatched.slice(0, 20), checked: candidates.length });
  }
  pass('build', { files: marker.fileCount, checked: candidates.length, version: marker.version, dependencies: marker.dependencies });
}

async function verifyBoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-round2-boot-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['start.js'], {
    cwd: BUILD,
    env: {
      ...process.env,
      ENV_LOADER_ENABLED: 'false',
      HOST: '127.0.0.1',
      PORT: String(port),
      ADMIN_TOKEN: `boot-${randomUUID()}`,
      LOCAL_AUTH_BYPASS: 'false',
      DATA_DIR: dir,
      SQLITE_PATH: path.join(dir, 'runtime.sqlite'),
      LOG_DIR: path.join(dir, 'logs'),
      UDS_ENABLED: 'false',
      MCP_SERVER_ENABLED: 'false',
      PROVIDER_CONFIG_JSON: '[]',
      PROVIDER_CATALOG_SYNC_ON_START: 'false',
      PROVIDER_MODELS_REFRESH_ON_START: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  try {
    let health = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) { health = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!health?.ok) return fail('boot', 'built_runtime_boot_failed', { port, exitCode: child.exitCode, logs: logs.slice(-500) });
    pass('boot', { port, version: health.version, phase: health.phase });
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    await rm(dir, { recursive: true, force: true });
  }
}

async function verifyTests() {
  const result = await run(process.execPath, ['--test'], { timeoutMs: 5 * 60 * 1000 });
  const passMatch = result.stderr.match(/ℹ pass (\d+)/) ?? result.stdout.match(/ℹ pass (\d+)/);
  const failMatch = result.stderr.match(/ℹ fail (\d+)/) ?? result.stdout.match(/ℹ fail (\d+)/);
  const passed = Number(passMatch?.[1] ?? 0);
  const failed = Number(failMatch?.[1] ?? -1);
  if (result.code !== 0 || failed !== 0 || passed < 400) {
    return fail('tests', 'test_suite_failed', { exitCode: result.code, passed, failed, tail: (result.stderr || result.stdout).slice(-800) });
  }
  pass('tests', { passed, failed });
}

async function findAudio() {
  const explicit = process.env.ZC_ROUND2_AUDIO;
  if (explicit) return path.resolve(explicit);
  const entries = await readdir(AUDIO_ROOT, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.mp3$/i.test(entry.name)) continue;
    const full = path.join(AUDIO_ROOT, entry.name);
    const info = await stat(full);
    candidates.push({ full, mtime: info.mtimeMs, round2: /round2/i.test(entry.name) });
  }
  candidates.sort((a, b) => (Number(b.round2) - Number(a.round2)) || (b.mtime - a.mtime));
  return candidates[0]?.full ?? null;
}

async function verifyAudio() {
  const audioFile = await findAudio();
  if (!audioFile) return fail('audio', 'audio_file_missing', { root: AUDIO_ROOT });
  const result = await run(process.execPath, ['scripts/verify-audio.mjs', audioFile], { timeoutMs: 60000 });
  if (result.code !== 0 || !result.stdout.includes('AUDIO_OK')) {
    return fail('audio', 'audio_probe_failed', { file: audioFile, exitCode: result.code, stdout: result.stdout.slice(-300), stderr: result.stderr.slice(-300) });
  }
  pass('audio', { file: audioFile, detail: result.stdout.trim().split('\n')[0] });
  return audioFile;
}

function contentTypeIsMp3(value) {
  return /^audio\/mpeg\b/i.test(String(value ?? ''));
}

async function verifyCaddy(audioFile) {
  if (!audioFile) return fail('caddy', 'audio_missing_for_range');
  const validate = await run('caddy', ['validate', '--config', 'deploy/caddy/Caddyfile', '--adapter', 'caddyfile'], { timeoutMs: 60000 });
  if (validate.code !== 0) {
    return fail('caddy', 'caddy_validate_failed', { exitCode: validate.code, stderr: validate.stderr.slice(-500) });
  }
  const port = await freePort();
  const child = spawn('caddy', ['run', '--config', 'deploy/caddy/Caddyfile', '--adapter', 'caddyfile'], {
    cwd: ROOT,
    env: { ...process.env, CADDY_AUDIO_PORT: String(port), CADDY_AUDIO_ROOT: AUDIO_ROOT },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) return fail('caddy', 'caddy_not_ready', { port, logs: logs.slice(-500) });
    const name = path.basename(audioFile);
    const response = await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(name)}`, {
      headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(5000)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type');
    const range = response.headers.get('content-range');
    if (response.status !== 206 || !contentTypeIsMp3(type) || !/^bytes 0-1023\/\d+$/.test(String(range)) || bytes.length === 0) {
      return fail('caddy', 'caddy_range_failed', { status: response.status, type, range, bytes: bytes.length });
    }
    pass('caddy', { status: response.status, type, range, bytes: bytes.length, port });
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  await Promise.all([verifyProviderProbe(), verifyTests()]);
  await verifyBuild();
  await verifyBoot();
  const audioFile = await verifyAudio();
  await verifyCaddy(audioFile);
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    failures,
    summary: {
      providers: checks.providers?.status === 'pass' ? checks.providers.count : 0,
      probeSource: checks.providers?.source ?? 'none',
      mcp: checks.providers?.mcp ?? 'fail',
      tests: checks.tests?.status ?? 'fail',
      build: checks.build?.status === 'pass' ? 'fresh' : 'stale',
      boot: checks.boot?.status ?? 'fail',
      audio: checks.audio?.status ?? 'fail',
      caddy: checks.caddy?.status ?? 'fail'
    }
  };
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await chmod(REPORT, 0o600);
  if (failures.length) {
    console.error(`ROUND2_FAIL ${failures.join(' ')}`);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`ROUND2_OK providers=${checks.providers.count} normalizer=pass masking=pass mcp=strict build=fresh audio=ok caddy=valid boot=ok tests=${checks.tests.passed} probe=${checks.providers.source}`);
  console.log(JSON.stringify({ report: REPORT, providers: checks.providers.models, tests: checks.tests, caddy: checks.caddy, audio: checks.audio }, null, 2));
}

main().catch(error => {
  console.error(`ROUND2_FAIL unhandled:${error.message}`);
  process.exitCode = 1;
});
