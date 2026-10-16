const DEFAULT_BYTES = 1024 * 1024;
const DEFAULT_RECENT = 10;
const textOf = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);

function score(entry, query) {
  const text = textOf(entry?.content ?? entry?.message ?? entry).toLowerCase();
  const words = String(query ?? '').toLowerCase().split(/[^a-z0-9_\-]+/).filter(w => w.length > 2).slice(0, 32);
  return words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
}

export function buildBoundedContext({ userInput = '', recent = [], archive = [], ssot = null, syllabus = null, maxBytes = DEFAULT_BYTES, recentLimit = DEFAULT_RECENT } = {}) {
  const cap = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_BYTES);
  const selectedRecent = Array.isArray(recent) ? recent.slice(-recentLimit) : [];
  const candidates = Array.isArray(archive) ? archive.map((entry, index) => ({entry, index, score:score(entry, userInput)})).filter(x => x.score > 0).sort((a,b) => b.score-a.score || b.index-a.index) : [];
  const selectedArchive = [];
  let used = 0;
  const add = (label, value) => {
    const block = value ? `${label}\n${textOf(value)}\n` : '';
    if (!block) return '';
    const bytes = Buffer.byteLength(block);
    if (used + bytes > cap) return '';
    used += bytes;
    return block;
  };
  let archiveText = '';
  for (const item of candidates) {
    const block = add(`ARCHIVE[${item.index}]`, item.entry);
    if (!block) break;
    archiveText += block;
    selectedArchive.push(item.entry);
  }
  const ssotText = textOf(ssot?.content ?? ssot);
  const syllabusText = textOf(syllabus?.content ?? syllabus);
  const result = {
    recent: selectedRecent,
    archive: selectedArchive,
    ssot: ssotText.slice(0, Math.max(0, Math.min(ssotText.length, Math.floor(cap * 0.45)))),
    syllabus: syllabusText.slice(0, Math.max(0, Math.min(syllabusText.length, Math.floor(cap * 0.25)))),
    bytes: used,
    maxBytes: cap,
    recentLimit,
    strategy: 'recent-10 + relevance-selected-archive + bounded-ssot-syllabus'
  };
  while (Buffer.byteLength(JSON.stringify(result)) > cap && result.archive.length) result.archive.pop();
  return result;
}
