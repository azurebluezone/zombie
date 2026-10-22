import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// The runtime used to ship two HTML files (chat + admin) and read them with
// readFile(). Both were frontends: they held a token, called /v1/admin/*, and
// made the server's startup depend on files that a UI repository should own.
// The boundary is now explicit — the runtime is API-only. These tests pin it.

test('phase61 the runtime ships no bundled frontend directory', async () => {
  await assert.rejects(
    access(new URL('../public', import.meta.url)),
    'public/ must not exist in the runtime tree'
  );
});

test('phase61 the server never reads an HTML page from disk', async () => {
  const server = await read('src/server.js');
  assert.equal(/fromRoot\(\s*'public'/.test(server), false, 'server must not resolve files under public/');
  assert.equal(/readFile\([^)]*\.html/.test(server), false, 'server must not read .html files');
  assert.match(server, /frontend_not_bundled/, 'the old page routes answer with a typed 410');
});

test('phase61 the build does not copy a frontend into dist', async () => {
  const build = await read('scripts/build-runtime.mjs');
  assert.equal(/entries=\[[^\]]*'public'/.test(build), false, 'build entries must not include public');
  assert.equal(/protectedRoots=\[[^\]]*'public'/.test(build), false, 'public is no longer a protected root');
});

test('phase61 the admin console is a separate client, not a runtime dependency', async () => {
  // admin-ui/ is shipped in the repository so a power loss cannot destroy the
  // console, but it is a client: the server never reads it and the build never
  // copies it into dist. Deleting the folder must leave the runtime intact.
  const server = await read('src/server.js');
  assert.equal(server.includes('admin-ui'), false, 'server must not reference the admin console');
  const build = await read('scripts/build-runtime.mjs');
  assert.equal(/entries=\[[^\]]*'admin-ui'/.test(build), false, 'build must not copy admin-ui');
  const { access } = await import('node:fs/promises');
  await access(new URL('../admin-ui/index.html', import.meta.url));
});

test('phase61 external UIs bootstrap from /v1/ui-config without a token', async () => {
  const server = await read('src/server.js');
  assert.match(server, /url\.pathname==='\/v1\/ui-config'/, 'the public bootstrap route exists');
  assert.match(server, /ui:\{bundled:false,admin:'external'\}/, 'the payload states that no UI is bundled');

  const start = server.indexOf("url.pathname==='/v1/ui-config'");
  const block = server.slice(start, start + 2200);
  assert.equal(/PROVIDER_KEY_|apiKey|adminToken|ADMIN_TOKEN\s*:/.test(block), false, 'no secret may be exposed by the public bootstrap');
  assert.equal(/providerId|provider:/.test(block), false, 'provider identity stays server-side');
});
