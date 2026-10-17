import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_CONSTITUTION, CONSTITUTION_STATEMENTS, statementFor, constitutionWithStatements } from '../src/policy/constitution.js';
import { buildSystemMessage } from '../src/agents/system-prompt.js';

/*
 * phase77 — the constitution is policy, so it is written down and checked.
 *
 * A rule name is a slogan. "Never Hide Errors" leaves the reader to decide what
 * counts as hiding, and the first thing that gets softened when a 404 is easier
 * to write than an explanation is a slogan. So every name carries the sentence it
 * stands for, the sentence reaches the model, and the codes that make the rule
 * concrete are pinned here.
 *
 * The operator's standing instruction is that these are absolute: if we succeed we
 * succeed, if we fail we fail, if it is switched off it is switched off — no
 * compromise, and no silent state in between.
 */

test('phase77 every rule name has a statement, and there are no orphans', () => {
  for (const name of CORE_CONSTITUTION) {
    const statement = CONSTITUTION_STATEMENTS[name];
    assert.equal(typeof statement, 'string', `${name} must carry a statement`);
    assert.ok(statement.trim().length > 40, `${name}'s statement is too short to act on`);
  }
  for (const name of Object.keys(CONSTITUTION_STATEMENTS)) {
    assert.ok(CORE_CONSTITUTION.includes(name), `${name} is a statement for a rule that does not exist`);
  }
  assert.equal(Object.keys(CONSTITUTION_STATEMENTS).length, CORE_CONSTITUTION.length);
});

test('phase77 the rule the operator singled out names the concrete codes', () => {
  const statement = CONSTITUTION_STATEMENTS['Never Hide Errors'];
  // Without these, the rule is a sentiment. With them, it is checkable.
  assert.match(statement, /\b501\b/, 'the switched-off code must be named');
  assert.match(statement, /\b503\b/, 'the not-verified code must be named');
  assert.match(statement, /\b404\b/, 'the absent-path code must be named');
  assert.match(statement, /switched off says what it is and why/, 'a disabled capability must identify itself');
  assert.match(statement, /404 is reserved for a path that does not exist/, '404 means absent, not disabled');
  assert.match(statement, /off is off/, 'the operator states the rule this way; keep their words');
  assert.match(statement, /never answer with silence/, 'silence is the failure mode being ruled out');
});

test('phase77 statementFor enriches a known rule and touches nothing else', () => {
  assert.equal(statementFor('Never Hide Errors'), `Never Hide Errors — ${CONSTITUTION_STATEMENTS['Never Hide Errors']}`);
  // A caller's own rule text is not ours to rewrite. An operator's persona or a
  // test may pass its own wording, and it must arrive unchanged.
  assert.equal(statementFor('Never fabricate evidence.'), 'Never fabricate evidence.');
  assert.equal(statementFor('Something a test wrote'), 'Something a test wrote');
  assert.equal(statementFor(null), '');
  assert.equal(statementFor(undefined), '');
  assert.equal(statementFor('  '), '');
});

test('phase77 constitutionWithStatements returns one entry per rule, in order', () => {
  const expanded = constitutionWithStatements();
  assert.equal(expanded.length, CORE_CONSTITUTION.length);
  expanded.forEach((line, index) => assert.ok(line.startsWith(CORE_CONSTITUTION[index]), `entry ${index} keeps its name`));
  assert.ok(expanded.every((line) => line.includes(' — ')), 'every entry carries its statement');
});

test('phase77 the rules reach the model with their statements', () => {
  const message = buildSystemMessage({ constitution: CORE_CONSTITUTION, agent: { id: 'code-guru' }, goal: 'x' });
  assert.equal(message.role, 'system');
  for (const name of CORE_CONSTITUTION) {
    assert.ok(message.content.includes(name), `${name} is missing from the prompt`);
    assert.ok(message.content.includes(CONSTITUTION_STATEMENTS[name]), `${name}'s statement is missing from the prompt`);
  }
  // Numbered, as it has always been.
  assert.match(message.content, /1\. Evidence Before Confidence — /);
  assert.match(message.content, /NON-NEGOTIABLE RULES/);
});

test('phase77 no constitution passed means the real one, not a paraphrase', () => {
  const message = buildSystemMessage({ agent: { id: 'code-guru' }, goal: 'x' });
  for (const name of CORE_CONSTITUTION) {
    assert.ok(message.content.includes(name), `${name} must be in the fallback too`);
  }
  assert.ok(
    message.content.includes(CONSTITUTION_STATEMENTS['Never Hide Errors']),
    'the fallback must be the real rule, not a shorter second copy that can drift'
  );
});

// The block the rule list lives in. A match anywhere else in the prompt cannot
// confuse the assertion: the shared persona carries the same rule names in Bengali
// (see src/policy/shared-persona.js), which is a second, deliberate statement of
// them, not the list being composed here.
function rulesBlock(content) {
  const start = content.indexOf('NON-NEGOTIABLE RULES');
  assert.notEqual(start, -1, 'the prompt must carry a NON-NEGOTIABLE RULES block');
  const rest = content.slice(start);
  const end = rest.indexOf('\n\n', rest.indexOf('\n') + 1);
  return end === -1 ? rest : rest.slice(0, end);
}

test('phase77 a caller that writes its own rule keeps it, untouched', () => {
  const message = buildSystemMessage({ constitution: { rules: ['Never fabricate evidence.'] }, goal: 'x' });
  const block = rulesBlock(message.content);
  assert.ok(block.includes('1. Never fabricate evidence.'), 'the caller\'s rule is in the list');
  assert.equal(
    /Evidence Before Confidence|Never Hide Errors|SSOT Before Action/.test(block),
    false,
    'our rules are not appended to a caller-supplied list'
  );
});

test('phase77 the statements stay inside a prompt budget', () => {
  // The constitution is in every system message. Six rules, each one sentence.
  for (const [name, statement] of Object.entries(CONSTITUTION_STATEMENTS)) {
    assert.ok(statement.length <= 400, `${name}'s statement is ${statement.length} chars; keep it to one sentence`);
    assert.equal(statement.includes('\n'), false, `${name}'s statement must be a single line`);
  }
  const total = constitutionWithStatements().join('\n').length;
  assert.ok(total <= 1600, `the whole block is ${total} chars; it goes into every system message`);
});
