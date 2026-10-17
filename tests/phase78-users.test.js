import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AdminService, PATCHABLE_APPLICATION_FIELDS } from '../src/admin/admin-service.js';
import { createTokenVault, generateVaultSecret, TOKEN_VAULT_MIN_SECRET_CHARS } from '../src/auth/token-vault.js';
import { authenticateApiKey, isAdminApplication, normalizeExpiry, normalizeLimits, publicApplication, roleOf } from '../src/auth/application-auth.js';
import { AppLimits } from '../src/mcp/limits.js';
import { SystemLogger, redactSecrets } from '../src/core/logger.js';

/*
 * phase78 — a user, a token, a role and a ceiling.
 *
 * The operator's instruction was blunt and worth restating, because every choice
 * below follows from it: the admin creates a user, the user gets one token, the
 * admin can see that token again — and the client's Laravel verifies that specific
 * user with it. Everything else happens in Laravel. So the runtime's job here is
 * narrow: issue it, keep it, be able to show it, and answer "who is this?".
 *
 * The trade-off the operator accepted, recorded so it is not forgotten: being able
 * to read a token back means the token is recoverable, and a recoverable secret is
 * only as safe as the key protecting it. Hence the vault — sealed at rest, hash on
 * the hot path, and every unseal audited.
 */

function fakeStore() {
  const collections = new Map();
  return {
    async read(name, fallback = []) { return collections.get(name) ?? fallback; },
    async write(name, value) { collections.set(name, structuredClone(value)); }
  };
}

const VAULT_KEY = generateVaultSecret();

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

test('phase78 the vault seals a token and opens it again', () => {
  const vault = createTokenVault(VAULT_KEY);
  const token = 'zc_secret-token-value';
  const envelope = vault.seal(token);
  assert.equal(vault.open(envelope), token);
  // The sealed form must not contain the token in any obvious encoding.
  assert.equal(JSON.stringify(envelope).includes(token), false);
  assert.equal(envelope.alg, 'aes-256-gcm');
  assert.equal(envelope.v, 1);
});

test('phase78 each seal is distinct, so identical tokens are not visible as identical', () => {
  const vault = createTokenVault(VAULT_KEY);
  const a = vault.seal('same');
  const b = vault.seal('same');
  assert.notEqual(a.iv, b.iv, 'a random iv per seal');
  assert.notEqual(a.ct, b.ct, 'so the ciphertext differs too');
  assert.equal(vault.open(a), vault.open(b));
});

test('phase78 a different key is reported as a changed key, not as corruption', () => {
  const sealed = createTokenVault(VAULT_KEY).seal('zc_abc');
  const other = createTokenVault(generateVaultSecret());
  assert.throws(() => other.open(sealed), /token_vault_key_changed/);
  assert.equal(other.canOpen(sealed), false);
});

test('phase78 a tampered ciphertext fails authentication rather than returning junk', () => {
  const vault = createTokenVault(VAULT_KEY);
  const sealed = vault.seal('zc_abc');
  const flipped = { ...sealed, ct: Buffer.from('nonsense-ciphertext').toString('base64') };
  assert.throws(() => vault.open(flipped), /token_vault_authentication_failed/);
});

