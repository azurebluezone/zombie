/**
 * Request-scoped tool surface.
 *
 * A tool loop used to offer every runnable tool on every round: 25 definitions, about
 * 1,900 tokens of prompt, re-sent on every round of every request. Nobody reads the
 * whole manual before answering a question — they reach for the few tools the job
 * actually needs, and look up the rest only if the job turns out to need them.
 *
 * This module decides which tools are *offered*. It never decides what is *allowed*.
 * Permission, consent, the path boundary, the task policy and the execution mode are
 * enforced downstream and are untouched by anything here: narrowing the offer can only
 * ever refuse to show a tool, never grant one.
 *
 * The surface is always the intersection of:
 *   - the agent's persisted scope (already resolved by the caller), and
 *   - the tools this module selects from it.
 *
 * Safety net: if anything goes wrong — an unknown catalog shape, an empty selection —
 * the caller keeps the full surface. A narrower surface must never be the reason a task
 * cannot be done.
 */

export const TOOL_SURFACE_MODES = Object.freeze({ NARROWED: 'narrowed', FULL: 'full' });

/**
 * The canonical tool for each purpose.
 *
 * `note_store` is here because it is the agent's own memory: a tool that lets an agent
 * record what it learned about this folder is only useful if it is always at hand. A
 * "note" tool that appeared only when the user said the word "note" would never be used.
 *
 * Deliberately excludes the compatibility aliases (`list_dir`, `read_directory`,
 * `find_files`, `execute_bash`, `revert_file`) and the near-duplicates
 * (`regex_search`, `view_symbol`, `code_graph`). They stay reachable through the full
 * surface; offering a model three spellings of "list a directory" is the confusion we
 * are removing, not a feature we are protecting.
 */
const CORE_TOOL_IDS = Object.freeze(['read_file', 'list_directory', 'grep_search', 'file_search', 'note_store']);

/**
 * Purpose groups, in the order they are considered. Each one is added whole, so a
 * request that needs to write always gets the whole write family rather than a random
 * half of it.
 */
const GROUPS = Object.freeze([
  {
    id: 'write',
    why: 'the request asks for a change',
    match: /\b(create|write|add|update|edit|modify|change|delete|remove|rename|refactor|implement|patch|rewrite|insert|append|fix|generate|build a file|save)\b/i,
    toolIds: ['write_file', 'create_file', 'edit_file', 'apply_diff', 'delete_file']
  },
  {
    id: 'run',
    why: 'the request asks to run or verify something',
    match: /\b(run|execute|test|tests|verify|verify it|lint|typecheck|compile|install|command|npm|node|terminal|script)\b/i,
    toolIds: ['run_terminal_command', 'execute_bash']
  },
  {
    id: 'git',
    why: 'the request mentions version control',
    match: /\b(git|commit|diff|status|revert|restore|undo|stash|branch|checkout)\b/i,
    toolIds: ['git_status', 'git_diff', 'undo', 'revert_file']
  },
  {
    id: 'plan',
    why: 'the request asks for a plan',
    match: /\b(plan|planning|todo|to-do|task list|break down|roadmap|steps|checklist)\b/i,
    toolIds: ['task_planner', 'todo_manager']
  },
  {
    id: 'explore',
    why: 'the request asks about structure or symbols rather than content',
    match: /\b(symbol|function|class|definition|definitions|reference|references|caller|callers|structure|tree|all files|every file|which files|list all|directory listing)\b/i,
    toolIds: ['list_dir', 'read_directory', 'find_files', 'regex_search', 'view_symbol', 'code_graph']
  }
]);

const normalize = (value) => String(value ?? '').toLowerCase();

/** All tool ids a group can contribute, regardless of what the catalog holds. */
export function groupToolIds() {
  return Object.freeze({ core: [...CORE_TOOL_IDS], groups: GROUPS.map((g) => ({ id: g.id, toolIds: [...g.toolIds] })) });
}

/**
 * Build the request text the selection reads. Only the user's own words count: the
 * agent's own previous tool output must not be able to widen the next round's surface.
 */
export function selectionText(input = {}) {
  const parts = [
    input.goal,
    input.expectedOutcome,
    ...(Array.isArray(input.messages) ? input.messages.filter((m) => m?.role === 'user').map((m) => m?.content) : [])
  ];
  return parts.filter(Boolean).map(String).join('\n');
}

/**
 * @param {object}   input
 * @param {string}   input.text             what the user asked for
 * @param {string[]} input.availableToolIds the surface the caller is willing to offer
 * @param {string[]} [input.requestedToolIds] tools named explicitly; always honoured
 * @param {string[]} [input.profileToolIds]  tools the task profile hints at
 * @param {string}   [input.mode]           TOOL_SURFACE_MODES
 * @param {number}   [input.maxTools]       hard cap on the offered surface
 * @returns {{toolIds:string[], mode:string, groups:string[], reason:string, dropped:string[]}}
 */
export function selectToolSurface({
  text = '',
  availableToolIds = [],
  requestedToolIds = [],
  profileToolIds = [],
  mode = TOOL_SURFACE_MODES.NARROWED,
  maxTools = 12
} = {}) {
  const available = [...new Set((Array.isArray(availableToolIds) ? availableToolIds : []).map(String))];
  const requested = [...new Set((Array.isArray(requestedToolIds) ? requestedToolIds : []).map(String))].filter((id) => available.includes(id));

  // Full surface on request, or when the caller has nothing to narrow.
  if (mode === TOOL_SURFACE_MODES.FULL || available.length <= CORE_TOOL_IDS.length + 1) {
    return {
      toolIds: available,
      mode: TOOL_SURFACE_MODES.FULL,
      groups: [],
      reason: mode === TOOL_SURFACE_MODES.FULL ? 'surface_mode_full' : 'surface_too_small_to_narrow',
      dropped: []
    };
  }

  const corpus = normalize(text);
  const keep = new Set(CORE_TOOL_IDS.filter((id) => available.includes(id)));
  const groups = [];

  // Tools named explicitly by the caller, and tools the task profile asked for, come
  // first: both are stronger signals than keyword matching.
  for (const id of requested) keep.add(id);
  for (const id of profileToolIds.map(String)) if (available.includes(id)) keep.add(id);

  for (const group of GROUPS) {
    if (!group.match.test(corpus)) continue;
    const ids = group.toolIds.filter((id) => available.includes(id));
    if (!ids.length) continue;
    groups.push(group.id);
    for (const id of ids) keep.add(id);
  }

  // Add groups in priority order until the cap, but never drop the core or an explicit
  // request — those are not negotiable, so the cap only limits the optional additions.
  const ordered = [...keep];
  const toolIds = ordered.slice(0, Math.max(CORE_TOOL_IDS.length, Number(maxTools) || 12));

  // A narrowing that leaves nothing usable is a bug, not a policy. Hand back the full
  // surface rather than making the agent unable to look at anything.
  if (!toolIds.length) {
    return { toolIds: available, mode: TOOL_SURFACE_MODES.FULL, groups: [], reason: 'selection_empty_fallback_full', dropped: [] };
  }

  const kept = new Set(toolIds);
  return {
    toolIds,
    mode: TOOL_SURFACE_MODES.NARROWED,
    groups,
    reason: groups.length ? `purpose:${groups.join('+')}` : 'core_only',
    dropped: available.filter((id) => !kept.has(id))
  };
}
