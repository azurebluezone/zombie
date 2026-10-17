/**
 * The user/token lifecycle, driven entirely over HTTP.
 *
 * The admin console is a client of the API, never the door to it: everything an operator
 * can click has to be doable with curl and nothing else. These tests therefore never read
 * public/admin/index.html. If a capability existed only in the console, this file could
 * not pass — which is what makes "the UI is not the decider" a check rather than a slogan.
 *
 * The second concern here is honesty of failure. A policy refusal that reaches the caller
 * as `request_failed` is a lie by omission: the operator cannot tell "you typed a date the
 * runtime cannot read" from "the process broke".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer as createNetServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {publicErrorCode, REQUEST_FAILED, PUBLIC_ERROR_CODES} from '../src/core/public-errors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_TOKEN = 'phase79-admin-token';
const VAULT_KEY = 'phase79-vault-key-abcdefghijklmnopqrstuvwxyz';

async function freePort() {
  const s = createNetServer();
  await new Promise((resolve, reject) => s.listen(0, '127.0.0.1', resolve).once('error', reject));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}

async function withRuntime(t, extra = {}) {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'zc-phase79-users-'));
  const env = {
    ...process.env,
    ENV_LOADER_ENABLED: 'false', HOST: '127.0.0.1', PORT: String(port),
    ADMIN_TOKEN,
    // Both names are set because the runtime reads the new one first and the old one as an
    // alias: a bypass left on would make the role gate unobservable and this file vacuous.
    LOOPBACK_AUTH_BYPASS: 'false', LOCAL_AUTH_BYPASS: 'false',
    TOKEN_ENCRYPTION_KEY: VAULT_KEY, APP_RATE_LIMIT: '60', APP_CONCURRENCY: '4',
    DATA_DIR: path.join(dir, 'data'), SQLITE_PATH: path.join(dir, 'data', 'runtime.sqlite'),
    LOG_DIR: path.join(dir, 'logs'), LOG_TO_STDOUT: 'false', UDS_ENABLED: 'false',
    PROVIDER_CATALOG_SYNC_ON_START: 'false', ZOMBIECODER_EXECUTION_MODE: 'chat-only',
    EXTERNAL_MCP_URLS: '', PROJECT_ROOTS: '',
    ...extra
  };
  const child = spawn(process.execPath, ['src/server.js'], {cwd: root, env, stdio: 'ignore'});
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, {recursive: true, force: true});
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`runtime exited ${child.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'runtime did not start');
  return {base: `http://127.0.0.1:${port}`};
}

const asAdmin = (method = 'POST', payload) => ({
  method,
  headers: {'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}`},
  ...(payload === undefined ? {} : {body: JSON.stringify(payload)})
});
const asToken = key => ({headers: {authorization: `Bearer ${key}`}});
/** 4xx/5xx bodies are rewritten into an OpenAI-style envelope, so the code lives under .message. */
const codeOf = body => (body && body.error && typeof body.error === 'object' ? body.error.message : body?.error ?? null);

