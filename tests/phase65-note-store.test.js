import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { NoteStore, notePath, resolveNoteRoot, assertAbsoluteRoot } from '../src/notes/note.js';
import { execute } from '../tools/common/workspace_tools.js';

const tempRoot = async (label) => mkdtemp(path.join(os.tmpdir(), `zc-note-${label}-`));

// The bug this module exists to prevent: a relative path silently resolving against
// whatever directory the process was started from. The runtime is launched by a shell, by
// systemd, by a test runner and by packaged builds, so "wherever the shell was" is not an
// answer. These tests pin that down rather than trusting it.

test('phase65 a relative root is refused instead of resolved against the working directory', () => {
  assert.throws(() => assertAbsoluteRoot('./data'), /note_root_must_be_absolute/);
  assert.throws(() => assertAbsoluteRoot('data'), /note_root_must_be_absolute/);
  assert.throws(() => assertAbsoluteRoot(''), /note_root_required/);
  assert.throws(() => assertAbsoluteRoot(undefined), /note_root_required/);
  assert.throws(() => notePath('relative/root'), /note_root_must_be_absolute/);
});

test('phase65 resolveNoteRoot falls back to a configured default and never to cwd', () => {
  assert.equal(resolveNoteRoot('/tmp/a'), '/tmp/a');
  assert.equal(resolveNoteRoot(undefined, { defaultRoot: '/tmp/b' }), '/tmp/b');
  assert.equal(resolveNoteRoot('  ', { defaultRoot: '/tmp/b' }), '/tmp/b');
  // No explicit root and no configured default: an error, not `process.cwd()`.
  assert.throws(() => resolveNoteRoot(undefined), /note_root_required/);
  assert.throws(() => resolveNoteRoot(undefined, { defaultRoot: 'relative' }), /note_root_must_be_absolute/);
});

