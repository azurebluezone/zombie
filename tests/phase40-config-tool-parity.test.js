import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertSafeMcpUrl } from '../src/mcp/security.js';
import { discoverMcpTools } from '../src/mcp/client.js';
import { toolParityReport } from '../src/compatibility/legacy/tool-parity.js';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';

test('phase40 local HTTP MCP is denied by default', async () => {
  await assert.rejects(() => assertSafeMcpUrl('http://127.0.0.1:5000/mcp'), /outbound_protocol_forbidden/);
});

test('phase40 local HTTP MCP requires explicit private-network opt-in and exact host allowlist', async () => {
  await assert.rejects(() => assertSafeMcpUrl('http://127.0.0.1:5000/mcp', {allowHttp:true,allowPrivateNetwork:true,allowHosts:[]}), /mcp_http_requires_private_network_and_host_allowlist/);
  const safe = await assertSafeMcpUrl('http://127.0.0.1:5000/mcp', {allowHttp:true,allowPrivateNetwork:true,allowHosts:['127.0.0.1']});
  assert.equal(safe.url.protocol, 'http:');
  await assert.rejects(() => assertSafeMcpUrl('http://127.0.0.1:5000/mcp', {allowHttp:true,allowPrivateNetwork:true,allowHosts:['localhost']}), /outbound_host_not_allowlisted/);
});

test('phase40 local HTTP MCP connector performs real initialize and tools/list HTTP requests when explicitly allowed', async t => {
  const seen=[];
  const server=http.createServer((req,res)=>{
    let raw=''; req.setEncoding('utf8'); req.on('data',c=>raw+=c); req.on('end',()=>{
      const payload=JSON.parse(raw); seen.push(payload.method);
      res.writeHead(200,{'content-type':'application/json','mcp-session-id':'phase40-local-session'});
      if(payload.method==='initialize') res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));
      else if(payload.method==='tools/list') res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{tools:[{name:'legacy_probe',description:'fixture tool',inputSchema:{type:'object'}}]}}));
      else res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:{}}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  const endpoint={url:`http://127.0.0.1:${port}/mcp`,allowHosts:['127.0.0.1'],networkPolicy:{allowHttp:true,allowPrivateNetwork:true}};
  const result=await discoverMcpTools(endpoint);
  assert.deepEqual(seen,['initialize','notifications/initialized','tools/list']);
  assert.equal(result.tools[0].name,'legacy_probe');
  assert.equal(result.sessionId,'phase40-local-session');
});

test('phase40 tool parity inventory distinguishes runtime presence from behavioral parity', () => {
  const report=toolParityReport(COMMON_TOOLS);
  assert.equal(report.behaviorParityVerified,false);
  assert.ok(report.items.some(x=>x.id==='read_file'&&x.runtimeRegistered&&x.compatibilityContractTested&&!x.behaviorParityVerified));
  assert.ok(report.items.some(x=>x.id==='screen_recorder'&&x.status==='not-migrated'));
  assert.ok(report.items.some(x=>x.id==='public_api'&&x.status==='declared-unverified'));
});
