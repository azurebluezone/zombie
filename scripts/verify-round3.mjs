#!/usr/bin/env node
// Round-3 release gate. Fast checks run live; slow checks are read from a
// recorded real run whose source digest still matches this tree. A stale or
// foreign cache fails the gate instead of being reported as current evidence.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_ROOT = process.env.CADDY_AUDIO_ROOT || '/home/sahon/Music/work mp3';
const REPORT = path.join(ROOT, 'data/round3-verification.json');
const PROBE_CACHE = path.join(ROOT, 'data/round2-provider-probe.json');
const PROBE_META = path.join(ROOT, 'data/round2-provider-probe.meta.json');
const MATRIX_ARTIFACT = path.join(ROOT, 'data/agent-mcp-matrix.json');
const RUNTIME = 'http://127.0.0.1:9999';
const UPSTREAM = 'http://127.0.0.1:9933';
const MAX_PROBE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MATRIX_AGE_MS = 48 * 60 * 60 * 1000;
const EXPECTED_PROVIDERS = ['ollama-cloud-openai', 'ollama-cloud-native', 'gemini', 'groq'];
const CONTRACT_TESTS = [
  'tests/phase85-official-doc-alignment.test.js',
  'tests/phase36-boot-provider-runtime.test.js',
  'tests/phase55-mcp-truthfulness.test.js',
  'tests/phase58-mcp-server.test.js'
];

const checks = {};
const failures = [];
const notTested = [];

function record(name, status, detail = {}) {
  checks[name] = { status, ...detail };
  if (status === 'fail') failures.push(`${name}:${detail.reason ?? 'failed'}`);
  if (status === 'NOT_TESTED') notTested.push(`${name}:${detail.reason ?? 'not tested'}`);
}
function pass(name, detail = {}) { record(name, 'pass', detail); }
function fail(name, reason, detail = {}) { record(name, 'fail', { reason, ...detail }); }
function skip(name, reason, detail = {}) { record(name, 'NOT_TESTED', { reason, ...detail }); }

function run(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-500000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-200000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

export async function computeSourceDigest() {
  const relatives = ['package.json', 'scripts/round2-provider-probe.mjs', 'src/mcp/client.js', 'src/server.js'];
  for (const file of await walkFiles(path.join(ROOT, 'src/providers'))) {
    if (file.endsWith('.js')) relatives.push(path.relative(ROOT, file));
  }
  const rows = [];
  for (const relative of [...new Set(relatives)].sort()) {
    rows.push(`${relative}:${sha256(await readFile(path.join(ROOT, relative)))}`);
  }
  return sha256(rows.join('\n'));
}

export async function writeProbeCache(result) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(path.dirname(PROBE_CACHE), { recursive: true });
  await writeFile(PROBE_CACHE, text, { mode: 0o600 });
  const meta = {
    createdAt: new Date().toISOString(),
    sourceDigest: await computeSourceDigest(),
    command: 'node scripts/round2-provider-probe.mjs',
    providers: result.providers?.map(provider => provider.id) ?? [],
    mcpTools: result.mcp?.tools ?? null,
    artifactSha256: sha256(text)
  };
  await writeFile(PROBE_META, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  return meta;
}

function parseCounts(text) {
  const grab = regex => {
    const match = text.match(regex);
    return match ? Number(match[1]) : null;
  };
  return {
    tests: grab(/ℹ tests (\d+)/),
    pass: grab(/ℹ pass (\d+)/),
    fail: grab(/ℹ fail (\d+)/),
    skipped: grab(/ℹ skipped (\d+)/),
    cancelled: grab(/ℹ cancelled (\d+)/)
  };
}

async function verifyTests() {
  const result = await run(process.execPath, ['--test'], { timeoutMs: 90000 });
  const counts = parseCounts(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || counts.fail !== 0 || counts.skipped !== 0 || !counts.pass || counts.pass < 445) {
    return fail('tests', 'test_suite_failed', {
      exitCode: result.code,
      ...counts,
      tail: (result.stderr || result.stdout).slice(-800)
    });
  }
  pass('tests', counts);
}

async function verifyContract() {
  const result = await run(process.execPath, ['--test', ...CONTRACT_TESTS], { timeoutMs: 90000 });
  const counts = parseCounts(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || counts.fail !== 0 || !counts.pass) {
    return fail('contract', 'contract_tests_failed', {
      exitCode: result.code,
      ...counts,
      tail: (result.stderr || result.stdout).slice(-800)
    });
  }
  const [ollama, gemini, matrix, client] = await Promise.all([
    readFile(path.join(ROOT, 'src/providers/adapters/ollama.js'), 'utf8'),
    readFile(path.join(ROOT, 'src/providers/adapters/gemini.js'), 'utf8'),
    readFile(path.join(ROOT, 'scripts/agent-mcp-matrix.mjs'), 'utf8'),
    readFile(path.join(ROOT, 'src/mcp/client.js'), 'utf8')
  ]);
  const sentinels = {
    ollama_tool_name: ollama.includes('tool_name'),
    ollama_function_index: ollama.includes('index:'),
    gemini_function_response_object: gemini.includes('functionResponseValue') && gemini.includes('{ result:'),
    gemini_tool_call_id: gemini.includes('tool_call_id ? { id:'),
    matrix_protocol_header: matrix.includes("headers['mcp-protocol-version']"),
    current_spec_version: client.includes("CURRENT_MCP_SPEC_VERSION = '2026-07-28'"),
    spec_gap: client.includes("MCP_SPEC_GAP = '2026-07-28_not_implemented'")
  };
  const missing = Object.entries(sentinels).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) return fail('contract', 'contract_sentinel_missing', { missing, sentinels });
  pass('contract', { tests: counts.pass, sentinels });
}

