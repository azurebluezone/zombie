import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=createNetServer();await new Promise((resolve,reject)=>s.listen(0,'127.0.0.1',resolve).once('error',reject));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}

test('phase48 admin UI loads, provider/model routes work, and agent mapping reaches the mapped upstream model',async t=>{
 const observed=[];
 const fixture=createHttpServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};observed.push({path:req.url,model:body.model,stream:body.stream});res.writeHead(200,{'content-type':'application/json'});if(req.method==='GET'&&req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-model',object:'model'}]}));return;}res.end(JSON.stringify({id:'fixture-completion',object:'chat.completion',model:body.model||'fixture-model',choices:[{index:0,message:{role:'assistant',content:'fixture reply'},finish_reason:'stop'}]}));});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const fixturePort=fixture.address().port;const port=await freePort();const dir=await mkdtemp(path.join(tmpdir(),'zc-phase48-admin-'));const adminToken='phase48-admin-test-token';
 const env={...process.env,ENV_LOADER_ENABLED:'false',HOST:'127.0.0.1',PORT:String(port),ADMIN_TOKEN:adminToken,LOCAL_AUTH_BYPASS:'false',PROVIDER_KEY_FIXTURE_PROVIDER:'fixture-env-secret',PROVIDER_CONFIG_JSON:JSON.stringify([{id:'fixture-provider',name:'Fixture Provider',baseUrl:`http://127.0.0.1:${fixturePort}/v1`,driver:'openai-compatible',protocol:'openai-compatible',models:['fixture-model'],defaultModel:'fixture-model',enabled:true,capabilities:['chat-completions','streaming','model-catalog'],priority:1}]),ALLOW_PLAINTEXT_HTTP:'true',PROVIDER_ALLOW_PRIVATE_NETWORK:'true',PROVIDER_ALLOW_PRIVATE_HOSTS:'127.0.0.1',DATA_DIR:path.join(dir,'data'),SQLITE_PATH:path.join(dir,'data','runtime.sqlite'),LOG_DIR:path.join(dir,'logs'),LOG_TO_STDOUT:'false',UDS_ENABLED:'false',PROVIDER_CATALOG_SYNC_ON_START:'false',ZOMBIECODER_EXECUTION_MODE:'chat-only',EXTERNAL_MCP_URLS:'',PROJECT_ROOTS:''};
 const child=spawn(process.execPath,['src/server.js'],{cwd:root,env,stdio:'ignore'});t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await new Promise(resolve=>fixture.close(resolve));await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)assert.fail(`runtime exited ${child.exitCode}`);try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){ready=true;break}}catch{}await delay(100)}assert.equal(ready,true,'runtime did not start');
 const base=`http://127.0.0.1:${port}`;const headers={'content-type':'application/json',authorization:`Bearer ${adminToken}`};
 // The runtime ships no UI: /admin is a boundary (410), and external consoles
 // bootstrap from the public, non-secret /v1/ui-config instead.
 let r=await fetch(`${base}/admin`);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'frontend_not_bundled');
 r=await fetch(`${base}/v1/ui-config`);assert.equal(r.status,200);const uiCfg=await r.json();assert.equal(uiCfg.ui.bundled,false);assert.equal(JSON.stringify(uiCfg).includes('fixture-provider'),false);
 r=await fetch(`${base}/v1/admin/providers`,{headers});assert.equal(r.status,200);let data=await r.json();assert.equal(data.providers.some(p=>p.id==='fixture-provider'),true);
 r=await fetch(`${base}/v1/admin/models`,{headers});assert.equal(r.status,200);data=await r.json();assert.equal(data.models.some(m=>m.providerId==='fixture-provider'&&m.model==='fixture-model'),true);
 // A probe is recorded, not just shown in a toast: the row must be queryable and
 // must already be on disk (a second SQLite connection can read it).
 r=await fetch(`${base}/v1/admin/providers/fixture-provider/test`,{method:'POST',headers,body:JSON.stringify({model:'fixture-model'})});assert.equal(r.status,200);data=await r.json();assert.equal(data.ok,true);assert.equal(typeof data.latencyMs,'number');assert.ok(data.runId);
 r=await fetch(`${base}/v1/admin/model-tests?provider=fixture-provider&model=fixture-model`,{headers});assert.equal(r.status,200);data=await r.json();assert.ok(data.runs.length>=1);assert.equal(data.runs[0].ok,true);assert.equal(typeof data.runs[0].latencyMs,'number');
 r=await fetch(`${base}/v1/admin/models`,{headers});data=await r.json();const probedModel=data.models.find(m=>m.providerId==='fixture-provider'&&m.model==='fixture-model');assert.ok(probedModel.lastTest,'the model list carries the last probe');assert.equal(probedModel.lastTest.ok,true);
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dir,'data','runtime.sqlite'));
 const persisted=db.prepare('SELECT provider, model, ok, latency_ms FROM model_tests').all();db.close();
 assert.ok(persisted.some(x=>x.provider==='fixture-provider'&&x.model==='fixture-model'&&x.ok===1&&Number(x.latency_ms)>=0),'the probe is persisted in SQLite');

 r=await fetch(`${base}/v1/admin/providers/fixture-provider/health`,{method:'POST',headers,body:'{}'});assert.equal(r.status,200);data=await r.json();assert.equal(data.health.status,'healthy');assert.equal(data.health.modelCount,1);
 const providerSecret='sk-phase48-write-only-9f2a';
 // Provider keys are env-only: the API refuses to persist one and names the
 // variable to set instead of silently dropping the field.
 r=await fetch(`${base}/v1/admin/providers`,{method:'POST',headers,body:JSON.stringify({id:'secret-mask-test',name:'Secret Mask Test',baseUrl:'https://example.invalid/v1?api_key=do-not-expose',enabled:false,models:[],apiKey:providerSecret})});
 assert.equal(r.status,400);data=await r.json();assert.equal(data.error.code,'provider_keys_are_env_only');assert.equal(JSON.stringify(data).includes(providerSecret),false);
 r=await fetch(`${base}/v1/admin/providers`,{method:'POST',headers,body:JSON.stringify({id:'secret-mask-test',name:'Secret Mask Test',baseUrl:'https://example.invalid/v1?api_key=do-not-expose',enabled:false,models:[]})});assert.equal(r.status,201);data=await r.json();assert.equal(JSON.stringify(data).includes('do-not-expose'),false);
 assert.equal(data.provider.keyPresent,false,'no key is stored for a console-created provider');
 r=await fetch(`${base}/v1/admin/providers`,{headers});data=await r.json();assert.equal(JSON.stringify(data).includes('do-not-expose'),false);
 assert.equal(JSON.stringify(data).includes(providerSecret),false);
 const envProvider=data.providers.find(p=>p.id==='fixture-provider');
 assert.equal(envProvider.keyPresent,true,'the env key is reported as present');
 assert.equal(envProvider.keySource,'env');
 assert.equal(envProvider.keyFingerprint,createHash('sha256').update('fixture-env-secret').digest('hex').slice(0,12));
 r=await fetch(`${base}/v1/admin/providers/secret-mask-test`,{method:'PATCH',headers,body:JSON.stringify({name:'Secret Mask Test 2'})});assert.equal(r.status,200);data=await r.json();assert.equal(data.provider.keyPresent,false);
 r=await fetch(`${base}/v1/admin/providers/secret-mask-test`,{method:'PATCH',headers,body:JSON.stringify({apiKey:'sk-phase48-rotated-77b1'})});assert.equal(r.status,400);data=await r.json();assert.equal(data.error.code,'provider_keys_are_env_only');
 r=await fetch(`${base}/v1/admin/providers/secret-mask-test`,{method:'DELETE',headers});assert.equal(r.status,200);
 r=await fetch(`${base}/v1/admin/agent-model-mappings/code-guru`,{method:'PUT',headers,body:JSON.stringify({model:'zombie-mini'})});assert.equal(r.status,200,await r.text());
 r=await fetch(`${base}/v1/admin/metrics`,{headers});assert.equal(r.status,200);data=await r.json();assert.ok(data.providers.total>=1);assert.ok(data.agents.mapped>=1);
 r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer invalid-app-key`},body:JSON.stringify({model:'zombie-mini',agent:'code-guru',messages:[{role:'user',content:'hello'}]})});
 // Runtime mapping is exercised after valid application authentication below; the admin UI itself must not create an implicit app credential.
 assert.equal(r.status,401);
 r=await fetch(`${base}/v1/admin/applications`,{method:'POST',headers,body:JSON.stringify({name:'phase48-chat-app'})});assert.equal(r.status,201);const app=await r.json();
 r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${app.apiKey}`},body:JSON.stringify({model:'zombie-mini',agent:'code-guru',messages:[{role:'user',content:'hello'}]})});assert.equal(r.status,200);data=await r.json();assert.equal(data.choices[0].message.content,'fixture reply');assert.ok(observed.some(x=>x.path==='/v1/chat/completions'&&x.model==='fixture-model'));
 r=await fetch(`${base}/v1/admin/providers/fixture-provider`,{method:'PATCH',headers,body:JSON.stringify({enabled:false})});assert.equal(r.status,200);data=await r.json();assert.equal(data.provider.enabled,false);
 r=await fetch(`${base}/v1/admin/providers/fixture-provider`,{method:'DELETE',headers});assert.equal(r.status,200);assert.equal((await r.json()).deleted,true);
});

test('phase48 launcher rejects invalid PORT before starting the server',async()=>{
 const child=spawn(process.execPath,['start.js'],{cwd:root,env:{...process.env,PORT:'99999'},stdio:['ignore','pipe','pipe']});let out='';for await(const chunk of child.stderr)out+=chunk;const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,2);assert.match(out,/Invalid PORT/);
});
