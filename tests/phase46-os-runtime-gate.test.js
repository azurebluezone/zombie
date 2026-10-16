import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('phase45 defaults to chat-only and blocks tool execution routes until explicitly enabled', async t => {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase45-gate-'));
  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false',
    HOST: '127.0.0.1', PORT: String(port),
    DATA_DIR: path.join(dir, 'data'), SQLITE_PATH: path.join(dir, 'data', 'runtime.sqlite'),
    LOG_DIR: path.join(dir, 'logs'), LOG_TO_STDOUT: 'false',
    UDS_ENABLED: 'false', PROVIDER_CATALOG_SYNC_ON_START: 'false',
    EXTERNAL_MCP_URLS: '', ZOMBIECODER_EXECUTION_MODE: 'chat-only'
  };
  const child = spawn(process.execPath, ['src/server.js'], {cwd:root, env, stdio:'ignore'});
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, {recursive:true,force:true});
  });
  let health;
  for (let i=0;i<80;i++) {
    if (child.exitCode !== null) assert.fail(`runtime exited with ${child.exitCode}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) { health=await response.json(); break; } } catch {}
    await delay(100);
  }
  assert.equal(health?.ok, true);
  assert.equal(health.executionMode, 'chat-only');
  for (const [route, payload] of [
    ['/v1/execution/run', {}],
    ['/v1/execution/stream', {}],
    ['/v1/mcp/tools/call', {qualifiedName:'example__noop',arguments:{}}],
    ['/v1/chat/completions', {autoToolLoop:true,consent:true,goal:'create file',toolIds:['create_file'],messages:[{role:'user',content:'create file'}]}]
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(response.status, 503, `${route} should be gated before auth/execution`);
    assert.equal((await response.json()).error, 'tool_execution_not_verified');
  }
});
