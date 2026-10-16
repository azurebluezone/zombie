#!/usr/bin/env node
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const base = process.env.ZC_VERIFY_URL || 'http://127.0.0.1:9999';
const output = process.env.ZC_VERIFY_REPORT || './data/deployment-verification.json';
const timeoutMs = Math.max(1000, Math.min(30000, Number(process.env.ZC_VERIFY_TIMEOUT_MS || 5000)));
const checks = [];
async function check(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); checks.push({name,status:'passed',durationMs:Date.now()-started,...detail}); }
  catch (error) { checks.push({name,status:'failed',durationMs:Date.now()-started,code:String(error?.code || error?.message || 'check_failed').slice(0,160)}); }
}
async function get(url, headers={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {headers, signal:controller.signal, redirect:'manual'});
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch {}
    return {response,json,text};
  } finally { clearTimeout(timer); }
}
let health;
await check('runtime-health', async () => {
  const r = await get(new URL('/health', base));
  if (!r.response.ok || r.json?.ok !== true) throw new Error(`health_http_${r.response.status}`);
  health = r.json;
  return {httpStatus:r.response.status,version:r.json.version,phase:r.json.phase,executionMode:r.json.executionMode};
});
await check('openai-model-catalog', async () => {
  const r = await get(new URL('/v1/models', base));
  if (!r.response.ok || !r.json || !Array.isArray(r.json.data)) throw new Error(`models_http_${r.response.status}`);
  return {httpStatus:r.response.status,modelCount:r.json.data.length};
});
const targetUrl = new URL(base);
if (targetUrl.protocol === 'https:') {
  await check('tls-endpoint', async () => {
    const r = await get(new URL('/health', base));
    if (!r.response.ok || r.json?.ok !== true) throw new Error(`tls_health_http_${r.response.status}`);
    return {httpStatus:r.response.status,hostname:targetUrl.hostname,certificateValidation:'Node fetch default TLS validation'};
  });
} else {
  checks.push({name:'tls-endpoint',status:'not_applicable',durationMs:0,detail:'Target uses HTTP; this is acceptable only for explicitly intended loopback/private deployment. Public clients should use verified HTTPS.'});
}
if (args.has('--chat')) {
  await check('authenticated-chat', async () => {
    const key = process.env.ZC_VERIFY_API_KEY;
    const model = process.env.ZC_VERIFY_MODEL;
    if (!key || !model) throw new Error('set_ZC_VERIFY_API_KEY_and_ZC_VERIFY_MODEL');
    const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(), timeoutMs * 6);
    try {
      const response = await fetch(new URL('/v1/chat/completions', base), {method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Reply with exactly: ZC_VERIFICATION_OK'}],stream:false}),signal:controller.signal,redirect:'manual'});
      const text = await response.text(); let json; try { json=JSON.parse(text); } catch {}
      if (!response.ok || !json?.choices?.[0]?.message) throw new Error(`chat_http_${response.status}`);
      return {httpStatus:response.status,hasAssistantMessage:true,modelReturned:json.model || null};
    } finally { clearTimeout(timer); }
  });
}
if (args.has('--stream')) {
  await check('authenticated-streaming', async () => {
    const key = process.env.ZC_VERIFY_API_KEY; const model=process.env.ZC_VERIFY_MODEL;
    if (!key || !model) throw new Error('set_ZC_VERIFY_API_KEY_and_ZC_VERIFY_MODEL');
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs*6);
    try {
      const response=await fetch(new URL('/v1/chat/completions',base),{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Reply with exactly: ZC_STREAM_OK'}],stream:true}),signal:controller.signal,redirect:'manual'});
      if (!response.ok || !response.body) throw new Error(`stream_http_${response.status}`);
      const reader=response.body.getReader(); const decoder=new TextDecoder(); let text=''; let done=false;
      while(!done){const part=await reader.read();done=part.done;if(part.value)text+=decoder.decode(part.value,{stream:!done});if(text.length>1024*1024)throw new Error('stream_response_too_large');}
      if (!text.includes('data: [DONE]')) throw new Error('stream_done_marker_missing');
      return {httpStatus:response.status,doneMarker:true,bytes:text.length};
    } finally {clearTimeout(timer);}
  });
}
const required = checks.filter(c=>['runtime-health','openai-model-catalog'].includes(c.name) || (targetUrl.protocol === 'https:' && c.name === 'tls-endpoint') || (args.has('--chat') && c.name === 'authenticated-chat') || (args.has('--stream') && c.name === 'authenticated-streaming'));
const tlsCheck=checks.find(c=>c.name==='tls-endpoint');
const report={schemaVersion:1,createdAt:new Date().toISOString(),target:new URL(base).origin,executionMode:health?.executionMode ?? 'unknown',checks,summary:{passed:checks.filter(c=>c.status==='passed').length,failed:checks.filter(c=>c.status==='failed').length,chatVerified:checks.some(c=>c.name==='authenticated-chat'&&c.status==='passed'),streamVerified:checks.some(c=>c.name==='authenticated-streaming'&&c.status==='passed'),tlsVerified:tlsCheck?.status==='passed',toolCallingVerified:false,toolCallingNote:'Not tested by this script; requires a dedicated harmless tool-call integration test.'}};
await mkdir(path.dirname(path.resolve(output)),{recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600}); await chmod(output,0o600);
console.log(JSON.stringify(report,null,2));
if (required.some(c=>c.status!=='passed')) process.exitCode=1;
