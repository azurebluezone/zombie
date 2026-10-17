/**
 * A configuration allowlist that silently excludes a tool is a trap.
 *
 * `ZOMBIECODER_TOOLS` is a hand-maintained list of enabled tool ids. A runnable tool that
 * is not on the list is refused at execution time as "disabled by configuration" — which,
 * from the outside, is indistinguishable from an application that was never granted it,
 * because the executor reports both as `tool_not_permitted`. Adding a tool to the
 * registry and forgetting the list therefore produces a runtime that looks broken for no
 * stated reason.
 *
 * This does not change the policy: an operator's list is still the list, and an empty
 * list still means "no list-based restriction". It only makes the exclusion visible at
 * boot instead of at the first tool call.
 */

/**
 * Accept both shapes a caller may hold: the raw comma-separated environment string, and
 * an already-split array. `process.env.ZOMBIECODER_TOOLS` is a string, so a guard that
 * only understood arrays would silently never fire.
 */
function toList(value) {
  return Array.isArray(value) ? value : String(value ?? '').split(',');
}

/** Tool ids that are runnable but absent from the configured allowlist. */
export function allowlistExclusions(allowList, runnableToolIds) {
  const listed = toList(allowList)
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (!listed.length) return { configured: false, listedCount: 0, excluded: [] };
  const excluded = toList(runnableToolIds)
    .map((value) => String(value ?? ''))
    .filter((id) => id && !listed.includes(id.toLowerCase()));
  return { configured: true, listedCount: listed.length, excluded };
}

export async function warnAboutAllowlistExclusions({ allowList, runnableToolIds, logger } = {}) {
  const result = allowlistExclusions(allowList, runnableToolIds);
  if (result.configured && result.excluded.length) {
    await logger?.warn?.('tool.config_allowlist_excludes_runnable_tools', {
      envKey: 'ZOMBIECODER_TOOLS',
      listedCount: result.listedCount,
      excluded: result.excluded,
      effect: 'these tools are refused until they are added to the list, or the list is emptied to mean "no list-based restriction"'
    });
  }
  return result;
}
