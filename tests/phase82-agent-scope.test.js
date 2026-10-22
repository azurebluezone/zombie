import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TOOL_BOUNDARY,
  TOOL_BOUNDARY_GLOBAL,
  TOOL_BOUNDARY_WORKING_DIRECTORY,
  normalizeAgentAccess,
  resolveAgentAccess
} from '../src/agents/access.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// Pure scope model
// ---------------------------------------------------------------------------

test('phase82 the default boundary pins an agent instead of handing it the host', () => {
  assert.equal(DEFAULT_TOOL_BOUNDARY, TOOL_BOUNDARY_WORKING_DIRECTORY);
  assert.deepEqual(normalizeAgentAccess({}), { toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY, workingDirectory: null });
  // A typo must fall back to the pinned default, never to `global`.
  assert.deepEqual(normalizeAgentAccess({ toolBoundary: 'globl' }), { toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY, workingDirectory: null });
});

test('phase82 working-directory ignores the caller root and pins to the stored directory', () => {
  const access = resolveAgentAccess(
    { toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY, workingDirectory: '/srv/project' },
    { requestedRoot: '/etc', defaultRoot: '/srv/default' }
  );
  assert.equal(access.toolBoundary, TOOL_BOUNDARY_WORKING_DIRECTORY);
  assert.equal(access.projectRoot, '/srv/project');
  assert.equal(access.workingDirectory, '/srv/project');
  assert.equal(access.allowAnyRoot, false);
  assert.equal(access.reason, 'agent_working_directory');
});

test('phase82 an unset directory falls back to the configured workspace, not the caller root', () => {
  const access = resolveAgentAccess(
    { toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY },
    { requestedRoot: '/etc', defaultRoot: '/srv/workspace' }
  );
  assert.equal(access.projectRoot, '/srv/workspace');
  assert.equal(access.allowAnyRoot, false);
  assert.equal(access.reason, 'agent_working_directory_unset');
});

test('phase82 global remains an explicit opt-in', () => {
  const access = resolveAgentAccess(
    { toolBoundary: TOOL_BOUNDARY_GLOBAL },
    { requestedRoot: '/srv/project' }
  );
  assert.equal(access.toolBoundary, TOOL_BOUNDARY_GLOBAL);
  assert.equal(access.projectRoot, '/srv/project');
  assert.equal(access.allowAnyRoot, true);
});

// ---------------------------------------------------------------------------
// End-to-end: the boundary route and the tool path guard
// ---------------------------------------------------------------------------

test('phase82 an agent is pinned, and a read outside its directory is refused', async t => {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase82-scope-'));
  const dataDir = path.join(dir, 'data');
  const workspace = path.join(dir, 'workspace');
  const adminToken = 'phase82-admin-token';
  const insideFile = path.join(workspace, 'inside.txt');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(insideFile, 'inside-ok', 'utf8');

  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false', HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: adminToken, LOCAL_AUTH_BYPASS: 'false',
    TOOL_ACCESS_MODE: 'unrestricted',
    AGENT_DEFAULT_WORKING_DIRECTORY: workspace,
    PROVIDER_CONFIG_JSON: JSON.stringify([{ id: 'fixture-provider', name: 'Fixture', baseUrl: 'http://127.0.0.1:9/v1', driver: 'openai-compatible', protocol: 'openai-compatible', models: ['fixture-model'], defaultModel: 'fixture-model', enabled: false }]),
    DATA_DIR: dataDir, SQLITE_PATH: path.join(dataDir, 'runtime.sqlite'), LOG_DIR: path.join(dir, 'logs'), LOG_TO_STDOUT: 'false',
    UDS_ENABLED: 'false', PROVIDER_CATALOG_SYNC_ON_START: 'false', ZOMBIECODER_EXECUTION_MODE: 'tools-enabled',
    EXTERNAL_MCP_URLS: '', PROJECT_ROOTS: ''
  };

  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) assert.fail(`runtime exited ${child.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'runtime did not start');
  const base = `http://127.0.0.1:${port}`;
  const admin = { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` };

  // A fresh registry already carries the pinned default, and the configured
  // workspace is the effective root even though no agent stored one yet.
  const before = await (await fetch(`${base}/v1/admin/registry/agents/code-guru/boundary`, { headers: admin })).json();
  assert.equal(before.access.toolBoundary, TOOL_BOUNDARY_WORKING_DIRECTORY);
  assert.equal(before.effective.projectRoot, path.resolve(workspace));
  assert.equal(before.effective.allowAnyRoot, false);

  // A relative directory is refused: it would resolve against the runtime cwd
  // and change meaning across restarts.
  const relative = await fetch(`${base}/v1/admin/registry/agents/code-guru/boundary`, {
    method: 'PATCH', headers: admin,
    body: JSON.stringify({ toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY, workingDirectory: 'relative/path' })
  });
  assert.equal(relative.status, 400);
  const relativeError = await relative.json();
  assert.equal(relativeError.code ?? relativeError.error?.code, 'working_directory_not_absolute');

  // A symlink is accepted but stored canonically, so repointing it later cannot
  // silently move the agent's boundary.
  const link = path.join(dir, 'workspace-link');
  await symlink(workspace, link, 'dir');
  const linked = await fetch(`${base}/v1/admin/registry/agents/code-guru/boundary`, {
    method: 'PATCH', headers: admin,
    body: JSON.stringify({ toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY, workingDirectory: link })
  });
  assert.equal(linked.status, 200);
  assert.equal((await linked.json()).access.workingDirectory, await realpath(workspace));

  // An explicit pin through the same route the admin UI uses.
  const patched = await fetch(`${base}/v1/admin/registry/agents/code-guru/boundary`, {
    method: 'PATCH', headers: admin,
    body: JSON.stringify({ toolBoundary: TOOL_BOUNDARY_WORKING_DIRECTORY, workingDirectory: workspace })
  });
  assert.equal(patched.status, 200);
  const pin = await patched.json();
  assert.equal(pin.access.workingDirectory, workspace);
  assert.equal(pin.effective.projectRoot, path.resolve(workspace));

  const created = await (await fetch(`${base}/v1/admin/applications`, {
    method: 'POST', headers: admin, body: JSON.stringify({ name: 'phase82-scope-client' })
  })).json();
  const app = created.application;
  const apiKey = created.apiKey;
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };

  const run = async (file) => {
    const r = await fetch(`${base}/v1/execution/run`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        agent: 'code-guru', toolId: 'read_file', toolIds: ['read_file'],
        arguments: { path: file }, goal: `read ${file}`, consent: true
      })
    });
    return { status: r.status, body: await r.json() };
  };

  const inside = await run('inside.txt');
  assert.equal(inside.status, 200, JSON.stringify(inside.body));
  assert.match(JSON.stringify(inside.body.result), /inside-ok/);

  // The caller names an absolute path now. The agent's pinned root must win.
  const outside = await run('/etc/passwd');
  assert.notEqual(outside.status, 200, 'a read outside the pinned directory must not succeed');
  assert.match(JSON.stringify(outside.body), /outside|not_permitted|root|path/i);

  const revoked = await fetch(`${base}/v1/admin/applications/${app.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'revoked' })
  });
  assert.equal(revoked.status, 200);
});