test('phase65 notes land under the project root even when the working directory is elsewhere', async () => {
  const root = await tempRoot('cwd');
  const original = process.cwd();
  try {
    // Start the "server" from a completely unrelated directory.
    process.chdir(os.tmpdir());
    const store = new NoteStore();
    const written = await store.append(root, { text: 'the parser lives in src/parser.js', topic: 'code' });
    assert.ok(written.path.startsWith(`${root}${path.sep}`), `${written.path} must live under ${root}`);
    assert.equal(written.path, notePath(root));
    const onDisk = JSON.parse(await readFile(written.path, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.match(onDisk[0].text, /the parser lives in src\/parser\.js/);
  } finally {
    process.chdir(original);
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 append, list, search and remove round-trip', async () => {
  const root = await tempRoot('roundtrip');
  try {
    const store = new NoteStore();
    const first = await store.append(root, { text: 'npm test is the whole suite', topic: 'commands', tags: ['verify'] });
    await store.append(root, { text: 'the SSOT file is generated, do not hand-edit', topic: 'code' });
    assert.equal(first.count, 1);

    const listed = await store.list(root, {});
    assert.equal(listed.total, 2);
    assert.equal(listed.notes.length, 2);
    assert.equal(listed.notes[0].topic, 'commands');
    assert.deepEqual(listed.notes[0].tags, ['verify']);
    assert.ok(listed.notes[0].id.startsWith('note_'));
    assert.ok(listed.notes[0].createdAt);

    const byTopic = await store.list(root, { topic: 'code' });
    assert.equal(byTopic.returned, 1);
    assert.match(byTopic.notes[0].text, /SSOT file/);

    const found = await store.search(root, { query: 'SUITE' });
    assert.equal(found.returned, 1);
    assert.match(found.notes[0].text, /npm test/);

    const missing = await store.search(root, { query: 'nothing-matches-this' });
    assert.equal(missing.returned, 0);
    assert.deepEqual(missing.notes, []);

    const removed = await store.remove(root, { id: first.note.id });
    assert.equal(removed.removed, 1);
    assert.equal(removed.count, 1);
    await assert.rejects(() => store.remove(root, { id: first.note.id }), /note_not_found/);
    await assert.rejects(() => store.remove(root, {}), /note_id_required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 an empty note is refused rather than stored', async () => {
  const root = await tempRoot('empty');
  try {
    const store = new NoteStore();
    await assert.rejects(() => store.append(root, { text: '   ' }), /note_text_required/);
    await assert.rejects(() => store.append(root, {}), /note_text_required/);
    assert.equal(await store.count(root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 notes belong to one project root and do not bleed into another', async () => {
  const one = await tempRoot('p1');
  const two = await tempRoot('p2');
  try {
    const store = new NoteStore();
    await store.append(one, { text: 'note for project one' });
    await store.append(two, { text: 'note for project two' });
    const a = await store.list(one, {});
    const b = await store.list(two, {});
    assert.equal(a.total, 1);
    assert.equal(b.total, 1);
    assert.match(a.notes[0].text, /project one/);
    assert.match(b.notes[0].text, /project two/);
    // A folder that was never used has no notes and does not throw.
    const empty = await store.list(await tempRoot('p3'), {});
    assert.equal(empty.total, 0);
  } finally {
    for (const dir of [one, two]) await rm(dir, { recursive: true, force: true });
  }
});

test('phase65 the store is bounded, and keeps the newest notes', async () => {
  const root = await tempRoot('bounded');
  try {
    const store = new NoteStore({ maxNotes: 3 });
    for (let i = 1; i <= 6; i += 1) await store.append(root, { text: `note number ${i}` });
    const listed = await store.list(root, {});
    assert.equal(listed.total, 3);
    assert.deepEqual(listed.notes.map((n) => n.text), ['note number 4', 'note number 5', 'note number 6']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 a hand-edited or broken file is reported, never thrown away', async () => {
  const root = await tempRoot('broken');
  try {
    const store = new NoteStore();
    const file = notePath(root);
    await store.ensure(root);
    await writeFile(file, '{ this is not json', 'utf8');
    const read = await store.read(root);
    assert.deepEqual(read.notes, []);
    assert.deepEqual(read.warnings, ['notes_invalid_json']);
    // Still there: the user's file is not ours to delete.
    assert.equal(await readFile(file, 'utf8'), '{ this is not json');

    await writeFile(file, '{"not":"an array"}', 'utf8');
    assert.deepEqual((await store.read(root)).warnings, ['notes_not_array']);

    // And a missing file is a normal state, not an error.
    await rm(file, { force: true });
    assert.deepEqual((await store.read(root)).warnings, ['notes_not_found']);
    assert.equal(await store.count(root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 the write is atomic: no temporary file is left behind', async () => {
  const root = await tempRoot('atomic');
  try {
    const store = new NoteStore();
    await store.append(root, { text: 'first' });
    await store.append(root, { text: 'second' });
    const dir = path.dirname(notePath(root));
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['notes.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 the note_store tool appends, lists and searches inside the project root', async () => {
  const root = await tempRoot('tool');
  try {
    const ctx = { toolId: 'note_store', executionContext: { projectRoot: root } };
    const appended = await execute({ action: 'append', text: 'the tests live in tests/', topic: 'code' }, ctx);
    const body = JSON.parse(appended.content[0].text);
    assert.equal(body.action, 'append');
    assert.equal(body.count, 1);
    assert.equal(body.path, path.join('.zombiecoder', 'agents', 'notes.json'));
    assert.equal(path.isAbsolute(body.path), false);

    const listed = JSON.parse((await execute({ action: 'list' }, ctx)).content[0].text);
    assert.equal(listed.total, 1);
    assert.match(listed.notes[0].text, /the tests live in tests\//);

    const searched = JSON.parse((await execute({ action: 'search', query: 'TESTS' }, ctx)).content[0].text);
    assert.equal(searched.returned, 1);

    // Default action is list, and an unknown action is refused rather than silently ignored.
    assert.equal(JSON.parse((await execute({}, ctx)).content[0].text).action, 'list');
    await assert.rejects(() => execute({ action: 'explode' }, ctx), /note_action_invalid/);
    // An empty note is refused at the tool boundary too.
    await assert.rejects(() => execute({ action: 'append', text: '' }, ctx), /note_text_required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('phase65 the note_store tool refuses a run with no project root', async () => {
  await assert.rejects(
    () => execute({ action: 'list' }, { toolId: 'note_store', executionContext: {} }),
    /project_root_required/
  );
});
