import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// The remote admin path is an edge, not a second app: nginx terminates TLS,
// proxies the loopback runtime, and caps the control plane. These assertions pin
// the three properties that are easy to lose in a later edit — TLS on, loopback
// upstream, and a rate limit that actually answers 429. CORS stays owned by the
// runtime (one allowlist, no wildcard duplicated at the edge).

test('phase62 the admin edge terminates TLS and proxies only the loopback runtime', async () => {
  const conf = await read('deploy/nginx/zombiecoder-admin.conf');
  assert.match(conf, /listen 8443 ssl/, 'TLS listener is explicit');
  assert.match(conf, /ssl_certificate\s+\/etc\/nginx\/certs\/zombiecoder\.crt/);
  assert.match(conf, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.equal(/proxy_pass\s+https?:\/\/(?!127\.0\.0\.1)/.test(conf), false, 'every upstream is loopback');
  assert.match(conf, /location \/admin-ui\/[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:8088\//, 'the console is proxied, not read from disk');
  assert.equal(/\broot\s+\/home\//.test(conf), false, 'nginx never needs access to the home directory');
});

test('phase62 the control plane is rate-limited with an explicit 429', async () => {
  const conf = await read('deploy/nginx/zombiecoder-admin.conf');
  assert.match(conf, /limit_req_zone\s+\$binary_remote_addr\s+zone=zc_admin:10m\s+rate=\d+r\/s/);
  assert.match(conf, /location \^~ \/v1\/admin\/\s*\{[\s\S]*?limit_req zone=zc_admin/);
  assert.match(conf, /limit_req_status 429/);
  assert.match(conf, /limit_conn zc_conn/);
  // A page load fires roughly ten calls; the burst must fit that or the console
  // would rate-limit itself. Keep the burst in a sane range, not unbounded.
  const burst = Number(/limit_req zone=zc_admin burst=(\d+)/.exec(conf)?.[1] ?? '0');
  assert.ok(burst >= 20 && burst <= 60, `admin burst stays bounded (got ${burst})`);
});

test('phase62 the edge does not invent its own CORS policy', async () => {
  const conf = await read('deploy/nginx/zombiecoder-admin.conf');
  assert.equal(/Access-Control-Allow-Origin/i.test(conf), false, 'CORS is decided by the runtime allowlist, not nginx');
});