async function verifyProviderCache() {
  let text;
  let result;
  let meta;
  try {
    text = await readFile(PROBE_CACHE, 'utf8');
    result = JSON.parse(text);
    meta = JSON.parse(await readFile(PROBE_META, 'utf8'));
  } catch (error) {
    return fail('providers', 'probe_cache_missing', { detail: error.message });
  }
  const ageMs = Date.now() - Date.parse(meta.createdAt);
  const digest = await computeSourceDigest();
  if (meta.sourceDigest !== digest) {
    return fail('providers', 'probe_source_changed', { cacheDigest: meta.sourceDigest, currentDigest: digest });
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_PROBE_AGE_MS) {
    return fail('providers', 'probe_cache_stale', { ageHours: Number.isFinite(ageMs) ? Number((ageMs / 3600000).toFixed(2)) : null });
  }
  if (meta.artifactSha256 && meta.artifactSha256 !== sha256(text)) {
    return fail('providers', 'probe_artifact_hash_mismatch', { claimed: meta.artifactSha256, actual: sha256(text) });
  }
  const providers = Array.isArray(result.providers) ? result.providers : [];
  const ids = providers.map(provider => provider.id).sort();
  const bad = providers.filter(provider => provider.status !== 'PASS'
    || !provider.checks?.tool?.pass || !provider.checks?.stream?.pass || !provider.checks?.toolLoop?.pass);
  if (result.ok !== true || bad.length || ids.join(',') !== [...EXPECTED_PROVIDERS].sort().join(',')) {
    return fail('providers', 'provider_probe_failed', {
      ok: result.ok,
      ids,
      bad: bad.map(provider => ({ id: provider.id, status: provider.status, error: provider.error ?? null })),
      errors: result.errors ?? []
    });
  }
  if (result.mcp?.status !== 'PASS' || result.mcp?.tools !== 28) {
    return fail('providers', 'probe_mcp_failed', { mcp: result.mcp ?? null });
  }
  if ((result.errors ?? []).length || (result.runtimeErrors ?? []).length) {
    return fail('providers', 'probe_reported_errors', { errors: result.errors ?? [], runtimeErrors: result.runtimeErrors ?? [] });
  }
  pass('providers', {
    source: 'cached-real-run',
    probeAt: meta.createdAt,
    ageHours: Number((ageMs / 3600000).toFixed(2)),
    count: providers.length,
    models: Object.fromEntries(providers.map(provider => [provider.id, provider.model])),
    mcpTools: result.mcp.tools,
    artifactSha256: meta.artifactSha256
  });
}

