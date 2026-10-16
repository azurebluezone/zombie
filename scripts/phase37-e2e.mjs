import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const root = new URL('.', import.meta.url).pathname;
const provider = createServer(async (req,res)=>{
  let body=''; for await (const c of req) body+=c;
  if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({object:'list',data:[{id:'phase37-model'}]}));}
  if(req.url==='/v1/chat/completions'){
    const input=JSON.parse(body||'{}');
    const messages=Array.isArray(input.messages)?input.messages:[];
    const last=messages.at(-1)?.content ?? '';
    const content=`mock-provider: history_messages=${messages.length}; last=${last}`;
    res.writeHead(200,{'content-type':'application/json'});
    return res.end(JSON.stringify({id:'chat_phase37',object:'chat.completion',model:input.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));
  }
  res.writeHead(404); res.end();
});
await new Promise(r=>provider.listen(18080,'127.0.0.1',r));
const providerConfig = JSON.stringify([{id:'phase37-mock',name:'Phase37 Mock',driver:'openai-compatible',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:18080/v1',defaultModel:'phase37-model',models:['phase37-model'],enabled:true,priority:1,capabilities:['chat-completions','streaming','function-calling','model-catalog']}]);
const env = `PORT=19997\nHOST=127.0.0.1\nUDS_ENABLED=false\nSQLITE_PATH=./data/phase37-e2e.sqlite\nDATA_DIR=./data/phase37-e2e\nLOG_DIR=./logs/phase37-e2e\nLOG_FILE=runtime.jsonl\nLOG_TO_STDOUT=false\nADMIN_TOKEN=phase37-admin\nALLOW_PLAINTEXT_HTTP=true\nPROVIDER_ALLOW_PRIVATE_NETWORK=true\nPROVIDER_CATALOG_SYNC_ON_START=false\nPROVIDER_CONFIG_JSON=${providerConfig}\n`;
await writeFile(root+'.env',env);
const child=spawn(process.execPath,['start.js'],{cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
let logs=''; child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
const base='http://127.0.0.1:19997';
async function waitHealth(){for(let i=0;i<80;i++){try{const r=await fetch(base+'/health');if(r.ok)return r.json();}catch{} await new Promise(r=>setTimeout(r,100));} throw new Error('runtime_health_timeout\n'+logs);}
try{
  const health=await waitHealth();
  const ar=await fetch(base+'/v1/admin/applications',{method:'POST',headers:{authorization:'Bearer phase37-admin','content-type':'application/json'},body:JSON.stringify({name:'phase37-e2e'})});
  const app=await ar.json();
  const key=app.apiKey;
  const sr=await fetch(base+'/v1/sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({userId:'e2e-user'})});
  const session=(await sr.json()).session;
  const chat=async content=>{const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({sessionId:session.id,model:'phase37-model',provider:'phase37-mock',messages:[{role:'user',content}]})});return r.json();};
  const first=await chat('Remember that checkout is Laravel.');
  const second=await chat('What did I ask you to remember?');
  const mr=await fetch(base+`/v1/sessions/${session.id}/messages`,{headers:{authorization:`Bearer ${key}`}}); const messages=(await mr.json()).messages;
  const er=await fetch(base+'/v1/admin/evidence',{headers:{authorization:'Bearer phase37-admin'}}); const evidence=(await er.json()).evidence.filter(x=>x.contextId===session.id);
  console.log(JSON.stringify({health:{version:health.version,phase:health.phase,providerBootstrap:health.providerBootstrap},first:first.choices?.[0]?.message?.content,second:second.choices?.[0]?.message?.content,sessionMessageCount:messages.length,evidence:evidence.map(x=>({status:x.status,source:x.source,contextId:x.contextId}))},null,2));
} finally {
  child.kill('SIGTERM'); await new Promise(r=>setTimeout(r,500)); provider.close();
  await rm(root+'.env',{force:true}); await rm(root+'.zombiecoder-runtime.pid',{force:true}); await rm(root+'data/phase37-e2e.sqlite',{force:true}); await rm(root+'data/phase37-e2e.sqlite-shm',{force:true}); await rm(root+'data/phase37-e2e.sqlite-wal',{force:true}); await rm(root+'data/phase37-e2e',{recursive:true,force:true}); await rm(root+'logs/phase37-e2e',{recursive:true,force:true});
}
