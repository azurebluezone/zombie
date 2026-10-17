import { loadEnvFile } from './env-loader.js';
import { resolveRuntimePath } from '../runtime/paths.js';

export const envLoadResult = loadEnvFile();
export function env(name, fallback = undefined) { return process.env[name] ?? fallback; }

// Reads a renamed variable, still honouring the name a previous release shipped so
// an existing .env keeps working. The deprecation is reported once, with the exact
// line to change, rather than failing silently or breaking a running deployment.
const deprecatedEnvReported = new Set();
function renamedEnv(currentName, legacyName, fallback = '') {
  const current = process.env[currentName];
  if (current !== undefined) return current;
  const legacy = process.env[legacyName];
  if (legacy === undefined) return fallback;
  if (!deprecatedEnvReported.has(legacyName)) {
    deprecatedEnvReported.add(legacyName);
    console.warn(`[env] ${legacyName} is deprecated; rename it to ${currentName} in .env (the old name still works).`);
  }
  return legacy;
}

function numberEnv(name, fallback, {min = null, max = null} = {}) {
  const raw = env(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (min !== null && value < min) return fallback;
  if (max !== null && value > max) return fallback;
  return value;
}

function listEnv(name) {
  return env(name, '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

// MCP_SERVER_AUTH accepts `required` (default) or `disabled`. Anything that reads
// as false/off/none also counts as disabled, so an operator can write
// MCP_SERVER_AUTH=false naturally without learning a vocabulary.
function mcpAuthRequiredEnv() {
  const value = env('MCP_SERVER_AUTH', 'required').trim().toLowerCase();
  return !['disabled', 'false', 'off', 'none', 'no', '0'].includes(value);
}

// Same as listEnv but for filesystem paths: case is significant on Linux and
// each entry is anchored to the runtime root instead of the caller's cwd.
function pathListEnv(name) {
  return env(name, '').split(',').map(x => x.trim()).filter(Boolean).map(value => resolveRuntimePath(value));
}

// Provider API keys. `PROVIDER_KEY_<ID>` is the explicit, provider-scoped form
// and always wins. Ollama's own documented convention is a single
// `OLLAMA_API_KEY`, so honour that as a fallback for every provider whose
// configured driver is `ollama` (matched from PROVIDER_CONFIG_JSON rather than
// a hardcoded id list, so a renamed or extra Ollama provider keeps working).
// A provider id that an earlier release shipped. Operators already have the old
// variable name in .env, so it keeps working: the legacy name is mapped onto the
// renamed provider instead of silently becoming an unused variable that leaves the
// provider unauthenticated. The explicit (new) name always wins.
const PROVIDER_KEY_ALIASES = Object.freeze({ 'ollama-local': 'ollama-selfhosted' });

function providerKeyIdFromEnvName(key) {
  return key.slice('PROVIDER_KEY_'.length).toLowerCase().replace(/_/g, '-');
}

// Exported (with an injectable environment) so the alias mapping can be verified
// directly instead of by re-implementing it in a test.
export function resolveProviderApiKeys(source = process.env) {
  const entries = Object.entries(source).filter(([key]) => key.startsWith('PROVIDER_KEY_'));
  const keys = {};
  // Pass 1: explicit names, so a renamed variable always beats its legacy alias.
  for (const [key, value] of entries) {
    const id = providerKeyIdFromEnvName(key);
    if (PROVIDER_KEY_ALIASES[id]) continue;
    keys[id] = value;
  }
  // Pass 2: legacy names, only where the explicit name is absent.
  for (const [key, value] of entries) {
    const target = PROVIDER_KEY_ALIASES[providerKeyIdFromEnvName(key)];
    if (target && keys[target] === undefined) keys[target] = value;
  }
  const ollamaKey = source.OLLAMA_API_KEY ?? '';
  if (!ollamaKey) return keys;
  let declared = [];
  try {
    const parsed = JSON.parse(source.PROVIDER_CONFIG_JSON ?? '[]');
    if (Array.isArray(parsed)) declared = parsed;
  } catch { declared = []; }
  for (const provider of declared) {
    if (provider?.driver !== 'ollama' || !provider?.id) continue;
    if (!keys[provider.id]) keys[provider.id] = ollamaKey;
  }
  return keys;
}

export const config = {
  host: env('HOST', '127.0.0.1'),
  port: numberEnv('PORT', 9999, {min:1,max:65535}),
  https: {
    enabled: env('HTTPS_ENABLED', 'false') === 'true',
    required: env('HTTPS_REQUIRED', 'false') === 'true',
    host: env('HTTPS_HOST', env('HOST', '127.0.0.1')),
    port: numberEnv('HTTPS_PORT', 10443, {min:1,max:65535}),
    key: resolveRuntimePath(env('HTTPS_KEY', './certs/server.key')),
    cert: resolveRuntimePath(env('HTTPS_CERT', './certs/server.crt'))
  },
  runtimeId: env('RUNTIME_ID', ''),
  instanceId: env('INSTANCE_ID', ''),
  uds: {
    enabled: env('UDS_ENABLED', process.platform === 'win32' ? 'false' : 'true') === 'true',
    required: env('UDS_REQUIRED', 'false') === 'true',
    path: resolveRuntimePath(env('UDS_PATH', './data/runtime.sock'))
  },
  adminToken: env('ADMIN_TOKEN', ''),
  // Loopback requests are the operator sitting at the machine; a request arriving
  // from anywhere else is not. The old LOCAL_AUTH_BYPASS name still works.
  loopbackAuthBypass: renamedEnv('LOOPBACK_AUTH_BYPASS', 'LOCAL_AUTH_BYPASS', 'false') === 'true',
  runtimeSecret: env('RUNTIME_SECRET', ''),
  dataDir: resolveRuntimePath(env('DATA_DIR', './data')),
  sqlitePath: resolveRuntimePath(env('SQLITE_PATH', './data/runtime.sqlite')),
  migrateJsonOnStart: env('MIGRATE_JSON_ON_START', 'false') === 'true',
  allowPlaintextHttp: env('ALLOW_PLAINTEXT_HTTP', 'false') === 'true',
  // Tool execution remains disabled until the deployment verification loop passes.
  executionMode: ['tools-enabled', 'chat-only'].includes(env('ZOMBIECODER_EXECUTION_MODE', 'chat-only')) ? env('ZOMBIECODER_EXECUTION_MODE', 'chat-only') : 'chat-only',
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://127.0.0.1:11434/v1'),
  providerCatalogSyncUrl: env('PROVIDER_CATALOG_SYNC_URL', ''),
  providerCatalogSyncOnStart: env('PROVIDER_CATALOG_SYNC_ON_START', 'true') === 'true',
  providerCatalogApiKey: env('PROVIDER_CATALOG_API_KEY', ''),
  providerSyncTimeoutMs: numberEnv('PROVIDER_SYNC_TIMEOUT_MS', 30000, {min:1000,max:120000}),
  // Socket inactivity budget for one provider chat/models call. Raise it for slow
  // a self-hosted runtime whose cold model load can exceed the 30s default.
  providerTimeoutMs: numberEnv('PROVIDER_TIMEOUT_MS', 30000, {min:1000,max:600000}),
  // Discover each enabled provider's real model list during startup bootstrap so
  // the stored catalog reflects what the upstream actually serves instead of a
  // hand-written declaration.
  providerModelsRefreshOnStart: env('PROVIDER_MODELS_REFRESH_ON_START', 'false') === 'true',
  providerModelsRefreshTimeoutMs: numberEnv('PROVIDER_MODELS_REFRESH_TIMEOUT_MS', 8000, {min:500,max:120000}),
  toolRoot: resolveRuntimePath(env('TOOL_ROOT', './tools')),
  toolLoopMaxRounds: numberEnv('TOOL_LOOP_MAX_ROUNDS', 8, {min:1,max:100}),
  toolLoopMaxToolCallsPerRound: numberEnv('TOOL_LOOP_MAX_TOOL_CALLS_PER_ROUND', 8, {min:1,max:100}),
  toolLoopMaxRepeatedCalls: numberEnv('TOOL_LOOP_MAX_REPEATED_CALLS', 2, {min:1,max:100}),
  sessionMaxMessages: numberEnv('SESSION_MAX_MESSAGES', 100, {min:1,max:10000}),
  // How many entries the per-project memory and the per-project notes keep. Both are
  // appended to forever otherwise, and an unbounded notes file is a prompt that grows
  // every time the agent learns something.
  memoryMaxEntries: numberEnv('MEMORY_MAX_ENTRIES', 500, {min:10,max:100000}),
  notesMaxEntries: numberEnv('NOTES_MAX_ENTRIES', 500, {min:10,max:100000}),
  contextBudgetBytes: numberEnv('CONTEXT_BUDGET_BYTES', 1024 * 1024, {min:64 * 1024,max:4 * 1024 * 1024}),
  // The compiled context is embedded in the prompt, and the prompt can only carry about
  // 24,000 characters of it. This budget must therefore stay *below* that: when it was
  // 192 KB a long conversation compiled to ~60 KB, the prompt cut it at the character
  // limit, and the model was handed invalid JSON. At 20 KB the compiler's own
  // `truncateToBytes` does the bounding instead — and it shrinks structurally (drops
  // syllabus, then memory, then SSOT sections, then the oldest messages), so what
  // remains is always valid and always the most recent part.
  compiledContextBytes: numberEnv('COMPILED_CONTEXT_BYTES', 20 * 1024, {min:4 * 1024,max:1024 * 1024}),
  contextRecentMessages: numberEnv('CONTEXT_RECENT_MESSAGES', 10, {min:1,max:50}),
  memoryMaxEntries: numberEnv('MEMORY_MAX_ENTRIES', 500, {min:1,max:100000}),
  maxBodyBytes: numberEnv('MAX_BODY_BYTES', 4 * 1024 * 1024, {min:1024,max:32 * 1024 * 1024}),
  maxProviderResponseBytes: numberEnv('MAX_PROVIDER_RESPONSE_BYTES', 4 * 1024 * 1024, {min:1024,max:32 * 1024 * 1024}),
  projectRoots: pathListEnv('PROJECT_ROOTS'),
  appRateLimit: numberEnv('APP_RATE_LIMIT', 60, {min:1,max:100000}),
  appConcurrency: numberEnv('APP_CONCURRENCY', 4, {min:1,max:1000}),
  logLevel: env('LOG_LEVEL', 'info'),
  logDir: resolveRuntimePath(env('LOG_DIR', './logs')),
  logFile: env('LOG_FILE', 'runtime.jsonl'),
  logToStdout: env('LOG_TO_STDOUT', 'true') !== 'false',
  logMaxBytes: numberEnv('LOG_MAX_BYTES', 10 * 1024 * 1024, {min:1024}),
  logMaxFiles: numberEnv('LOG_MAX_FILES', 7, {min:1,max:100}),
  logPayloads: env('LOG_PAYLOADS', 'false') === 'true',
  circuitBreaker: {
    failureThreshold: numberEnv('CIRCUIT_FAILURE_THRESHOLD', 3, {min:1,max:100}),
    resetTimeoutMs: numberEnv('CIRCUIT_RESET_TIMEOUT_MS', 15000, {min:100,max:3600000}),
    halfOpenMaxCalls: numberEnv('CIRCUIT_HALF_OPEN_MAX_CALLS', 1, {min:1,max:10})
  },
  mcpNetworkPolicy: {
    allowHttp: env('MCP_ALLOW_HTTP', 'false') === 'true',
    allowPrivateNetwork: env('MCP_ALLOW_PRIVATE_NETWORK', 'false') === 'true',
    allowHosts: listEnv('MCP_ALLOW_HOSTS'),
  },
  // Declared MCP endpoints are registered at startup either way; discovering
  // their tools is opt-in because it costs one outbound call per endpoint.
  // Without it a fresh install reports endpoints with zero tools.
  externalMcpDiscoverOnStart: env('EXTERNAL_MCP_DISCOVER_ON_START', 'false') === 'true',
  externalMcpRefreshToolsOnStart: env('EXTERNAL_MCP_REFRESH_TOOLS_ON_START', 'false') === 'true',
  externalMcpDiscoverTimeoutMs: numberEnv('EXTERNAL_MCP_DISCOVER_TIMEOUT_MS', 10000, {min:1000,max:120000}),
  // Inbound MCP is opt-in. When false the runtime stays client-only and /mcp
  // answers 501, so no server surface is opened unless an operator asks for it.
  mcpServerEnabled: env('MCP_SERVER_ENABLED', 'false') === 'true',
  // Project root that MCP tool calls operate inside. Empty means the runtime's
  // default project root (DATA_DIR); per-call _meta.projectRoot may override it,
  // bounded by PROJECT_ROOTS / the runtime's allowed roots.
  mcpServerProjectRoot: env('MCP_SERVER_PROJECT_ROOT', ''),
  // Inbound MCP authentication. `required` keeps POST /mcp behind an application
  // key (the existing behaviour). `disabled` is for loopback-only work: the
  // runtime then signs inbound MCP in as an auto-provisioned application so
  // sessions, tool permissions and audit entries still have a real owner. An
  // admin override can change this at runtime without editing .env or restarting.
  mcpRequireAuth: mcpAuthRequiredEnv(),
  // Tool access mode. `permissioned` (default) keeps the application-scoped
  // grant store as the authority: an application may only call a tool an operator
  // has explicitly granted. `unrestricted` drops that per-application gate so
  // every agent can call every runnable tool; a tool that is disabled by
  // configuration is still refused, and the agent's own path scope still bounds
  // where those tools may operate.
  toolAccessMode: env('TOOL_ACCESS_MODE', 'permissioned') === 'unrestricted' ? 'unrestricted' : 'permissioned',
  // What the runtime *offers* an agent, not what it *allows*. `narrowed` shows only the
  // tools the request's purpose needs, plus a small always-on set: that removes roughly
  // 1,900 tokens of tool definitions from every round of a tool loop. `full` shows every
  // allowed tool, which is what happened before. Permission, consent, the path boundary,
  // the task policy and the execution mode are unaffected either way — narrowing the
  // offer can only ever hide a tool, never grant one. A request that names `toolIds`
  // explicitly, or sends `toolSurface:'full'`, keeps the full allowed surface.
  toolSurfaceMode: env('TOOL_SURFACE_MODE', 'narrowed') === 'full' ? 'full' : 'narrowed',
  toolSurfaceMax: numberEnv('TOOL_SURFACE_MAX', 12, {min:4,max:64}),
  // Explicit browser CORS allowlist. Empty means same-origin only (no CORS headers).
  corsAllowOrigins: env('CORS_ALLOW_ORIGINS', '').split(',').map(x => x.trim()).filter(Boolean),
  providerNetworkPolicy: {
    allowPlaintextHttp: env('ALLOW_PLAINTEXT_HTTP', 'false') === 'true',
    allowPrivateNetwork: env('PROVIDER_ALLOW_PRIVATE_NETWORK', 'false') === 'true',
    allowPrivateHosts: listEnv('PROVIDER_ALLOW_PRIVATE_HOSTS'),
    allowHosts: listEnv('PROVIDER_ALLOW_HOSTS'),
    maxResponseBytes: numberEnv('MAX_PROVIDER_RESPONSE_BYTES', 4 * 1024 * 1024, {min:1024,max:32 * 1024 * 1024})
  },
  providerApiKeys: resolveProviderApiKeys()
};
