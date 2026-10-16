import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer as createNetServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=createNetServer();await new Promise((resolve,reject)=>s.listen(0,'127.0.0.1',resolve).once('error',reject));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
test('phase47 OpenAI-compatible chat endpoint runs an explicitly consented registered tool loop',async t=>{
 const fixture=createHttpServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};let response;if((body.messages??[]).some(m=>m.role==='tool'))response={id:'fixture-final',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'The file was created by the runtime tool.'},finish_reason:'stop'}]};else response={id:'fixture-tool',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'{"tool":"create_file","arguments":{"path":"result.txt","content":"created through HTTP tool loop"}}'},finish_reason:'stop'}]};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const fixturePort=fixture.address().port;const port=await freePort();const dir=await mkdtemp(path.join(tmpdir(),'zc-phase47-chat-e2e-'));const project=path.join(dir,'data');await mkdir(project);const adminToken='phase47-local-admin-test-token';
 const env={...process.env,ENV_LOADER_ENABLED:'false',HOST:'127.0.0.1',PORT:String(port),ADMIN_TOKEN:adminToken,OLLAMA_BASE_URL:`http://127.0.0.1:${fixturePort}/v1`,ALLOW_PLAINTEXT_HTTP:'true',PROVIDER_ALLOW_PRIVATE_NETWORK:'true',PROVIDER_ALLOW_PRIVATE_HOSTS:'127.0.0.1',DATA_DIR:path.join(dir,'data'),SQLITE_PATH:path.join(dir,'data','runtime.sqlite'),LOG_DIR:path.join(dir,'logs'),LOG_TO_STDOUT:'false',UDS_ENABLED:'false',PROVIDER_CATALOG_SYNC_ON_START:'false',ZOMBIECODER_EXECUTION_MODE:'tools-enabled',EXTERNAL_MCP_URLS:'',PROJECT_ROOTS:''};
 const child=spawn(process.execPath,['src/server.js'],{cwd:root,env,stdio:'ignore'});t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)]);if(child.exitCode===null)child.kill('SIGKILL');await new Promise(resolve=>fixture.close(resolve));await rm(dir,{recursive:true,force:true});});
 let health=false;for(let i=0;i<100;i++){if(child.exitCode!==null)assert.fail(`runtime exited ${child.exitCode}`);try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){health=true;break}}catch{}await delay(100)}assert.equal(health,true,'runtime did not start');
 const adminHeaders={'content-type':'application/json',authorization:`Bearer ${adminToken}`};let r=await fetch(`http://127.0.0.1:${port}/v1/admin/applications`,{method:'POST',headers:adminHeaders,body:JSON.stringify({name:'phase47-test-app'})});assert.equal(r.status,201);const created=await r.json();
 r=await fetch(`http://127.0.0.1:${port}/v1/admin/tools/permissions`,{method:'POST',headers:adminHeaders,body:JSON.stringify({applicationId:created.application.id,toolId:'create_file'})});assert.equal(r.status,201);
 r=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${created.apiKey}`},body:JSON.stringify({model:'fixture',autoToolLoop:true,consent:true,goal:'create file',expectedOutcome:'result.txt exists',projectRoot:project,toolIds:['create_file'],messages:[{role:'user',content:'Create result.txt with a short confirmation.'}]})});assert.equal(r.status,200,await r.text());
 const result=await readFile(path.join(project,'result.txt'),'utf8');assert.equal(result,'created through HTTP tool loop');
});