test('phase78 no key means no vault, and a short key is refused', () => {
  assert.equal(createTokenVault(''), null);
  assert.equal(createTokenVault('   '), null);
  assert.equal(createTokenVault(undefined), null);
  // A guessable key silently weakens every stored token, so it is an error, not a warning.
  assert.throws(() => createTokenVault('short'), new RegExp(`token_vault_secret_too_short`));
  assert.ok(generateVaultSecret().length >= TOKEN_VAULT_MIN_SECRET_CHARS);
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test('phase78 an application with no role is a user, which is what it always was', () => {
  assert.equal(roleOf({}), 'user');
  assert.equal(roleOf({ role: 'user' }), 'user');
  assert.equal(roleOf({ role: 'Admin' }), 'admin');
  assert.equal(roleOf({ role: 'root' }), 'user', 'an unknown role is not a promotion');
});

test('phase78 only an active admin application may reach the admin API', async () => {
  const store = fakeStore();
  const admin = new AdminService(store, { vault: createTokenVault(VAULT_KEY) });
  const boss = await admin.createApplication({ name: 'boss', role: 'admin' });
  const shopper = await admin.createApplication({ name: 'shop', role: 'user' });

  const records = await admin.stored();
  assert.equal(isAdminApplication(boss.apiKey, records), true);
  assert.equal(isAdminApplication(shopper.apiKey, records), false);
  assert.equal(isAdminApplication('zc_not-a-real-key', records), false);
  assert.equal(isAdminApplication(null, records), false);

  // A revoked admin stops being an admin immediately — the hash still matches, the
  // record does not.
  await admin.updateApplication(boss.application.id, { status: 'revoked' });
  assert.equal(isAdminApplication(boss.apiKey, await admin.stored()), false);
});

// ---------------------------------------------------------------------------
// Creating, reading and rotating
// ---------------------------------------------------------------------------

test('phase78 a created user can be shown their token again', async () => {
  const store = fakeStore();
  const admin = new AdminService(store, { vault: createTokenVault(VAULT_KEY) });
  const created = await admin.createApplication({ name: 'shop-a', role: 'user' });

  assert.equal(created.application.role, 'user');
  assert.equal(created.application.tokenRecoverable, true);

  const revealed = await admin.revealKey(created.application.id);
  assert.equal(revealed.apiKey, created.apiKey, 'the same token comes back — not a new one');
  assert.equal(revealed.name, 'shop-a');
});

test('phase78 the list never carries the hash or the sealed copy', async () => {
  const store = fakeStore();
  const admin = new AdminService(store, { vault: createTokenVault(VAULT_KEY) });
  await admin.createApplication({ name: 'shop-a' });

  const listed = await admin.applications();
  assert.equal(listed.length, 1);
  for (const user of listed) {
    assert.equal('apiKeyHash' in user, false, 'the hash must never leave the service');
    assert.equal('apiKeyVault' in user, false, 'nor the sealed copy');
    assert.equal(user.tokenRecoverable, true);
  }
  // And the same is true one at a time.
  assert.equal('apiKeyVault' in await admin.application(listed[0].id), false);
});

test('phase78 the token issued really authenticates, and rotation really ends it', async () => {
  const store = fakeStore();
  const admin = new AdminService(store, { vault: createTokenVault(VAULT_KEY) });
  const created = await admin.createApplication({ name: 'shop-a' });

  assert.equal(authenticateApiKey(created.apiKey, await admin.stored())?.id, created.application.id);

  const rotated = await admin.rotateKey(created.application.id);
  assert.notEqual(rotated.apiKey, created.apiKey);
  const records = await admin.stored();
  assert.equal(authenticateApiKey(created.apiKey, records), null, 'the old token is dead');
  assert.equal(authenticateApiKey(rotated.apiKey, records)?.id, created.application.id);
  // Rotation re-seals, so the reveal path keeps working for the new token too.
  assert.equal((await admin.revealKey(created.application.id)).apiKey, rotated.apiKey);
});

test('phase78 without a vault the API says so instead of inventing a token', async () => {
  const store = fakeStore();
  const admin = new AdminService(store, { vault: null });
  const created = await admin.createApplication({ name: 'shop-a' });

  assert.equal(created.application.tokenRecoverable, false);
  assert.match(created.tokenNotice, /cannot be shown again/);
  await assert.rejects(() => admin.revealKey(created.application.id), /token_vault_not_configured/);
  // Authentication is unaffected: the hash is all it ever needed.
  assert.equal(authenticateApiKey(created.apiKey, await admin.stored())?.id, created.application.id);
});

test('phase78 revealing a user that does not exist is a 404-shaped error, not a 409', async () => {
  const admin = new AdminService(fakeStore(), { vault: createTokenVault(VAULT_KEY) });
  await assert.rejects(() => admin.revealKey('app_missing'), /application_not_found/);
});

// ---------------------------------------------------------------------------
// The write path has a boundary
// ---------------------------------------------------------------------------

test('phase78 a patch cannot set a hash or plant a sealed copy', async () => {
  const store = fakeStore();
  const admin = new AdminService(store, { vault: createTokenVault(VAULT_KEY) });
  const created = await admin.createApplication({ name: 'shop-a' });

  for (const field of ['apiKeyHash', 'apiKeyVault', 'id', 'createdAt', 'capabilities']) {
    await assert.rejects(
      () => admin.updateApplication(created.application.id, { [field]: 'anything' }),
      new RegExp(`application_patch_field_not_allowed:${field}`),
      `${field} must not be patchable`
    );
  }
  // And the refusal is a refusal: nothing was written.
  const after = await admin.application(created.application.id);
  assert.equal(after.name, 'shop-a');
  assert.equal(authenticateApiKey(created.apiKey, await admin.stored())?.id, created.application.id);
});

test('phase78 a role is never defaulted silently, and a status must be real', async () => {
  const admin = new AdminService(fakeStore(), { vault: createTokenVault(VAULT_KEY) });
  await assert.rejects(() => admin.createApplication({ name: 'x', role: 'superuser' }), /application_role_invalid:superuser/);

  const created = await admin.createApplication({ name: 'shop-a' });
  await assert.rejects(() => admin.updateApplication(created.application.id, { role: 'root' }), /application_role_invalid:root/);
  await assert.rejects(() => admin.updateApplication(created.application.id, { status: 'paused' }), /application_status_invalid:paused/);
  assert.equal((await admin.updateApplication(created.application.id, { role: 'admin' })).role, 'admin');
});

test('phase78 the patchable list is exactly what the service allows', () => {
  assert.deepEqual([...PATCHABLE_APPLICATION_FIELDS], ['name', 'status', 'role', 'expiresAt', 'limits']);
});

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

test('phase78 limits normalise null as "unset" and refuse nonsense', () => {
  assert.deepEqual(normalizeLimits({}), { rateLimit: null, concurrency: null });
  assert.deepEqual(normalizeLimits({ rateLimit: null, concurrency: null }), { rateLimit: null, concurrency: null });
  assert.deepEqual(normalizeLimits({ rateLimit: '', concurrency: 0 }), { rateLimit: null, concurrency: null });
  assert.deepEqual(normalizeLimits({ rateLimit: -5, concurrency: 1.5 }), { rateLimit: null, concurrency: null });
  assert.deepEqual(normalizeLimits({ rateLimit: 30, concurrency: 2 }), { rateLimit: 30, concurrency: 2 });
  assert.deepEqual(normalizeLimits({ rateLimit: 999999999 }), { rateLimit: 100000, concurrency: null }, 'clamped, not accepted');
});

test('phase78 a user ceiling overrides the runtime default, and null falls through', () => {
  const limits = new AppLimits({ maxRequests: 60, maxConcurrent: 4 });
  assert.deepEqual(limits.ceilingFor(null), { maxRequests: 60, maxConcurrent: 4 });
  assert.deepEqual(limits.ceilingFor({}), { maxRequests: 60, maxConcurrent: 4 });
  assert.deepEqual(limits.ceilingFor({ limits: { rateLimit: null, concurrency: null } }), { maxRequests: 60, maxConcurrent: 4 });
  assert.deepEqual(limits.ceilingFor({ limits: { rateLimit: 3, concurrency: 1 } }), { maxRequests: 3, maxConcurrent: 1 });
  assert.deepEqual(limits.ceilingFor({ limits: { rateLimit: 3, concurrency: null } }), { maxRequests: 3, maxConcurrent: 4 });
});

test('phase78 one user hitting their own ceiling does not touch another user', () => {
  const limits = new AppLimits({ maxRequests: 60, maxConcurrent: 4 });
  // A generous concurrency ceiling on purpose: this test is about the rate window,
  // and with concurrency 1 the second call would trip that instead. Each request is
  // released, which is what a finished request does.
  const small = { limits: { rateLimit: 2, concurrency: 10 } };
  limits.acquire('app_small', small)();
  limits.acquire('app_small', small)();
  assert.throws(() => limits.acquire('app_small', small), /application_rate_limited/);
  // The neighbour is untouched: this is the whole point of a per-user ceiling.
  assert.equal(typeof limits.acquire('app_big', null), 'function');
  assert.throws(() => limits.acquire('app_small', small), /application_rate_limited/);
});

test('phase78 the per-user concurrency ceiling is enforced and released', () => {
  const limits = new AppLimits({ maxRequests: 60, maxConcurrent: 4 });
  const one = { limits: { concurrency: 1 } };
  const release = limits.acquire('app_one', one);
  assert.throws(() => limits.acquire('app_one', one), /application_concurrency_limited/);
  release();
  assert.equal(typeof limits.acquire('app_one', one), 'function', 'released, so it fits again');
});

// ---------------------------------------------------------------------------
// The shape the outside world sees
// ---------------------------------------------------------------------------

test('phase78 publicApplication is the single place secrets are removed', () => {
  const visible = publicApplication({ id: 'app_1', name: 'shop', apiKeyHash: 'deadbeef', apiKeyVault: { ct: 'x' } });
  assert.deepEqual(Object.keys(visible).sort(), ['id', 'name', 'role', 'tokenRecoverable']);
  assert.equal(visible.role, 'user');
  assert.equal(visible.tokenRecoverable, true);
  assert.equal(publicApplication({ id: 'app_2' }).tokenRecoverable, false);
});

// ---------------------------------------------------------------------------
// The claim that goes with the feature: a token is never written to a log
// ---------------------------------------------------------------------------

test('phase78 a token that arrives inside a value is redacted, not just one under a suspicious key', () => {
  const token = 'zc_GrbPuw31o2zkhTYKLUt5RGAwwh7ogBrj';
  // The exact shape that made the claim false: a token sitting in a path.
  assert.equal(redactSecrets(`/v1/admin/applications/${token}/token`).includes(token), false);
  assert.match(redactSecrets(`/v1/admin/applications/${token}/token`), /\[REDACTED\]/);
  // A query string, a provider key, a Meta token, a JWT.
  assert.equal(redactSecrets('?access_token=EAABsbCS0ZAabcdefghijklmnopqrstuvwxyz').includes('EAABsb'), false);
  assert.equal(redactSecrets('Bearer sk-abcdefghijklmnopqrstuvwxyz').includes('sk-abc'), false);
  assert.equal(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefg').includes('eyJhbGciOiJIUzI1NiJ9'), false);
  // And each one bare, with no friendly marker nearby — a fixed-length prefix in a
  // pre-check is not the same as a word-bounded one, which is how the first version
  // of this missed a plain `sk-` and a plain `EAA` while still passing the query test.
  assert.equal(redactSecrets('EAABsbCS0ZAabcdefghijklmnopqrstuvwxyz').includes('EAABsb'), false);
  assert.equal(redactSecrets('rk-live-abcdefghijklmnopqrstuvwxyz').includes('rk-live'), false);
});

test('phase78 redaction does not eat ordinary diagnostics', () => {
  // Over-redaction is its own failure: a log nobody can read is a log nobody checks.
  for (const benign of [
    'GET /v1/health',
    'POST /v1/mcp/tools/call',
    '/v1/admin/applications/app_75e6cecc-bdcf-4eb4-8b8e-1cc5f98066b0/token',
    'mcp_protocol_version_unsupported:2099-01-01',
    'application_rate_limited',
    'search_backend_not_configured'
  ]) {
    assert.equal(redactSecrets(benign), benign, `${benign} must survive intact`);
  }
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(undefined), undefined);
});

// ---------------------------------------------------------------------------
// When it ends
// ---------------------------------------------------------------------------

test('phase78 an empty end date is "never", and is stored as null rather than a date', () => {
  assert.equal(normalizeExpiry(null), null);
  assert.equal(normalizeExpiry(undefined), null);
  assert.equal(normalizeExpiry(''), null);
  assert.equal(normalizeExpiry('2027-01-31'), new Date('2027-01-31').toISOString());
  assert.equal(normalizeExpiry(new Date('2027-01-31T00:00:00.000Z')), '2027-01-31T00:00:00.000Z');
});

test('phase78 a date nobody can read is refused, not stored as a token that is dead on arrival', async () => {
  const admin = new AdminService(fakeStore(), { vault: createTokenVault(VAULT_KEY) });
  // `new Date('whenever') > new Date()` is false, so a garbage date does not fail loudly
  // later — it silently kills the token. The write is where that has to be caught.
  for (const bad of ['whenever', '2026-13-45', 'next month', '17/11/2026']) {
    await assert.rejects(
      () => admin.createApplication({ name: 'x', expiresAt: bad }),
      new RegExp(`application_expiresAt_invalid`),
      `${bad} must be refused`
    );
  }
  const ok = await admin.createApplication({ name: 'x', expiresAt: '2027-01-31' });
  assert.equal(ok.application.expiresAt, new Date('2027-01-31').toISOString());
});

test('phase78 an expired user stops authenticating by itself, with nothing to run', async () => {
  const admin = new AdminService(fakeStore(), { vault: createTokenVault(VAULT_KEY) });
  const past = new Date(Date.now() - 86400000).toISOString();
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  const ending = await admin.createApplication({ name: 'ending', expiresAt: past });
  const live = await admin.createApplication({ name: 'live', expiresAt: future });

  const records = await admin.stored();
  assert.equal(authenticateApiKey(ending.apiKey, records), null, 'past its date, the token no longer authenticates');
  assert.equal(authenticateApiKey(live.apiKey, records)?.name, 'live');
  // The store still says active, which is exactly why the console must show the date:
  // status alone would read as a working user.
  assert.equal(ending.application.status, 'active');
});

test('phase78 renewal is only moving the date, and it takes effect on the next request', async () => {
  const admin = new AdminService(fakeStore(), { vault: createTokenVault(VAULT_KEY) });
  const created = await admin.createApplication({ name: 'ending', expiresAt: new Date(Date.now() - 86400000).toISOString() });
  assert.equal(authenticateApiKey(created.apiKey, await admin.stored()), null, 'starts out ended');

  await admin.updateApplication(created.application.id, { expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
  assert.equal(authenticateApiKey(created.apiKey, await admin.stored())?.name, 'ending', 'same token, working again');

  // And "never ends" is clearing it, not setting a far-future date.
  await admin.updateApplication(created.application.id, { expiresAt: null });
  assert.equal((await admin.application(created.application.id)).expiresAt, null);
  assert.ok(authenticateApiKey(created.apiKey, await admin.stored()));
});

// ---------------------------------------------------------------------------
// The console is a client of the API, never the door to it
// ---------------------------------------------------------------------------

test('phase78 every action the Users screen offers is an API route that already exists', async () => {
  // A screen must not be able to do something the API — and therefore a terminal —
  // cannot. This pins the surface the screen is allowed to depend on, so a future
  // convenience added to the console has to be added to the route inventory first,
  // where it is visible and testable without a browser.
  const { CURRENT_ROUTE_MAP } = await import('../src/compatibility/route-map.js');
  const inventory = new Set(CURRENT_ROUTE_MAP.map(([method, path]) => method + ' ' + path));

  for (const [method, path, why] of [
    ['POST', '/v1/admin/applications', 'create a user'],
    ['GET', '/v1/admin/applications', 'list users'],
    ['GET', '/v1/admin/applications/{id}/token', 'show the token'],
    ['PATCH', '/v1/admin/applications/{id}', 'role, ceilings, expiry, status'],
    ['POST', '/v1/admin/applications/{id}/rotate-key', 'issue a new token'],
    ['POST', '/v1/admin/applications/{id}/revoke', 'revoke'],
    ['GET', '/v1/auth/verify', 'the client\u2019s own verification']
  ]) {
    assert.ok(inventory.has(method + ' ' + path), `${method} ${path} (${why}) must be in the route inventory`);
  }
});

test('phase78 the console cannot reach a capability the API does not have', async () => {
  // The SPA is static markup talking to the same routes as curl. If it ever grew a
  // server-side helper, this file would stop being pure data — so assert that the
  // server never reads it, which is what makes "the UI is not the decider" more than a
  // slogan.
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.equal(server.includes('public/admin'), false, 'src/server.js must not read the admin SPA');
  assert.equal(server.includes('admin/index.html'), false, 'nor reference its file directly');
});

test('phase78 the log file itself contains no token, proven by writing and reading it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zc-log-redact-'));
  const logger = new SystemLogger({ dir, file: 'probe.jsonl', level: 'debug', stdout: false, allowPayloads: true });
  const token = 'zc_GrbPuw31o2zkhTYKLUt5RGAwwh7ogBrj';

  // The two ways a token actually reached a log: a path, and a message that echoed it.
  await logger.log('info', 'http.request', { method: 'GET', path: `/v1/admin/applications/${token}/token` });
  await logger.log('warn', 'provider.rejected', { upstreamReason: `token ${token} is not recognised`, authorization: `Bearer ${token}` });

  const written = readFileSync(path.join(dir, 'probe.jsonl'), 'utf8');
  assert.equal(written.includes(token), false, 'the whole token must be absent from the file');
  assert.equal(written.includes(token.slice(0, 12)), false, 'and so must a readable prefix of it');
  assert.match(written, /\[REDACTED\]/);
  // The line is still diagnostic: the shape of the request survives.
  assert.match(written, /\/v1\/admin\/applications\/\[REDACTED\]\/token/);
});
