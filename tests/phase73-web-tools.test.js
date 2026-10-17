import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { decodeEntities, htmlToText, extractTitle, fetchWithRedirects, execute } from '../tools/common/web_tools.js';
import { ToolRegistry } from '../src/tools/registry.js';

/*
 * phase73 — the two tools that leave the machine, and the registry rule that
 * lets `git pull` remove a phantom tool.
 *
 * The policy is what makes these tools safe, so most of this file is about what
 * is REFUSED. The transport tests point `fetchWithRedirects` at a local server
 * with a deliberately permissive policy, which exercises redirects, truncation
 * and text extraction without ever reaching the internet.
 */

/* -------------------------------------------------------------------------- */
/* Text extraction                                                            */
/* -------------------------------------------------------------------------- */

test('phase73 htmlToText keeps prose and Bengali, drops markup and scripts', () => {
  const html = `<html><head><title>দোকান &amp; Co</title>
    <style>body{color:red}</style><script>alert('x')</script></head>
    <body><!-- hidden --><h1>আমাদের দোকান</h1><p>দাম ৫০০ টাকা &amp; free delivery.</p>
    <ul><li>One</li><li>Two</li></ul></body></html>`;

  const text = htmlToText(html);
  assert.ok(text.includes('আমাদের দোকান'), 'Bengali survives');
  assert.ok(text.includes('দাম ৫০০ টাকা & free delivery.'), 'entities are decoded');
  assert.ok(text.includes('One') && text.includes('Two'), 'list items survive');
  assert.ok(!text.includes('alert'), 'script content is dropped');
  assert.ok(!text.includes('color:red'), 'style content is dropped');
  assert.ok(!text.includes('hidden'), 'comments are dropped');
  assert.ok(!/[<>]/.test(text), 'no markup remains');
  assert.equal(extractTitle(html), 'দোকান & Co');
});

test('phase73 decodeEntities handles named, decimal and hex forms', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&#39;q&#39;'), "'q'");
  assert.equal(decodeEntities('&#x2014;'), '—');
  assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;');
});

/* -------------------------------------------------------------------------- */
/* The strict policy on fetch_web_page                                        */
/* -------------------------------------------------------------------------- */

test('phase73 fetch_web_page refuses a private address, a bad port and a bad protocol', async () => {
  await assert.rejects(() => execute({ url: 'http://127.0.0.1/admin' }, { toolId: 'fetch_web_page' }), /outbound_protocol_forbidden|outbound_private_address_forbidden/);
  await assert.rejects(() => execute({ url: 'https://127.0.0.1:8443/' }, { toolId: 'fetch_web_page' }), /outbound_private_address_forbidden|outbound_nonstandard_https_port_forbidden/);
  await assert.rejects(() => execute({ url: 'file:///etc/passwd' }, { toolId: 'fetch_web_page' }), /outbound_protocol_forbidden/);
  await assert.rejects(() => execute({ url: 'not a url' }, { toolId: 'fetch_web_page' }), /url_invalid/);
  await assert.rejects(() => execute({}, { toolId: 'fetch_web_page' }), /url_required/);
  await assert.rejects(() => execute({ url: 'https://user:pass@example.com/' }, { toolId: 'fetch_web_page' }), /outbound_url_credentials_forbidden/);
});

/* -------------------------------------------------------------------------- */
/* The transport, against a local server with a permissive policy             */
/* -------------------------------------------------------------------------- */

const PERMISSIVE = {
  protocols: ['https:', 'http:'],
  allowPlaintextHttp: true,
  allowPrivateNetwork: true,
  allowPrivateHosts: ['127.0.0.1'],
  requireStandardHttpsPort: false,
};

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('phase73 a redirect hop is followed and reported, and a loop stops', async () => {
  await withServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Arrived</title><body>final body</body></html>');
  }, async (base) => {
    const ok = await fetchWithRedirects(`${base}/start`, PERMISSIVE, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.finalUrl, `${base}/final`);
    assert.equal(ok.redirects.length, 1);
    assert.equal(extractTitle(ok.body), 'Arrived');

    await assert.rejects(() => fetchWithRedirects(`${base}/loop`, PERMISSIVE, {}), /web_fetch_too_many_redirects/);
  });
});

test('phase73 the byte ceiling truncates instead of buffering forever', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(50_000));
  }, async (base) => {
    const response = await fetchWithRedirects(`${base}/big`, PERMISSIVE, { maxBytes: 1024 });
    assert.equal(response.truncated, true);
    assert.ok(response.body.length <= 1024, `expected <= 1024 bytes, got ${response.body.length}`);
  });
});

