import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectContextStore } from '../src/context/project-context.js';
import { SSOTService } from '../src/context/ssot.js';
import { SyllabusService } from '../src/context/syllabus.js';
import { ProjectMemoryService } from '../src/context/memory.js';
import { AutoSetupService } from '../src/context/auto-setup.js';

test('phase21 auto setup creates SSOT, syllabus, memory and editor metadata idempotently', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'zc-phase21-'));
  try {
    await (await import('node:fs/promises')).writeFile(path.join(root,'package.json'),'{}');
    const store=new ProjectContextStore({defaultRoot:root});
    const ssot=new SSOTService({contextStore:store});
    const syllabus=new SyllabusService({contextStore:store});
    const memory=new ProjectMemoryService({contextStore:store});
    const setup=new AutoSetupService({contextStore:store,ssot,syllabus,memory});
    const first=await setup.ensure(root,{refreshSSOT:true});
    const second=await setup.ensure(root);
    assert.ok(first.created.length>=5);
    assert.equal(second.created.length,0);
    assert.match(await readFile(first.ssot,'utf8'),/Project SSOT/);
    assert.match(await readFile(first.ssot,'utf8'),/Node\.js/);
    assert.match(await readFile(first.syllabus,'utf8'),/Agent Knowledge Syllabus/);
    assert.deepEqual(JSON.parse(await readFile(first.memory,'utf8')),[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('phase21 syllabus and memory persist evidence-bearing entries', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'zc-phase21-'));
  try {
    const store=new ProjectContextStore({defaultRoot:root});
    const ssot=new SSOTService({contextStore:store});
    const syllabus=new SyllabusService({contextStore:store});
    const memory=new ProjectMemoryService({contextStore:store});
    const setup=new AutoSetupService({contextStore:store,ssot,syllabus,memory});
    await setup.ensure(root);
    await syllabus.append(root,{topic:'Transport',source:'phase20',summary:'HTTP and UDS boundary tested',evidence:'59 tests passed',status:'verified'});
    const entry=await memory.append(root,{kind:'decision',content:'Use shared execution boundary for all transports',source:'phase20',status:'observed'});
    assert.equal((await memory.recent(root,1))[0].id,entry.id);
    assert.match((await syllabus.read(root)).content,/Transport/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
