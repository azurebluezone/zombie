import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectContextStore } from '../src/context/project-context.js';
import { SSOTService, isRuntimeGeneratedSSOT } from '../src/context/ssot.js';
import { SyllabusService } from '../src/context/syllabus.js';
import { ProjectMemoryService } from '../src/context/memory.js';
import { AutoSetupService } from '../src/context/auto-setup.js';

// A foreign SSOT.md — written by an editor plugin or hand-edited — is not project
// state the runtime can vouch for. Before this, the "only refresh when empty" rule
// kept such a file forever, so a stale line ("Server workspace POST: HTTP_401") was
// handed to the model as project truth on every single request.

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zc-ssot-'));
  const contextStore = new ProjectContextStore({ defaultRoot: dir });
  const ssot = new SSOTService({ contextStore });
  const autoSetup = new AutoSetupService({
    contextStore,
    ssot,
    syllabus: new SyllabusService({ contextStore }),
    memory: new ProjectMemoryService({ contextStore })
  });
  return { dir, contextStore, ssot, autoSetup, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const FOREIGN = '# ZombieCoder SSOT (runtime workspace)\n\n- Server workspace POST: HTTP_401\n- Provider facts: NOT_PROBED_HERE\n';

test('phase60 a foreign SSOT is replaced by observed project state and kept aside', async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.dir, '.zombiecoder'), { recursive: true });
    await writeFile(path.join(h.dir, '.zombiecoder', 'SSOT.md'), FOREIGN, 'utf8');
    assert.equal(isRuntimeGeneratedSSOT((await h.ssot.read(h.dir)).content), false);

    await h.autoSetup.ensure(h.dir);

    const after = await h.ssot.read(h.dir);
    assert.equal(isRuntimeGeneratedSSOT(after.content), true);
    // The stale claim is gone from what the model will be shown...
    assert.equal(after.content.includes('HTTP_401'), false);
    // ...and it is stamped with who generated it, so the check is not string-luck.
    assert.match(after.content, /- Source: runtime-project-scanner/);
    // Nothing an operator wrote is lost.
    const archive = await readFile(path.join(h.dir, '.zombiecoder', 'SSOT.imported.md'), 'utf8');
    assert.equal(archive, FOREIGN);
  } finally { await h.cleanup(); }
});

test('phase60 a runtime-generated SSOT is not rewritten on every request', async () => {
  const h = await harness();
  try {
    await h.autoSetup.ensure(h.dir);
    const target = path.join(h.dir, '.zombiecoder', 'SSOT.md');
    const first = await stat(target);
    // Distinct mtime resolution, so a rewrite cannot hide inside the same tick.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await h.autoSetup.ensure(h.dir);
    const second = await stat(target);
    assert.equal(second.mtimeMs, first.mtimeMs, 'ensure() must be a no-op once the file is the runtime’s own');
  } finally { await h.cleanup(); }
});

test('phase60 refreshSSOT=true still forces a rebuild, and archives only once', async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.dir, '.zombiecoder'), { recursive: true });
    await writeFile(path.join(h.dir, '.zombiecoder', 'SSOT.md'), FOREIGN, 'utf8');
    await h.autoSetup.ensure(h.dir, { refreshSSOT: true });
    const archivePath = path.join(h.dir, '.zombiecoder', 'SSOT.imported.md');
    const firstArchive = await readFile(archivePath, 'utf8');

    // A second forced refresh must not clobber the preserved original with the
    // runtime's own generated file.
    await writeFile(path.join(h.dir, '.zombiecoder', 'SSOT.md'), FOREIGN, 'utf8');
    await h.autoSetup.ensure(h.dir, { refreshSSOT: true });
    assert.equal(await readFile(archivePath, 'utf8'), firstArchive);
    assert.equal((await h.ssot.read(h.dir)).content.includes('HTTP_401'), false);
  } finally { await h.cleanup(); }
});