function parseRpcBody(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const data = trimmed.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  for (let index = data.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(data[index]); } catch {}
  }
  return null;
}

let rpcId = 0;
async function postRpc({ method, params = {}, session, version, notification = false, timeoutMs = 15000 }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (session) headers['mcp-session-id'] = session;
  if (version) headers['mcp-protocol-version'] = version;
  const payload = notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: ++rpcId, method, params };
  const response = await fetch(`${RUNTIME}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  return {
    status: response.status,
    session: response.headers.get('mcp-session-id'),
    version: response.headers.get('mcp-protocol-version'),
    body: parseRpcBody(text),
    text
  };
}

async function verifyLiveMcp() {
  let health;
  try {
    const response = await fetch(`${RUNTIME}/health`, { signal: AbortSignal.timeout(5000) });
    health = await response.json();
    if (response.status !== 200 || health.ok !== true) throw new Error(`health_${response.status}`);
  } catch (error) {
    return fail('liveMcp', 'runtime_unreachable', { detail: error.message });
  }

  let config;
  try {
    const response = await fetch(`${RUNTIME}/api/config/mcp`, { signal: AbortSignal.timeout(5000) });
    config = await response.json();
    if (response.status !== 200) throw new Error(`config_${response.status}`);
  } catch (error) {
    return fail('liveMcp', 'mcp_config_unreachable', { detail: error.message });
  }
  const configProblems = [];
  if (config.current_spec_version !== '2026-07-28') configProblems.push('current_spec_version');
  if (config.spec_gap !== '2026-07-28_not_implemented') configProblems.push('spec_gap');
  if (config.server?.implemented !== true) configProblems.push('server_not_implemented');
  if (!Array.isArray(config.server?.supported_protocol_versions)
    || !config.server.supported_protocol_versions.includes('2025-11-25')) configProblems.push('supported_protocol_versions');
  if (!Array.isArray(config.server?.tools) || config.server.tools.length !== 28) configProblems.push('server_tools');
  if (configProblems.length) {
    return fail('liveMcp', 'mcp_config_mismatch', {
      problems: configProblems,
      current_spec_version: config.current_spec_version ?? null,
      spec_gap: config.spec_gap ?? null,
      server_tools: config.server?.tools?.length ?? null
    });
  }

  try {
    const init = await postRpc({
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'round3-gate', version: '1' }
      }
    });
    if (init.status !== 200 || !init.session || init.body?.result?.protocolVersion !== '2025-11-25') {
      return fail('liveMcp', 'initialize_failed', { status: init.status, session: Boolean(init.session), body: init.body });
    }
    const session = init.session;
    const version = init.body.result.protocolVersion;

    const notify = await postRpc({ method: 'notifications/initialized', session, version, notification: true });
    if (notify.status !== 202) return fail('liveMcp', 'initialized_failed', { status: notify.status });

    const list = await postRpc({ method: 'tools/list', params: {}, session, version });
    const tools = list.body?.result?.tools ?? [];
    if (list.status !== 200 || tools.length !== 28) {
      return fail('liveMcp', 'tools_list_failed', { status: list.status, tools: tools.length });
    }

    const noVersion = await postRpc({ method: 'tools/list', params: {}, session });
    const badVersion = await postRpc({ method: 'tools/list', params: {}, session, version: '1999-01-01' });
    const mismatch = await postRpc({ method: 'tools/list', params: {}, session, version: '2025-06-18' });
    if (noVersion.status !== 400 || badVersion.status !== 400 || mismatch.status !== 400) {
      return fail('liveMcp', 'protocol_version_not_fail_closed', {
        noVersion: noVersion.status,
        badVersion: badVersion.status,
        mismatch: mismatch.status
      });
    }

    const echo = await postRpc({
      method: 'tools/call',
      params: {
        name: 'runtime_echo',
        arguments: { value: 'ZC_ROUND3_MCP_OK' },
        _meta: { projectRoot: ROOT }
      },
      session,
      version
    });
    const echoText = echo.body?.result?.content?.[0]?.text ?? '';
    if (echo.status !== 200 || echo.body?.result?.isError === true || !echoText.includes('ZC_ROUND3_MCP_OK')) {
      return fail('liveMcp', 'tools_call_failed', { status: echo.status, isError: echo.body?.result?.isError ?? null, text: echoText.slice(0, 200) });
    }

    const deleted = await fetch(`${RUNTIME}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': session, 'mcp-protocol-version': version },
      signal: AbortSignal.timeout(5000)
    });
    if (deleted.status !== 204) return fail('liveMcp', 'session_delete_failed', { status: deleted.status });

    pass('liveMcp', {
      runtime: { version: health.version, pid: health.runtime?.pid ?? null, port: health.runtime?.port ?? null },
      negotiated: version,
      tools: tools.length,
      echo: 'ZC_ROUND3_MCP_OK',
      failClosed: { noVersion: noVersion.status, badVersion: badVersion.status, mismatch: mismatch.status },
      delete: deleted.status,
      config: { current_spec_version: config.current_spec_version, spec_gap: config.spec_gap }
    });
  } catch (error) {
    return fail('liveMcp', 'mcp_probe_error', { detail: error.message });
  }
}

