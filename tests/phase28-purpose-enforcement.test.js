import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopExecutor } from '../src/execution/tool-loop.js';

function prepared(){return {contract:{goal:'search web',expectedOutcome:'source-backed answer'},consent:{allowed:true}};}

test('tool loop rejects a model call outside the purpose-derived tool surface', async () => {
  let executed = false;
  const provider = {
    id:'p', capabilities:{},
    async chatCompletions(){
      return {choices:[{message:{role:'assistant',tool_calls:[{id:'c1',type:'function',function:{name:'read_file',arguments:'{}'}}]},finish_reason:'tool_calls'}]};
    }
  };
  const loop = new ToolLoopExecutor({
    providers:{
      async resolve(){return provider;},
      async resolveModel(){return 'm';},
      async list(){return [{...provider,defaultModel:'m',models:['m']}];}
    },
    executionAdapter:{async execute(){executed=true; return {result:'bad'};}},
    normalizer:{normalize(x){return x;}},
    evidenceGate:{record:async()=>{},canClaimSuccess:()=>false}
  });
  const result = await loop.execute({
    prepared:prepared(), applicationId:'a',
    input:{goal:'search the web for current documentation',autoToolLoop:true,toolIds:['web_search'],allowedToolIds:['web_search'],toolBindings:{read_file:{toolId:'read_file'}}}
  });
  assert.equal(executed,false);
  assert.equal(result.verified,false);
  assert.equal(result.rounds[0].toolCalls.length,1);
});

test('task surface is preserved for execution input', async () => {
  const provider={id:'p',capabilities:{},async chatCompletions(){return {choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]};}};
  const seen=[];
  const loop=new ToolLoopExecutor({providers:{async resolve(){return provider;},async resolveModel(){return 'm';},async list(){return [{...provider,defaultModel:'m',models:['m']}];}},executionAdapter:{execute:async()=>({})},normalizer:{normalize:x=>x},evidenceGate:{canClaimSuccess:()=>false}});
  await loop.execute({prepared:prepared(),applicationId:'a',input:{goal:'search web',toolIds:['web_search'],allowedToolIds:['web_search'],messages:[]}});
  assert.deepEqual(seen,[]);
});