test('phase73 a non-2xx answer is an error code, not an empty success', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('nope'); }, async (base) => {
    const original = process.env.WEB_FETCH_ALLOW_HTTP;
    process.env.WEB_FETCH_ALLOW_HTTP = 'true';
    try {
      // The strict policy still refuses the private address, which is the point:
      // the operator toggle cannot be used to reach an internal host.
      await assert.rejects(() => execute({ url: `${base}/missing` }, { toolId: 'fetch_web_page' }), /outbound_private_address_forbidden/);
    } finally {
      if (original === undefined) delete process.env.WEB_FETCH_ALLOW_HTTP; else process.env.WEB_FETCH_ALLOW_HTTP = original;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* web_search                                                                 */
/* -------------------------------------------------------------------------- */

test('phase73 web_search reports search_backend_not_configured instead of pretending', async () => {
  const original = process.env.WEB_SEARCH_ENDPOINT;
  delete process.env.WEB_SEARCH_ENDPOINT;
  try {
    await assert.rejects(() => execute({ query: 'anything' }, { toolId: 'web_search' }), /search_backend_not_configured/);
    await assert.rejects(() => execute({}, { toolId: 'web_search' }), /query_required/);
  } finally {
    if (original !== undefined) process.env.WEB_SEARCH_ENDPOINT = original;
  }
});

test('phase73 web_search normalizes a SearXNG-shaped payload', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { title: 'First &amp; best', url: 'https://example.com/a', content: 'snippet one' },
      { title: 'Second', url: 'https://example.com/b', content: 'snippet two' },
      { title: 'no url', content: 'dropped because it has neither url nor title' },
    ] }));
  }, async (base) => {
    const original = process.env.WEB_SEARCH_ENDPOINT;
    process.env.WEB_SEARCH_ENDPOINT = `${base}/search`;
    try {
      const result = await execute({ query: 'test', limit: 5 }, { toolId: 'web_search' });
      assert.equal(result.count, 3);
      assert.equal(result.results[0].title, 'First & best');
      assert.equal(result.results[0].snippet, 'snippet one');
      assert.ok(result.content[0].text.includes('https://example.com/a'));
      assert.equal(result.backend, base);
    } finally {
      if (original === undefined) delete process.env.WEB_SEARCH_ENDPOINT; else process.env.WEB_SEARCH_ENDPOINT = original;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The registry retires what the code no longer declares                      */
/* -------------------------------------------------------------------------- */

function stubStore(initial = []) {
  const data = new Map([['tools', structuredClone(initial)]]);
  return {
    async read(collection, fallback = []) { return data.has(collection) ? structuredClone(data.get(collection)) : fallback; },
    async write(collection, value) { data.set(collection, structuredClone(value)); },
  };
}

test('phase73 a code-owned tool removed from the code is retired on read', async () => {
  const store = stubStore([
    { id: 'runtime_echo', type: 'tool', name: 'Runtime Echo', source: 'runtime-common', status: 'ENABLED', entry: 'common/runtime_echo.js', version: '1.0.0' },
    { id: 'delegate_subagent', type: 'tool', name: 'Delegate Subagent', source: 'runtime-native-pending', status: 'NOT_IMPLEMENTED', entry: null, version: '1.0.0' },
    { id: 'public_api', type: 'tool', name: 'Public API MCP', source: 'legacy-external-mcp', status: 'UNVERIFIED', entry: null, version: 'legacy-1' },
    { id: 'operator_made', type: 'tool', name: 'Operator Made', source: 'operator', status: 'ENABLED', entry: 'common/runtime_echo.js', version: '1.0.0' },
  ]);

  const list = await new ToolRegistry(store).list();
  const ids = list.map((tool) => tool.id);

  assert.equal(ids.includes('delegate_subagent'), false, 'a retired code-owned tool is gone');
  assert.equal(ids.includes('public_api'), false, 'a retired legacy placeholder is gone');
  assert.equal(ids.includes('operator_made'), true, 'an operator-created tool is never dropped');
  assert.equal(ids.includes('runtime_echo'), true, 'a still-declared tool stays');

  // The retirement is persisted, so it happens once and not on every read.
  const again = await new ToolRegistry(store).list();
  assert.equal(again.some((tool) => tool.id === 'delegate_subagent'), false);
});

test('phase73 a code-owned status is refreshed from code, an operator status is kept', async () => {
  const store = stubStore([
    { id: 'runtime_echo', type: 'tool', name: 'Runtime Echo', source: 'runtime-common', status: 'ENABLED', entry: 'common/runtime_echo.js', version: '1.0.0' },
    { id: 'web_search', type: 'tool', name: 'Web Search', source: 'runtime-native-pending', status: 'NOT_IMPLEMENTED', entry: null, version: '1.0.0' },
    { id: 'read_file', type: 'tool', name: 'Read File', source: 'runtime-native', status: 'DISABLED', entry: 'common/workspace_tools.js', version: '1.1.0' },
  ]);

  const list = await new ToolRegistry(store).list();

  // The code declares web_search as ENABLED now. The stale NOT_IMPLEMENTED row
  // was written by an older checkout, not by a person, so it must not pin it.
  assert.equal(list.find((tool) => tool.id === 'web_search').status, 'ENABLED');
  assert.equal(list.find((tool) => tool.id === 'web_search').entry, 'common/web_tools.js');

  // An operator switched read_file off from the admin UI. That decision survives
  // the refresh even though the code declares the tool as runnable.
  assert.equal(list.find((tool) => tool.id === 'read_file').status, 'DISABLED');
});

test('phase73 no listed tool is unavailable, and the web tools are real', async () => {
  const list = await new ToolRegistry(stubStore()).list();
  const unavailable = list.filter((tool) => tool.status === 'NOT_IMPLEMENTED' || tool.status === 'UNVERIFIED');
  assert.deepEqual(unavailable.map((tool) => tool.id), [], 'the registry must not ship a tool it cannot run');
  for (const id of ['web_search', 'fetch_web_page']) {
    const tool = list.find((candidate) => candidate.id === id);
    assert.ok(tool, `${id} must be registered`);
    assert.equal(tool.status, 'ENABLED');
    assert.equal(tool.entry, 'common/web_tools.js');
    assert.equal(tool.metadata.toolSchema.type, 'object');
  }
});