async function verifyMatrix() {
  let text;
  let artifact;
  try {
    text = await readFile(MATRIX_ARTIFACT, 'utf8');
    artifact = JSON.parse(text);
  } catch (error) {
    return fail('matrix', 'matrix_artifact_missing', { detail: error.message });
  }
  const claimed = artifact.artifactSha256;
  const copy = { ...artifact };
  delete copy.artifactSha256;
  const actual = sha256(JSON.stringify(copy));
  if (claimed !== actual) return fail('matrix', 'matrix_artifact_hash_mismatch', { claimed, actual });

  const problems = [];
  if (!/^matrix-/.test(String(artifact.runId ?? ''))) problems.push('runId_invalid');
  if (!Array.isArray(artifact.agents) || artifact.agents.length !== 12) problems.push(`agents_${artifact.agents?.length ?? 0}`);
  for (const agent of artifact.agents ?? []) {
    if (agent.httpStatus !== 200 || agent.ok !== true || agent.providerId !== 'llama-cpu' || agent.sentinelMatched !== true) {
      problems.push(`agent_incomplete_${agent.agentId}`);
    }
  }
  if (!Array.isArray(artifact.tools) || artifact.tools.length !== 28) problems.push(`tools_${artifact.tools?.length ?? 0}`);
  for (const tool of artifact.tools ?? []) if (tool.called !== true) problems.push(`tool_not_called_${tool.toolId}`);
  if (artifact.mcp?.toolsListed !== 28) problems.push(`mcp_tools_${artifact.mcp?.toolsListed ?? 0}`);
  if (artifact.uds?.ok !== true) problems.push('uds_not_ok');
  if (artifact.upstream?.chatSentinel !== true) problems.push('upstream_chat_not_ok');
  if (problems.length) {
    return fail('matrix', 'matrix_artifact_incomplete', { runId: artifact.runId ?? null, problems: problems.slice(0, 20) });
  }
  const ageMs = Date.now() - Date.parse(artifact.finishedAt ?? artifact.startedAt ?? 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_MATRIX_AGE_MS) {
    return fail('matrix', 'matrix_artifact_stale', { ageHours: Number.isFinite(ageMs) ? Number((ageMs / 3600000).toFixed(2)) : null });
  }
  pass('matrix', {
    source: 'cached-real-run',
    runId: artifact.runId,
    finishedAt: artifact.finishedAt,
    ageHours: Number((ageMs / 3600000).toFixed(2)),
    agents: artifact.summary?.agentsOk ?? null,
    toolsCalled: artifact.summary?.toolsCalled ?? null,
    toolsPass: artifact.summary?.toolsPass ?? null,
    toolsNotTested: artifact.summary?.toolsNotTested ?? null,
    mcpTools: artifact.mcp.toolsListed,
    uds: 'ok',
    upstream: 'ok'
  });

  let upstreamStatus = null;
  try {
    const response = await fetch(`${UPSTREAM}/v1/models`, { signal: AbortSignal.timeout(3000) });
    upstreamStatus = response.status;
  } catch {}
  skip('matrixLive', upstreamStatus === 200 ? 'full_matrix_not_rerun_in_gate' : 'llama_engine_unreachable', {
    upstreamStatus,
    cachedRunId: artifact.runId
  });
}