test('phase79 the whole user/token lifecycle works over HTTP with no browser and no console', async t => {
  const {base} = await withRuntime(t);

  // 1. create the user and the term — this is the monthly sale
  const endOfTerm = new Date(Date.now() + 20 * 86400000).toISOString();
  let r = await fetch(`${base}/v1/admin/applications`, asAdmin('POST', {name: 'client shop', role: 'user', expiresAt: endOfTerm, limits: {rateLimit: 30}}));
  assert.equal(r.status, 201);
  const created = await r.json();
  const apiKey = created.apiKey;
  const userId = created.application.id;
  assert.match(apiKey, /^zc_[A-Za-z0-9_-]{20,}$/);

  // 2. the client's own application resolves the token and learns the term
  r = await fetch(`${base}/v1/auth/verify`, asToken(apiKey));
  assert.equal(r.status, 200);
  const verified = await r.json();
  assert.equal(verified.verified, true);
  assert.equal(verified.user.name, 'client shop');
  assert.equal(verified.user.role, 'user');
  assert.equal(verified.expiresAt, new Date(endOfTerm).toISOString());
  assert.equal(verified.limits.rateLimit, 30);

  // 3. the operator can read the token back, and the listing still carries nothing secret
  r = await fetch(`${base}/v1/admin/applications/${userId}/token`, asToken(ADMIN_TOKEN));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).apiKey, apiKey, 'the same token comes back, not a replacement');
  r = await fetch(`${base}/v1/admin/applications`, asToken(ADMIN_TOKEN));
  const listing = await r.text();
  assert.equal(listing.includes(apiKey), false, 'a listing must never carry a token');
  assert.equal(listing.includes('apiKeyHash'), false);
  assert.equal(listing.includes('apiKeyVault'), false);

  // 4. a user token decides nothing
  for (const route of ['/v1/admin/applications', '/v1/admin/routes', '/v1/admin/constitution']) {
    const res = await fetch(base + route, asToken(apiKey));
    assert.equal(res.status, 401, `${route} must refuse a user-role token`);
  }

  // 5. the term ends and the token stops on its own — nothing is scheduled, nothing runs
  r = await fetch(`${base}/v1/admin/applications/${userId}`, asAdmin('PATCH', {expiresAt: new Date(Date.now() - 86400000).toISOString()}));
  assert.equal(r.status, 200);
  r = await fetch(`${base}/v1/auth/verify`, asToken(apiKey));
  assert.equal(r.status, 401);
  assert.equal(codeOf(await r.json()), 'application_unauthorized_or_expired');
  // The store's own status is deliberately untouched: that stale `active` is exactly why the
  // console has to render the date, and why the API keeps reporting the raw field.
  r = await fetch(`${base}/v1/admin/applications`, asToken(ADMIN_TOKEN));
  const rows = (await r.json()).applications;
  assert.equal(rows.find(u => u.id === userId).status, 'active');

  // 6. renewal is only the date moving, and it takes effect on the next request
  r = await fetch(`${base}/v1/admin/applications/${userId}`, asAdmin('PATCH', {expiresAt: new Date(Date.now() + 45 * 86400000).toISOString()}));
  assert.equal(r.status, 200);
  r = await fetch(`${base}/v1/auth/verify`, asToken(apiKey));
  assert.equal(r.status, 200, 'the same token works again');
  // and "never ends" is clearing the field, not a far-future date
  r = await fetch(`${base}/v1/admin/applications/${userId}`, asAdmin('PATCH', {expiresAt: null}));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).application.expiresAt, null);

  // 7. issuing a new token kills the previous one immediately
  r = await fetch(`${base}/v1/admin/applications/${userId}/rotate-key`, asAdmin('POST', {}));
  assert.equal(r.status, 200);
  const rotated = (await r.json()).apiKey;
  assert.notEqual(rotated, apiKey);
  assert.equal((await fetch(`${base}/v1/auth/verify`, asToken(apiKey))).status, 401, 'the old token is dead');
  assert.equal((await fetch(`${base}/v1/auth/verify`, asToken(rotated))).status, 200, 'the new token works');

  // 8. a refusal says which value was wrong, not just "failed"
  const refuses = [
    ['POST', '/v1/admin/applications', {name: 'typo', expiresAt: 'whenever'}, 400, 'application_expiresAt_invalid:whenever'],
    ['POST', '/v1/admin/applications', {name: 'typo', role: 'superuser'}, 400, 'application_role_invalid:superuser'],
    ['PATCH', `/v1/admin/applications/${userId}`, {apiKeyHash: 'x'}, 400, 'application_patch_field_not_allowed:apiKeyHash'],
    ['PATCH', '/v1/admin/applications/app_does_not_exist', {name: 'x'}, 404, 'application_not_found']
  ];
  for (const [method, route, payload, status, expected] of refuses) {
    const res = await fetch(base + route, asAdmin(method, payload));
    assert.equal(res.status, status, `${method} ${route} status`);
    assert.equal(codeOf(await res.json()), expected, `${method} ${route} code`);
  }

  // 9. the inventory the console reads from is the surface the console may use
  r = await fetch(`${base}/v1/admin/routes`, asToken(ADMIN_TOKEN));
  const inventory = (await r.json()).current.map(entry => `${entry[0]} ${entry[1]}`);
  for (const route of ['POST /v1/admin/applications', 'GET /v1/admin/applications/{id}/token', 'PATCH /v1/admin/applications/{id}', 'GET /v1/auth/verify']) {
    assert.ok(inventory.includes(route), `${route} must be in the route inventory the console reads`);
  }

  // 10. revoke closes the same door, and it is a route rather than a screen
  r = await fetch(`${base}/v1/admin/applications/${userId}/revoke`, asAdmin('POST', {}));
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${base}/v1/auth/verify`, asToken(rotated))).status, 401);
});

test('phase79 a refused outbound endpoint reports the policy that refused it, not request_failed', async t => {
  // A provider on plain http, with plaintext http disallowed. The refusal is raised inside
  // the outbound policy, several layers below the route; the caller must still be told the
  // reason, because `request_failed` gives an operator nothing to act on.
  const {base} = await withRuntime(t, {
    PROVIDER_CONFIG_JSON: JSON.stringify([{
      id: 'plaintext-provider', name: 'Plaintext', baseUrl: 'http://127.0.0.1:9/v1',
      driver: 'openai-compatible', protocol: 'openai-compatible', models: ['m'], defaultModel: 'm',
      enabled: true, capabilities: ['chat-completions'], priority: 1
    }]),
    ALLOW_PLAINTEXT_HTTP: 'false'
  });

  let r = await fetch(`${base}/v1/admin/applications`, asAdmin('POST', {name: 'attempt'}));
  assert.equal(r.status, 201);
  const apiKey = (await r.json()).apiKey;

  r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({model: 'zombie-mini', messages: [{role: 'user', content: 'hi'}]})
  });
  assert.equal(r.status, 400);
  assert.equal(codeOf(await r.json()), 'outbound_protocol_forbidden', 'the policy refusal must reach the caller');
});

// ---------------------------------------------------------------------------
// The publication rule itself
// ---------------------------------------------------------------------------

test('phase79 the publication rule is by shape, so a new outbound or provider code cannot be silenced by omission', () => {
  // Members of these families are pure identifiers: no interpolation, no upstream text.
  for (const code of [
    'outbound_protocol_forbidden', 'outbound_host_not_allowlisted', 'outbound_private_address_forbidden',
    'outbound_dns_private_address_forbidden', 'outbound_tls_failure', 'outbound_connection_refused',
    'provider_model_not_configured', 'provider_http_error', 'provider_response_empty_choices',
    'token_vault_not_configured', 'token_vault_key_changed', 'token_vault_authentication_failed',
    'mcp_timeout'
  ]) {
    assert.equal(publicErrorCode(code), code, `${code} must be published`);
  }
  // Everything already on the explicit list keeps working.
  for (const code of PUBLIC_ERROR_CODES) assert.equal(publicErrorCode(code), code);
});

test('phase79 anything carrying free text stays closed, and the four auditor-approved suffixes stay open', () => {
  for (const message of [
    'outbound_protocol_forbidden:ftp://x',            // a suffix on a family code is not published
    'provider_http_error see the upstream body',       // a space is not a code
    'ENOTFOUND api.internal.example.com',              // a raw DNS error is not a code
    'connect ECONNREFUSED 10.0.0.5:443',               // nor a driver error
    'Unexpected token < in JSON at position 0',        // nor a parser error
    'sk-live-abcdefghijklmnop'                         // nor something that looks like a secret
  ]) {
    assert.equal(publicErrorCode(message), REQUEST_FAILED, `${message} must not be published`);
  }
  // The suffix on these four is the caller's own value, echoed so the operator can see what
  // was refused. Nothing else in the runtime is allowed a suffix.
  for (const message of [
    'application_expiresAt_invalid:whenever',
    'application_role_invalid:superuser',
    'application_status_invalid:paused',
    'application_patch_field_not_allowed:apiKeyHash,capabilities'
  ]) {
    assert.equal(publicErrorCode(message), message);
  }
  assert.equal(publicErrorCode('application_patch_field_not_allowed'), 'application_patch_field_not_allowed');
  assert.equal(publicErrorCode(''), REQUEST_FAILED);
  assert.equal(publicErrorCode(undefined), REQUEST_FAILED);
});
