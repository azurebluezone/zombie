/**
 * Which internal error codes may be handed back to the caller.
 *
 * A runtime that answers a policy refusal with `request_failed` is lying by omission.
 * The operator sees a code that reads like a bug, has nothing to act on, and cannot
 * tell "you typed a date the runtime cannot read" from "the process broke". That is
 * the failure this module exists to prevent.
 *
 * The list below is a hard allowlist and, on its own, it drifts: `outbound_protocol_forbidden`
 * is raised whenever an outbound endpoint is not https, and it was not on the list, so a
 * perfectly precise refusal reached the caller as `request_failed`. Rather than chase
 * entries one by one, a code is published when it matches a *shape* the runtime owns.
 *
 * The shape rule is deliberately narrow, because the message here is `Error.message`
 * and some messages interpolate caller input or an upstream string:
 *
 *   - A family code is lowercase snake_case ending at the family name. A suffix such as
 *     `mcp_timeout:30000` therefore does NOT match, and stays closed. Fail closed for
 *     anything with free text; publish only what is a pure identifier.
 *   - The two exceptions are named explicitly and are audited: application write
 *     validation echoes the value the caller just sent (so the operator can see which
 *     date or field was refused), and the proxy-side 4xx/5xx codes below are already
 *     stable and free of user data.
 *
 * Nothing here inspects or redacts the message; it decides publication only. Messages
 * that are not published are still written in full to the log and the audit trail.
 */

/** Codes published verbatim. Kept as data so the decision is auditable in one place. */
export const PUBLIC_ERROR_CODES = Object.freeze([
  'runtime_instance_already_locked',
  'uds_path_already_exists',
  'tool_not_permitted',
  'tool_entry_outside_tool_root',
  'tool_entry_symlink_escape',
  'execution_path_outside_project_root',
  'execution_working_directory_outside_project_root',
  'execution_path_symlink_escape',
  'project_root_required',
  'invalid_json_body',
  'request_body_too_large',
  'application_unauthorized_or_expired',
  'admin_unauthorized',
  'provider_not_found_or_disabled',
  'provider_model_required',
  'provider_model_not_configured',
  'no_provider_route_available',
  'provider_streaming_not_supported',
  'execution_consent_required',
  'execution_contract_required',
  'qualified_tool_required',
  'mcp_tool_not_permitted',
  'mcp_https_url_required',
  'mcp_endpoint_not_found',
  'mcp_tool_not_found',
  'mcp_tool_arguments_must_be_object',
  'mcp_response_too_large',
  'mcp_invalid_response',
  'mcp_timeout',
  'project_root_not_allowed',
  'project_root_not_found',
  'application_id_required',
  'application_not_found',
  'application_id_and_tool_required',
  'tool_disabled_by_configuration',
  'outbound_circuit_open'
]);

const PUBLIC_ERROR_SET = new Set(PUBLIC_ERROR_CODES);

/**
 * Families whose members are pure identifiers: no interpolation, no upstream text, no
 * caller input. `outbound_*` are network-policy refusals, `provider_*` are provider
 * configuration and response diagnoses, `token_vault_*` are key/secret diagnoses, and
 * `mcp_*` are tool-bridge diagnoses.
 */
const RUNTIME_CODE_FAMILY = /^(?:outbound|provider|token_vault|mcp)_[a-zA-Z0-9_]+$/;

/**
 * Application write validation, where the suffix is the caller's own value echoed back.
 * `:...` is allowed only for these four names, and the suffix is trimmed by the thrower,
 * so this cannot become a channel for arbitrary detail.
 */
const APPLICATION_WRITE_ERROR = /^application_(?:expiresAt_invalid|role_invalid|status_invalid|patch_field_not_allowed)(?::.{0,80})?$/;

/** The single code used when nothing above applies. Kept as a name so callers match on it. */
export const REQUEST_FAILED = 'request_failed';

/**
 * The code to send. Returns the message when it is a code the runtime owns and is safe
 * to publish, otherwise `request_failed`.
 */
export function publicErrorCode(message) {
  const text = String(message ?? '');
  if (!text) return REQUEST_FAILED;
  if (PUBLIC_ERROR_SET.has(text)) return text;
  if (RUNTIME_CODE_FAMILY.test(text)) return text;
  if (APPLICATION_WRITE_ERROR.test(text)) return text;
  return REQUEST_FAILED;
}