async function verifyDocs() {
  const files = {
    readme: await readFile(path.join(ROOT, 'README.md'), 'utf8'),
    design: await readFile(path.join(ROOT, 'docs/DESIGN_FLOW.md'), 'utf8'),
    journey: await readFile(path.join(ROOT, 'docs/JOURNEY.md'), 'utf8'),
    status: await readFile(path.join(ROOT, 'docs/PROJECT_STATUS.md'), 'utf8'),
    fresh: await readFile(path.join(ROOT, 'docs/FRESH_INSTALL.md'), 'utf8')
  };
  const problems = [];
  const need = (name, text, needles) => {
    for (const needle of needles) if (!text.includes(needle)) problems.push(`${name}_missing_${needle}`);
  };
  const forbid = (name, text, needles) => {
    for (const needle of needles) if (text.includes(needle)) problems.push(`${name}_stale_${needle}`);
  };
  need('readme', files.readme, ['445 tests', '28 runnable tools', '2026-07-28', '2026-07-28_not_implemented', '2025-11-25']);
  forbid('readme', files.readme, ['409 tests', '408 passing', 'same 25 runnable tools']);
  need('design', files.design, ['445 tests, 445 pass']);
  need('journey', files.journey, ['445 tests', '/home/sahon/zombie']);
  need('status', files.status, ['445/445', '2026-11-03', '/home/sahon/zombie', '2026-07-28', 'spec_gap', 'Historical note']);
  forbid('status', files.status, ['/home/xubuntu/zombie']);
  need('fresh', files.fresh, ['mcp-protocol-version: 2025-11-25']);
  if (problems.length) return fail('docs', 'docs_mismatch', { problems });
  pass('docs', { files: Object.keys(files), checked: ['test-count', 'tool-count', 'mcp-spec-gap', 'mcp-header', 'current-paths'] });
}

