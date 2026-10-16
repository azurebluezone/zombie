import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {discoverMcpTools,callMcpTool,openMcpEventStream} from '../src/mcp/client.js';

test('phase49 MCP initialize sends initialized notification, negotiates protocol version, lists tools over SSE, and calls a tool',async t=>{
 const requests=[];const session='fixture-session-49';
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};requests.push({method:req.method,body,session:req.headers['mcp-session-id'],version:req.headers['mcp-protocol-version']});
  if(body.method==='initialize'){
   res.writeHead(200,{'content-type':'application/json','mcp-session-id':session,'mcp-protocol-version':'2025-06-18'});
   res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture-mcp',version:'1.0'}}}));return;
  }
  if(body.method==='notifications/initialized') {res.writeHead(202,{'mcp-session-id':session});res.end();return;}
  if(body.method==='tools/list') {
   res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':session});
   res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n');
   res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result:{tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}})}\n\n`);return;
  }
  if(body.method==='tools/call') {res.writeHead(200,{'content-type':'application/json','mcp-session-id':session});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:body.params.arguments.text}],isError:false}}));return;}
  res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint={id:'fixture-mcp',url:`http://127.0.0.1:${server.address().port}/mcp`,allowHosts:['127.0.0.1'],networkPolicy:{allowHttp:true,allowPrivateNetwork:true}};
 const discovery=await discoverMcpTools(endpoint);
 assert.equal(discovery.protocolVersion,'2025-06-18');assert.equal(discovery.sessionId,session);assert.equal(discovery.tools[0].name,'echo');
 const result=await callMcpTool({...endpoint,sessionId:discovery.sessionId,protocolVersion:discovery.protocolVersion},'echo',{text:'hello MCP'});
 assert.equal(result.content[0].text,'hello MCP');
 assert.deepEqual(requests.map(x=>x.body.method),['initialize','notifications/initialized','tools/list','tools/call']);
 assert.equal(requests[1].body.id,undefined);assert.equal(requests[1].session,session);assert.equal(requests[2].session,session);assert.equal(requests[3].session,session);
 assert.ok(requests.every(x=>x.version==='2025-06-18'));
});

test('phase49 MCP fails closed on JSON-RPC response ID mismatch',async t=>{
 const server=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:'wrong-id',result:{protocolVersion:'2025-06-18'}}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint={id:'bad-mcp',url:`http://127.0.0.1:${server.address().port}/mcp`,allowHosts:['127.0.0.1'],networkPolicy:{allowHttp:true,allowPrivateNetwork:true}};
 await assert.rejects(()=>discoverMcpTools(endpoint),/mcp_response_id_mismatch/);
});

test('phase49 optional Streamable HTTP GET event stream carries session and protocol headers',async t=>{
 let headersSeen;let emit;let stream;
 const eventPromise=new Promise(resolve=>{emit=resolve});
 const server=createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  headersSeen={session:req.headers['mcp-session-id'],version:req.headers['mcp-protocol-version'],accept:req.headers.accept};
  res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':'get-session'});res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"message":"ready"}}\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stream?.close();server.close(resolve)}));
 stream=await openMcpEventStream({url:`http://127.0.0.1:${server.address().port}/mcp`,allowHosts:['127.0.0.1'],networkPolicy:{allowHttp:true,allowPrivateNetwork:true}},{sessionId:'get-session',protocolVersion:'2025-06-18',onEvent:emit});
 const event=await Promise.race([eventPromise,delay(1000).then(()=>{throw new Error('event timeout')})]);
 assert.equal(event.params.message,'ready');assert.equal(headersSeen.session,'get-session');assert.equal(headersSeen.version,'2025-06-18');assert.match(headersSeen.accept,/text\/event-stream/);assert.equal(stream.sessionId,'get-session');stream.close();
});

test('phase49 MCP discovery failures persist a safe endpoint error status',async t=>{
 const {McpRegistry}=await import('../src/mcp/registry.js');
 const collections=new Map();const store={async read(name,fallback=[]){return collections.get(name)??fallback;},async write(name,value){collections.set(name,structuredClone(value));}};
 const server=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:'mismatched-id',result:{protocolVersion:'2025-06-18'}}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const registry=new McpRegistry(store,{networkPolicy:{allowHttp:true,allowPrivateNetwork:true,allowHosts:['127.0.0.1']}});
 const endpoint=await registry.register({id:'failing-fixture',url:`http://127.0.0.1:${server.address().port}/mcp`,allowHosts:['127.0.0.1']});
 await assert.rejects(()=>registry.discover(endpoint.id),/mcp_response_id_mismatch/);
 const persisted=(await registry.list()).find(x=>x.id===endpoint.id);assert.equal(persisted.status,'error');assert.equal(persisted.lastErrorCode,'mcp_response_id_mismatch');assert.ok(persisted.lastErrorAt);
});
