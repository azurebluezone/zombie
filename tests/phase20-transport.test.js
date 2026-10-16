import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTransportServers, stopTransportServers } from '../src/transport/server.js';
import { RuntimeClient } from '../src/transport/client.js';

test('phase 20: HTTP and UDS transports share the same request handler', async () => {
  const dir=await mkdtemp(join(tmpdir(),'zc20-'));
  const socket=join(dir,'runtime.sock');
  const handler=async (req,res)=>{
    if (req.url==='/health') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ok:true,transport:'shared-handler'})); return; }
    res.writeHead(404); res.end();
  };
  const config={host:'127.0.0.1',port:0,https:{enabled:false},uds:{enabled:true,required:true,path:socket}};
  const logger={info:async()=>{},error:async()=>{}};
  const servers=await startTransportServers({handler,config,logger});
  try {
    const port=servers.http.address().port;
    const httpClient=new RuntimeClient({baseUrl:`http://127.0.0.1:${port}`});
    const udsClient=new RuntimeClient({baseUrl:'http://localhost',socketPath:socket});
    assert.deepEqual((await httpClient.health()).transport,'shared-handler');
    assert.deepEqual((await udsClient.health()).transport,'shared-handler');
  } finally { await stopTransportServers(servers); await rm(dir,{recursive:true,force:true}); }
});

test('phase 20: SSE client consumes chat completion events and DONE', async () => {
  const dir=await mkdtemp(join(tmpdir(),'zc20-sse-'));
  const socket=join(dir,'runtime.sock');
  const handler=async (req,res)=>{
    if (req.url==='/v1/chat/completions') {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"id":"chunk-1","choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end(); return;
    }
    res.writeHead(404); res.end();
  };
  const servers=await startTransportServers({handler,config:{host:'127.0.0.1',port:0,https:{enabled:false},uds:{enabled:false}},logger:{info:async()=>{},error:async()=>{}}});
  try {
    const client=new RuntimeClient({baseUrl:`http://127.0.0.1:${servers.http.address().port}`});
    const events=[]; for await (const event of client.streamChatCompletions({model:'test',messages:[{role:'user',content:'hi'}]})) events.push(event);
    assert.equal(events.length,1);
    assert.equal(events[0].data.choices[0].delta.content,'hello');
  } finally { await stopTransportServers(servers); await rm(dir,{recursive:true,force:true}); }
});

test('phase 20: HTTPS configuration is explicit and disabled by default', async () => {
  const handler=async (req,res)=>{res.writeHead(200);res.end('ok');};
  const config={host:'127.0.0.1',port:0,https:{enabled:false,required:false,host:'127.0.0.1',port:0,key:'missing',cert:'missing'},uds:{enabled:false}};
  const servers=await startTransportServers({handler,config,logger:{info:async()=>{},error:async()=>{}}});
  try { assert.equal(servers.https,null); } finally { await stopTransportServers(servers); }
});
