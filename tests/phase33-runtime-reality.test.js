import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { assertSafeOutboundUrl } from '../src/network/outbound-policy.js';
import { OutboundCircuitBreaker, OutboundCircuitOpenError, diagnoseOutboundError } from '../src/network/circuit-breaker.js';

function listen(server) { return new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',()=>resolve(server.address().port)); }); }
function close(server) { return new Promise(resolve=>server.close(()=>resolve())); }

test('custom lookup honors Node options.all during a real HTTP request', async () => {
  const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));});
  const port=await listen(server);
  try {
    const safe=await assertSafeOutboundUrl(`http://127.0.0.1:${port}`,{protocols:['http:'],allowPlaintextHttp:true,allowPrivateNetwork:true});
    const response=await new Promise((resolve,reject)=>{
      const req = request(safe.url,{lookup:safe.lookup},res=>{let raw='';res.setEncoding('utf8');res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,body:raw}));});
      req.on('error',reject);req.end();
    });
    assert.equal(response.status,200);
    assert.deepEqual(JSON.parse(response.body),{ok:true});
  } finally { await close(server); }
});

test('circuit breaker opens, blocks, then allows a half-open probe', async () => {
  const breaker=new OutboundCircuitBreaker({failureThreshold:2,resetTimeoutMs:20,halfOpenMaxCalls:1});
  const key='https://example.test';
  await breaker.failure(key,new Error('ECONNREFUSED'));
  await breaker.failure(key,new Error('ECONNREFUSED'));
  assert.throws(()=>breaker.before(key), OutboundCircuitOpenError);
  await new Promise(r=>setTimeout(r,25));
  assert.equal(breaker.before(key),'half-open');
  await breaker.success(key);
  assert.equal(breaker.before(key),'closed');
});

test('outbound diagnostics classify the known lookup contract failure', () => {
  assert.deepEqual(diagnoseOutboundError(new TypeError('Invalid IP address: undefined')), {code:'outbound_lookup_all_contract_mismatch',remediation:'use_all_array_callback_shape'});
});
