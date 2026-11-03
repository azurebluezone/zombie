// Boots a disposable runtime and verifies the two halves of the logging contract:
// the JSONL file stays structured, and the terminal gets readable startup lines.
// A fixture provider is used only to make provider/model counts non-zero; no
// upstream call is made, so this proves logging, not inference.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? ` ${detail}` : ''}`);
}

const port = await freePort();
const dir = await mkdtemp(path.join(tmpdir(), 'zc-log-verify-'));
const env = {
  ...process.env,
  ENV_LOADER_ENABLED: 'false',
  HOST: '127.0.0.1',
  PORT: String(port),
  ADMIN_TOKEN: 'phase83-logging-admin-token',
  PROVIDER_CONFIG_JSON: JSON.stringify([{
    id: 'fixture-provider',
    name: 'Fixture Provider',
    baseUrl: 'http://127.0.0.1:9/v1',
    driver: 'openai-compatible',
    protocol: 'openai-compatible',
    models: ['fixture-model'],
    defaultModel: 'fixture-model',
    enabled: true,
    capabilities: ['chat-completions', 'streaming', 'model-catalog'],
    priority: 1
  }]),
  DATA_DIR: path.join(dir, 'data'),
  SQLITE_PATH: path.join(dir, 'data', 'runtime.sqlite'),
  LOG_DIR: path.join(dir, 'logs'),
  LOG_FILE: 'runtime.jsonl',
  LOG_TO_STDOUT: 'true',
  LOG_PRETTY: 'true',
  UDS_ENABLED: 'false',
  PROVIDER_CATALOG_SYNC_ON_START: 'false',
  EXTERNAL_MCP_URLS: '',
  PROJECT_ROOTS: '',
  ZOMBIECODER_EXECUTION_MODE: 'chat-only',
  MEMORY_LOG_INTERVAL_MS: '0'
};

const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

async function stop() {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) fail('runtime_exited', `code=${child.exitCode} stderr=${stderr.slice(0, 400)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) { healthy = true; break; }
    } catch { /* not listening yet */ }
    await delay(100);
  }
  if (!healthy) fail('runtime_not_healthy', `stderr=${stderr.slice(0, 400)}`);
  await delay(500);

  const raw = await readFile(path.join(dir, 'logs', 'runtime.jsonl'), 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { fail('jsonl_parse_failed', `line=${line.slice(0, 200)}`); }
  }

  const summary = rows.find(row => row.event === 'runtime.startup_summary');
  if (!summary) fail('startup_summary_missing');
  if (!(summary.providers > 0)) fail('provider_count_zero');
  if (!(summary.models > 0)) fail('model_count_zero');
  if (!(summary.agents > 0)) fail('agent_count_zero');
  if (!(summary.tools > 0)) fail('tool_count_zero');
  if (summary.publicModels !== 3) fail('public_model_count_wrong', `got=${summary.publicModels}`);
  if (!rows.some(row => row.event === 'runtime.startup_provider')) fail('startup_provider_missing');
  if (!rows.some(row => row.event === 'runtime.started')) fail('runtime_started_missing');

  if (!/^\d{2}:\d{2}:\d{2} ✓ INFO  runtime\.startup_summary +/m.test(stdout)) fail('pretty_summary_missing', `stdout=${stdout.slice(-400)}`);
  if (!/^\d{2}:\d{2}:\d{2} ✓ INFO  runtime\.startup_provider +/m.test(stdout)) fail('pretty_provider_missing', `stdout=${stdout.slice(-400)}`);
  if (stdout.trimStart().startsWith('{"')) fail('stdout_still_raw_json');

  console.log(`LOG_SYSTEM_OK providers=${summary.providers} models=${summary.models} agents=${summary.agents} tools=${summary.tools} pretty=ok jsonl=ok`);
} catch (error) {
  console.error(`LOG_SYSTEM_FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
