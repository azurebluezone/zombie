/**
 * Agent tool access model.
 *
 * Two persisted fields describe how far a single agent may reach:
 *
 *   toolBoundary      'global' | 'working-directory'
 *   workingDirectory  absolute path used when the boundary is 'working-directory'
 *
 * Both live on the agent record and are mirrored into real columns on the
 * `agents` table (`tool_boundary`, `working_directory`) so an operator can query
 * them without parsing the JSON payload.
 *
 * The boundary never narrows *which* tools exist — every agent sees the whole
 * runnable tool registry. It only decides *where* those tools may operate:
 *
 *   global             the agent may name any project root on the host.
 *   working-directory  the agent is pinned to its own working directory; a
 *                      project root outside it is refused by the path boundary.
 *
 * `resolveAgentAccess` is pure: it returns the intent, and the caller (the HTTP
 * layer) applies it through the project context and execution context.
 */

export const TOOL_BOUNDARY_GLOBAL = 'global';
export const TOOL_BOUNDARY_WORKING_DIRECTORY = 'working-directory';

export const TOOL_BOUNDARY_MODES = Object.freeze([
  TOOL_BOUNDARY_GLOBAL,
  TOOL_BOUNDARY_WORKING_DIRECTORY
]);

/** Default reach for an agent that has never been configured: its own directory.
 *
 * A fresh runtime must not hand every agent the whole host. `working-directory`
 * with no stored directory resolves to the runtime's configured default working
 * directory (or DATA_DIR), so the agent is bounded even before an operator names
 * a project. `global` remains available, but only as an explicit choice.
 */
export const DEFAULT_TOOL_BOUNDARY = TOOL_BOUNDARY_WORKING_DIRECTORY;

const ALIASES = new Map([
  ['global', TOOL_BOUNDARY_GLOBAL],
  ['any', TOOL_BOUNDARY_GLOBAL],
  ['all', TOOL_BOUNDARY_GLOBAL],
  ['unrestricted', TOOL_BOUNDARY_GLOBAL],
  ['working-directory', TOOL_BOUNDARY_WORKING_DIRECTORY],
  ['working_directory', TOOL_BOUNDARY_WORKING_DIRECTORY],
  ['workingdirectory', TOOL_BOUNDARY_WORKING_DIRECTORY],
  ['working dir', TOOL_BOUNDARY_WORKING_DIRECTORY],
  ['workdir', TOOL_BOUNDARY_WORKING_DIRECTORY],
  ['directory', TOOL_BOUNDARY_WORKING_DIRECTORY],
  ['project', TOOL_BOUNDARY_WORKING_DIRECTORY]
]);

export function isToolBoundaryMode(value) {
  return ALIASES.has(String(value ?? '').trim().toLowerCase());
}

export function normalizeToolBoundary(value, { fallback = DEFAULT_TOOL_BOUNDARY } = {}) {
  if (value == null || String(value).trim() === '') return fallback;
  return ALIASES.get(String(value).trim().toLowerCase()) ?? fallback;
}

/**
 * Normalize the two access fields for storage. Unknown boundary values fall back
 * to the supplied default so a typo can never silently remove the pin.
 */
export function normalizeAgentAccess(input = {}, { fallbackBoundary = DEFAULT_TOOL_BOUNDARY } = {}) {
  const raw = input ?? {};
  const toolBoundary = normalizeToolBoundary(raw.toolBoundary, { fallback: fallbackBoundary });
  const rawDirectory = raw.workingDirectory;
  const workingDirectory = rawDirectory == null || String(rawDirectory).trim() === ''
    ? null
    : String(rawDirectory).trim();
  return { toolBoundary, workingDirectory };
}

/**
 * Resolve how one run should be scoped.
 *
 * `toolSurface` is always 'all': the agent boundary is a path scope, not a tool
 * allowlist. `allowAnyRoot` tells the project context whether the agent may name
 * a root outside the runtime's configured allowed roots.
 *
 * A global agent keeps the caller's root, which may be absent: it must not
 * silently acquire the runtime's data directory as its project.
 */
export function resolveAgentAccess(agent, { requestedRoot = null, requestedWorkingDirectory = null, defaultRoot = null } = {}) {
  const { toolBoundary, workingDirectory } = normalizeAgentAccess(agent ?? {});
  if (toolBoundary === TOOL_BOUNDARY_WORKING_DIRECTORY) {
    const pinned = workingDirectory ?? defaultRoot ?? requestedRoot ?? null;
    return {
      toolBoundary,
      toolSurface: 'all',
      allowAnyRoot: false,
      projectRoot: pinned,
      workingDirectory: pinned,
      reason: workingDirectory ? 'agent_working_directory' : 'agent_working_directory_unset'
    };
  }
  return {
    toolBoundary,
    toolSurface: 'all',
    allowAnyRoot: true,
    projectRoot: requestedRoot ?? null,
    workingDirectory: requestedWorkingDirectory ?? requestedRoot ?? null,
    reason: 'agent_global'
  };
}

/** The stored shape, used by the registry merge and the admin API. */
export function agentAccessRecord(agent) {
  const { toolBoundary, workingDirectory } = normalizeAgentAccess(agent ?? {});
  return { toolBoundary, workingDirectory };
}
