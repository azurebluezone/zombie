import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_TOOLS } from '../src/tools/common-defaults.js';
import {
  selectToolSurface,
  selectionText,
  groupToolIds,
  TOOL_SURFACE_MODES
} from '../src/tools/selection.js';

// The surface a real runtime offers: the 25 runnable tools.
const RUNNABLE = COMMON_TOOLS.filter((t) => t.entry).map((t) => t.id);

test('phase63 every tool the selector can offer actually exists', () => {
  const { core, groups } = groupToolIds();
  for (const id of core) {
    assert.ok(RUNNABLE.includes(id), `core tool ${id} is not a runnable tool`);
  }
  for (const group of groups) {
    for (const id of group.toolIds) {
      assert.ok(RUNNABLE.includes(id), `group ${group.id} names ${id}, which is not a runnable tool`);
    }
  }
});

test('phase63 a read-only question gets the look tools and no write tools', () => {
  const s = selectToolSurface({ text: 'What does src/policy do?', availableToolIds: RUNNABLE });
  assert.equal(s.mode, TOOL_SURFACE_MODES.NARROWED);
  assert.deepEqual(s.toolIds, ['read_file', 'list_directory', 'grep_search', 'file_search']);
  assert.equal(s.toolIds.includes('write_file'), false);
  assert.equal(s.toolIds.includes('execute_bash'), false);
  assert.equal(s.reason, 'core_only');
});

test('phase63 the surface is much smaller than the full one', () => {
  const read = selectToolSurface({ text: 'explain this module', availableToolIds: RUNNABLE });
  assert.ok(read.toolIds.length <= 4, `expected a small surface, got ${read.toolIds.length}`);
  const write = selectToolSurface({ text: 'fix the bug in the parser', availableToolIds: RUNNABLE });
  assert.ok(write.toolIds.length < RUNNABLE.length, 'a narrowed surface must be smaller');
  assert.ok(write.toolIds.length <= 12, `expected the cap to hold, got ${write.toolIds.length}`);
});

test('phase63 a change request gets the whole write family, not half of it', () => {
  const s = selectToolSurface({ text: 'Please edit the config and delete the old file', availableToolIds: RUNNABLE });
  assert.ok(s.groups.includes('write'));
  for (const id of ['write_file', 'create_file', 'edit_file', 'apply_diff', 'delete_file']) {
    assert.ok(s.toolIds.includes(id), `${id} should come with the write group`);
  }
});

test('phase63 running and verifying pulls in the terminal tools', () => {
  const s = selectToolSurface({ text: 'run the tests and verify the build', availableToolIds: RUNNABLE });
  assert.ok(s.groups.includes('run'));
  assert.ok(s.toolIds.includes('run_terminal_command'));
  assert.ok(s.toolIds.includes('execute_bash'));
});

test('phase63 version control and planning are recognised', () => {
  assert.ok(selectToolSurface({ text: 'show me the git diff', availableToolIds: RUNNABLE }).groups.includes('git'));
  assert.ok(selectToolSurface({ text: 'make a plan with a todo list', availableToolIds: RUNNABLE }).groups.includes('plan'));
  assert.ok(selectToolSurface({ text: 'where is this symbol referenced', availableToolIds: RUNNABLE }).groups.includes('explore'));
});

test('phase63 a tool the caller names explicitly is always offered', () => {
  // Nothing in the text suggests the terminal, but the caller asked for the tool by
  // id. An explicit request outranks the keyword matching.
  const s = selectToolSurface({
    text: 'hello',
    availableToolIds: RUNNABLE,
    requestedToolIds: ['kill_process', 'runtime_echo']
  });
  assert.ok(s.toolIds.includes('kill_process'));
  assert.ok(s.toolIds.includes('runtime_echo'));
});

test('phase63 a tool the task profile hints at is always offered', () => {
  const s = selectToolSurface({
    text: 'hello',
    availableToolIds: RUNNABLE,
    profileToolIds: ['task_planner', 'todo_manager']
  });
  assert.ok(s.toolIds.includes('task_planner'));
  assert.ok(s.toolIds.includes('todo_manager'));
});

test('phase63 the narrowed surface never offers a tool the caller did not allow', () => {
  const allowed = ['read_file', 'list_directory', 'grep_search', 'file_search', 'write_file'];
  const s = selectToolSurface({
    text: 'fix the bug and run the tests and show the git diff',
    availableToolIds: allowed,
    requestedToolIds: ['execute_bash', 'kill_process']
  });
  for (const id of s.toolIds) assert.ok(allowed.includes(id), `${id} is outside the allowed surface`);
  assert.equal(s.toolIds.includes('execute_bash'), false);
});

test('phase63 a small or empty catalog is left alone', () => {
  assert.equal(selectToolSurface({ text: 'x', availableToolIds: [] }).mode, TOOL_SURFACE_MODES.FULL);
  assert.deepEqual(selectToolSurface({ text: 'x', availableToolIds: ['read_file'] }).toolIds, ['read_file']);
});

test('phase63 asking for the full surface returns the full surface', () => {
  const s = selectToolSurface({ text: 'anything', availableToolIds: RUNNABLE, mode: TOOL_SURFACE_MODES.FULL });
  assert.deepEqual(s.toolIds, RUNNABLE);
  assert.deepEqual(s.dropped, []);
  assert.equal(s.reason, 'surface_mode_full');
});

test('phase63 the cap bounds the optional tools but never the core', () => {
  const s = selectToolSurface({
    text: 'fix the bug, run the tests, show the git diff, and make a plan with a todo list, then explore the structure',
    availableToolIds: RUNNABLE,
    maxTools: 6
  });
  assert.ok(s.toolIds.length <= 6, `cap not honoured: ${s.toolIds.length}`);
  for (const id of ['read_file', 'list_directory', 'grep_search', 'file_search']) {
    assert.ok(s.toolIds.includes(id), `the core tool ${id} must survive the cap`);
  }
});

test('phase63 dropped tools are reported, so the choice is auditable', () => {
  const s = selectToolSurface({ text: 'explain this', availableToolIds: RUNNABLE });
  assert.ok(s.dropped.includes('write_file'));
  assert.ok(s.dropped.includes('execute_bash'));
  assert.equal(s.dropped.length, RUNNABLE.length - s.toolIds.length);
});

test('phase63 the agent\'s own earlier output cannot widen the surface', () => {
  // A previous tool result may contain the word "delete" or "run" — for example a
  // directory listing with a file called delete_file.js. Only the user's words count,
  // otherwise the surface would grow back the moment a tool returned something.
  const text = selectionText({
    goal: 'what is in this folder',
    messages: [
      { role: 'user', content: 'what is in this folder' },
      { role: 'assistant', content: 'I ran delete_file and write_file on execute_bash' },
      { role: 'tool', content: 'delete_file.js write_file.js execute_bash.js' }
    ]
  });
  assert.equal(text.includes('delete_file'), false);
  assert.equal(text.includes('write_file'), false);
  const s = selectToolSurface({ text, availableToolIds: RUNNABLE });
  assert.equal(s.toolIds.includes('write_file'), false);
  assert.equal(s.toolIds.includes('execute_bash'), false);
});