async function findAudio() {
  const explicit = process.env.ZC_ROUND3_AUDIO;
  if (explicit) return path.resolve(explicit);
  const entries = await readdir(AUDIO_ROOT, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^zombiecoder-round3.*\.mp3$/i.test(entry.name)) continue;
    const full = path.join(AUDIO_ROOT, entry.name);
    const info = await stat(full);
    candidates.push({ full, mtime: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  return candidates[0]?.full ?? null;
}

async function verifyAudio() {
  const file = await findAudio();
  if (!file) return fail('audio', 'audio_file_missing', { root: AUDIO_ROOT });
  const result = await run(process.execPath, ['scripts/verify-audio.mjs', file], { timeoutMs: 60000 });
  if (result.code !== 0 || !result.stdout.includes('AUDIO_OK')) {
    return fail('audio', 'audio_probe_failed', {
      file,
      exitCode: result.code,
      stdout: result.stdout.slice(-300),
      stderr: result.stderr.slice(-300)
    });
  }
  const base = file.replace(/\.mp3$/i, '');
  const sidecars = { srt: `${base}.srt`, transcript: `${base}.transcript.txt` };
  const missing = [];
  for (const [kind, sidecar] of Object.entries(sidecars)) {
    try {
      const info = await stat(sidecar);
      if (info.size <= 0) missing.push(`${kind}:empty`);
    } catch {
      missing.push(`${kind}:missing`);
    }
  }
  if (missing.length) return fail('audio', 'audio_sidecar_missing', { file, missing });
  const transcript = await readFile(sidecars.transcript, 'utf8');
  if (!transcript.includes('রাউন্ড থ্রি')) return fail('audio', 'audio_transcript_wrong_round', { file });
  pass('audio', {
    file,
    detail: result.stdout.trim().split('\n')[0],
    srt: path.basename(sidecars.srt),
    transcript: path.basename(sidecars.transcript),
    transcriptBytes: Buffer.byteLength(transcript)
  });
}

async function recordProbe() {
  const result = await run(process.execPath, ['scripts/round2-provider-probe.mjs'], { timeoutMs: 15 * 60 * 1000 });
  if (result.code !== 0) {
    console.error(`PROBE_RECORD_FAIL exit=${result.code} ${result.stderr.slice(-500)}`);
    process.exitCode = 1;
    return;
  }
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    console.error('PROBE_RECORD_FAIL output_not_json');
    process.exitCode = 1;
    return;
  }
  if (probe.ok !== true || probe.providers?.length !== 4) {
    console.error(`PROBE_RECORD_FAIL ok=${probe.ok} providers=${probe.providers?.length ?? 0}`);
    process.exitCode = 1;
    return;
  }
  const meta = await writeProbeCache(probe);
  console.log(`PROBE_RECORDED providers=${probe.providers.length} mcp=${probe.mcp?.tools ?? 0} digest=${meta.sourceDigest.slice(0, 12)}`);
}

async function main() {
  if (process.argv.includes('--record-probe')) {
    await recordProbe();
    return;
  }
  const startedAt = new Date().toISOString();
  await verifyTests();
  await verifyContract();
  await verifyProviderCache();
  await verifyLiveMcp();
  await verifyMatrix();
  await verifyDocs();
  await verifyAudio();

  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    failures,
    notTested,
    summary: {
      providers: checks.providers?.status === 'pass' ? checks.providers.count : 0,
      providerSource: checks.providers?.source ?? 'none',
      contract: checks.contract?.status ?? 'fail',
      tests: checks.tests?.pass ?? 0,
      liveMcp: checks.liveMcp?.status ?? 'fail',
      mcpTools: checks.liveMcp?.tools ?? 0,
      matrix: checks.matrix?.status === 'pass' ? checks.matrix.source : 'fail',
      matrixLive: checks.matrixLive?.status ?? 'NOT_TESTED',
      docs: checks.docs?.status ?? 'fail',
      audio: checks.audio?.status ?? 'fail'
    }
  };
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  if (failures.length) {
    console.error(`ROUND3_FAIL ${failures.join(' ')}`);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(`ROUND3_OK providers=${checks.providers.count} contract=${checks.contract.tests} tests=${checks.tests.pass} mcp=${checks.liveMcp.tools} matrix=${checks.matrix.source} matrix_live=NOT_TESTED(${checks.matrixLive.reason}) docs=ok audio=ok`);
  console.log(JSON.stringify({
    report: REPORT,
    providers: checks.providers.models,
    tests: checks.tests,
    liveMcp: checks.liveMcp,
    matrix: checks.matrix,
    matrixLive: checks.matrixLive,
    docs: checks.docs,
    audio: checks.audio
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`ROUND3_FAIL unhandled:${error.message}`);
    process.exitCode = 1;
  });
}
