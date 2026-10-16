/**
 * Purpose-first task policy.
 *
 * Legacy features are not copied here. We model the PURPOSE of a task and
 * derive the minimum evidence + tool surface required for that purpose.
 * Application/tool permission remains a separate enforcement boundary.
 */

export const TASK_POLICY_DECISIONS = Object.freeze({
  ALLOW_MINIMAL: 'allow_minimal',
  CONSENT_REQUIRED: 'consent_required',
  EVIDENCE_REQUIRED: 'evidence_required',
  UNSUPPORTED: 'unsupported'
});

const PROFILES = Object.freeze({
  answer: Object.freeze({
    id: 'answer',
    purpose: 'Answer from supplied context without unnecessary execution tools.',
    consentRequired: false,
    evidence: {mode: 'claim_source', requireSource: true, requireLocator: false},
    allowedToolHints: Object.freeze([]),
    verification: 'response_consistency'
  }),
  task_planning: Object.freeze({
    id: 'task_planning',
    purpose: 'Create or maintain a project-local plan without executing unrelated actions.',
    consentRequired: false,
    evidence: {mode: 'plan_only', requireSource: false, requireLocator: false},
    allowedToolHints: Object.freeze(['task_planner','todo_manager','read_file','list_directory']),
    verification: 'plan_persisted_or_returned'
  }),
  web_research: Object.freeze({
    id: 'web_research',
    purpose: 'Answer using external web evidence with the smallest possible tool surface.',
    consentRequired: false,
    evidence: {mode: 'external_source', requireSource: true, requireLocator: false},
    allowedToolHints: Object.freeze(['web_search']),
    verification: 'source_presence'
  }),
  file_evidence: Object.freeze({
    id: 'file_evidence',
    purpose: 'Answer from project files and cite exact file/line evidence when requested.',
    consentRequired: false,
    evidence: {mode: 'workspace_source', requireSource: true, requireLocator: true},
    allowedToolHints: Object.freeze(['read_file','list_directory','list_dir','read_directory','grep_search','regex_search','file_search','find_files','view_symbol','code_graph']),
    verification: 'file_locator_presence'
  }),
  workspace_write: Object.freeze({
    id: 'workspace_write',
    purpose: 'Change project files inside an explicitly bounded workspace.',
    consentRequired: true,
    evidence: {mode: 'workspace_change', requireSource: true, requireLocator: false},
    allowedToolHints: Object.freeze(['read_file','write_file','create_file','edit_file','apply_diff','delete_file','list_directory','list_dir','read_directory','grep_search','regex_search','file_search','find_files','view_symbol','code_graph','git_status','git_diff','undo','revert_file','todo_manager']),
    verification: 'post_write_observation'
  }),
  compile_verify: Object.freeze({
    id: 'compile_verify',
    purpose: 'Validate an implementation with the strongest available compiler/test evidence.',
    consentRequired: true,
    evidence: {mode: 'execution_result', requireSource: true, requireLocator: false},
    allowedToolHints: Object.freeze(['read_file','exec','compiler_check','list_directory','grep_search','file_search','run_terminal_command','execute_bash','git_status','git_diff']),
    verification: 'execution_and_test_evidence'
  }),
  browser_workflow: Object.freeze({
    id: 'browser_workflow',
    purpose: 'Perform a bounded browser workflow through the browser protocol boundary.',
    consentRequired: true,
    evidence: {mode: 'browser_observation', requireSource: true, requireLocator: false},
    allowedToolHints: Object.freeze(['browser_cdp']),
    verification: 'browser_observation'
  })
});

function textOf(input) {
  return [input?.goal, input?.expectedOutcome, input?.messages?.filter?.(m => m?.role === 'user')?.at(-1)?.content]
    .filter(Boolean).join(' ').toLowerCase();
}

export function resolveTaskProfile(input = {}) {
  const explicit = String(input.taskProfile ?? '').trim();
  if (explicit && PROFILES[explicit]) return PROFILES[explicit];
  if (explicit) throw new Error(`unknown_task_profile:${explicit}`);

  const text = textOf(input);
  if (/\b(plan|planning|todo|to-do|task list|break down this task)\b/i.test(text)) return PROFILES.task_planning;
  if (/\b(search|web|internet|online source|latest|look up)\b/i.test(text)) return PROFILES.web_research;
  if (/\b(line number|line no|file path|which file|read this file|source file)\b/i.test(text)) return PROFILES.file_evidence;
  if (/\b(create|write|update|edit|modify|delete|change)\b.*\b(file|folder|directory|code|script)\b/i.test(text)) return PROFILES.workspace_write;
  if (/\b(compile|test|tests|lint|typecheck|build|run the test)\b/i.test(text)) return PROFILES.compile_verify;
  if (/\b(browser|website|click|login|navigate|page)\b/i.test(text)) return PROFILES.browser_workflow;
  const requested = new Set(Array.isArray(input.toolIds) ? input.toolIds.map(String) : []);
  if ([...requested].some(id => ['create_file','write_file','edit_file','apply_diff','delete_file','undo','revert_file'].includes(id))) return PROFILES.workspace_write;
  if ([...requested].some(id => ['task_planner','todo_manager'].includes(id))) return PROFILES.task_planning;
  if ([...requested].some(id => ['run_terminal_command','execute_bash','kill_process'].includes(id))) return PROFILES.compile_verify;
  if ([...requested].some(id => ['read_file','list_directory','list_dir','read_directory','grep_search','regex_search','file_search','find_files','view_symbol','code_graph','git_status','git_diff'].includes(id))) return PROFILES.file_evidence;
  return PROFILES.answer;
}

export function buildTaskPolicy(input = {}) {
  const profile = resolveTaskProfile(input);
  const requested = Array.isArray(input.toolIds) ? input.toolIds.map(String) : [];
  const hints = new Set(profile.allowedToolHints);
  const effectiveToolIds = requested.filter(toolId => hints.has(toolId));
  const deniedRequestedTools = requested.filter(toolId => !hints.has(toolId));
  return Object.freeze({
    profileId: profile.id,
    purpose: profile.purpose,
    decision: profile.consentRequired ? TASK_POLICY_DECISIONS.CONSENT_REQUIRED : TASK_POLICY_DECISIONS.ALLOW_MINIMAL,
    consentRequired: profile.consentRequired,
    evidence: profile.evidence,
    verification: profile.verification,
    requestedToolIds: requested,
    effectiveToolIds,
    deniedRequestedTools,
    toolSurfaceMinimal: true
  });
}

export function getTaskProfiles() {
  return Object.values(PROFILES).map(profile => ({
    ...profile,
    allowedToolHints: [...profile.allowedToolHints]
  }));
}
