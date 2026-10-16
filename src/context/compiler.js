import path from 'node:path';

const DEFAULT_MAX_BYTES = 192 * 1024;
const DEFAULT_RECENT = 10;
const DEFAULT_SYLLABUS_ENTRIES = 6;
const DEFAULT_MEMORY_ENTRIES = 8;
const MAX_SECTION_CHARS = 6000;

const textOf = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const normalize = value => String(value ?? '').toLowerCase();

function words(query) {
  return normalize(query).split(/[^a-z0-9_\-./]+/).filter(x => x.length > 2).slice(0, 48);
}

function scoreText(text, queryWords) {
  const source = normalize(text);
  return queryWords.reduce((score, word) => score + (source.includes(word) ? 1 : 0), 0);
}

function parseMarkdownSections(markdown = '') {
  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  let current = {title: 'ROOT', level: 0, lines: []};
  const flush = () => {
    const content = current.lines.join('\n').trim();
    if (content || current.title !== 'ROOT') sections.push({...current, content});
  };
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = {title: match[2], level: match[1].length, lines: []};
    } else current.lines.push(line);
  }
  flush();
  return sections;
}

function compactMessages(messages, limit = DEFAULT_RECENT) {
  return (Array.isArray(messages) ? messages : []).slice(-limit).map((message, index) => ({
    role: String(message?.role ?? 'unknown').slice(0, 32),
    content: textOf(message?.content ?? '').slice(0, 6000),
    ...(message?.tool_calls ? {tool_calls: message.tool_calls.slice(0, 8)} : {}),
    index
  }));
}

function selectSections(markdown, query, {always = [], maxSections = 8} = {}) {
  const sections = parseMarkdownSections(markdown);
  const queryWords = words(query);
  const selected = [];
  for (const section of sections) {
    const title = normalize(section.title);
    if (always.some(x => title.includes(normalize(x)))) selected.push({...section, score: 1000});
  }
  for (const section of sections) {
    if (selected.some(x => x.title === section.title)) continue;
    const score = scoreText(`${section.title}\n${section.content}`, queryWords);
    if (score > 0) selected.push({...section, score});
  }
  return selected.sort((a, b) => b.score - a.score || a.level - b.level).slice(0, maxSections).map(section => ({
    title: section.title,
    level: section.level,
    content: section.content.slice(0, MAX_SECTION_CHARS)
  }));
}

function parseSyllabus(markdown) {
  return parseMarkdownSections(markdown).filter(x => x.level >= 2).map(section => ({
    topic: section.title,
    content: section.content.slice(0, MAX_SECTION_CHARS)
  }));
}

function selectSyllabus(markdown, query, maxEntries = DEFAULT_SYLLABUS_ENTRIES) {
  const entries = parseSyllabus(markdown);
  const queryWords = words(query);
  return entries.map((entry, index) => ({...entry, index, score: scoreText(`${entry.topic}\n${entry.content}`, queryWords)}))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, maxEntries)
    .map(({topic, content}) => ({topic, content}));
}

function selectMemory(entries, query, limit = DEFAULT_MEMORY_ENTRIES) {
  const list = Array.isArray(entries) ? entries : [];
  const queryWords = words(query);
  return list.map((entry, index) => ({entry, index, score: scoreText(textOf(entry?.content ?? entry), queryWords)}))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map(x => x.entry);
}

function truncateToBytes(value, maxBytes) {
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) return value;
  const clone = structuredClone(value);
  while (Buffer.byteLength(JSON.stringify(clone)) > maxBytes) {
    if (clone.syllabus?.length) clone.syllabus.pop();
    else if (clone.memory?.length) clone.memory.pop();
    else if (clone.ssot?.sections?.length) clone.ssot.sections.pop();
    else if (clone.recent?.length > 1) clone.recent.shift();
    else break;
  }
  text = JSON.stringify(clone);
  if (Buffer.byteLength(text) > maxBytes) throw new Error('compiled_context_too_large');
  return clone;
}

export function compileContext({
  goal = '', userInput = '', recent = [], memory = [], ssot = null, syllabus = null,
  projectRoot = null, workingDirectory = null, sessionId = null, taskPolicy = null, evidence = [],
  maxBytes = DEFAULT_MAX_BYTES, recentLimit = DEFAULT_RECENT
} = {}) {
  const query = `${goal}\n${userInput}`;
  const ssotText = textOf(ssot?.content ?? ssot);
  const syllabusText = textOf(syllabus?.content ?? syllabus);
  const compiled = {
    schemaVersion: '1.0',
    strategy: 'purpose-first-context-compiler',
    facts: {
      projectRoot: projectRoot ? String(projectRoot) : null,
      workingDirectory: workingDirectory ? String(workingDirectory) : null,
      sessionId: sessionId ? String(sessionId) : null
    },
    ssot: {
      source: ssot?.path ?? null,
      sections: selectSections(ssotText, query, {always: ['project ssot', 'detected technologies', 'context boundaries'], maxSections: 8})
    },
    syllabus: selectSyllabus(syllabusText, query),
    memory: selectMemory(memory, query),
    recent: compactMessages(recent, recentLimit),
    evidence: (Array.isArray(evidence) ? evidence : []).slice(-8).map(item => ({
      source: String(item?.source ?? '').slice(0, 256),
      status: String(item?.status ?? '').slice(0, 32),
      confidence: String(item?.confidence ?? '').slice(0, 64),
      summary: String(item?.summary ?? '').slice(0, 1000),
      observedAt: item?.observedAt ?? null
    })),
    taskPolicy: taskPolicy ? {
      taskType: taskPolicy.taskType ?? null,
      effectiveToolIds: Array.isArray(taskPolicy.effectiveToolIds) ? taskPolicy.effectiveToolIds.slice(0, 50) : []
    } : null
  };
  const bounded = truncateToBytes(compiled, Math.max(32 * 1024, Number(maxBytes) || DEFAULT_MAX_BYTES));
  validateCompiledContext(bounded);
  return bounded;
}

export function validateCompiledContext(value) {
  if (!value || typeof value !== 'object') throw new Error('compiled_context_invalid');
  if (value.schemaVersion !== '1.0' || value.strategy !== 'purpose-first-context-compiler') throw new Error('compiled_context_schema_invalid');
  if (!value.facts || !Array.isArray(value.recent) || !Array.isArray(value.evidence) || !Array.isArray(value.syllabus) || !Array.isArray(value.memory)) throw new Error('compiled_context_shape_invalid');
  if (!value.ssot || !Array.isArray(value.ssot.sections)) throw new Error('compiled_context_ssot_invalid');
  if (value.facts.projectRoot && value.facts.workingDirectory) { const root = path.resolve(String(value.facts.projectRoot)); const cwd = path.resolve(String(value.facts.workingDirectory)); if (!(cwd === root || cwd.startsWith(`${root}${path.sep}`))) throw new Error('compiled_context_working_directory_outside_project'); }
  return true;
}
