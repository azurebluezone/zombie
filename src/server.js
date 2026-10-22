import { mkdir, readFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config/env.js';
import { PROJECT_ROOT, fromRoot } from './runtime/paths.js';
import { createStore } from './storage/storage.js';
import { createApiKey, hashSecret, authenticateApiKey, isAdminApplication, roleOf } from './auth/application-auth.js';
import { isAdminAuthorized } from './auth/admin-auth.js';
import { id } from './core/ids.js';
import { McpRegistry, redactEndpoint } from './mcp/registry.js';
import { buildExternalToolSurface, boundaryEndpointIds } from './mcp/external-surface.js';
import { ProviderRegistry } from './providers/registry.js';
import { ContextResolver } from './context/resolver.js';
import { McpPermissions } from './mcp/permissions.js';
import { McpAudit } from './mcp/audit.js';
import { callMcpTool, LATEST_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from './mcp/client.js';
import { handleMcpServerMessage, mcpServerToolCatalog, negotiateProtocolVersion, MCP_SERVER_NAME } from './mcp/server.js';
import { validateToolArguments } from './mcp/schema.js';
import { AppLimits } from './mcp/limits.js';
import { McpConnections } from './mcp/connections.js';
import { McpClientSessions } from './mcp/sessions.js';
import { McpServerAuth } from './mcp/server-auth.js';
import { McpReconciliation } from './mcp/reconciliation.js';
import { ProjectContextStore } from './context/project-context.js';
import { EntityDoor } from './entities/entity-door.js';
import { CanonicalResponseNormalizer } from './providers/normalizer/canonical-response.js';
import { PersonaRegistry } from './agents/persona-registry.js';
import { AdminService } from './admin/admin-service.js';
import { createTokenVault } from './auth/token-vault.js';
import { CORE_CONSTITUTION, CONSTITUTION_STATEMENTS } from './policy/constitution.js';
import { send, body, bearer } from './http/json.js';
import { applySecurityHeaders, isTlsRequest } from './http/security-headers.js';
import { providerErrorDetail, retryAfterMsFrom } from './providers/adapters/request-shape.js';
import { ExecutionOrchestrator } from './execution/orchestrator.js';
import { ToolRegistry } from './tools/registry.js';
import { selectToolSurface, selectionText } from './tools/selection.js';
import { SkillRegistry } from './skills/registry.js';
import { AgentRegistry } from './agents/registry.js';
import { TransportRegistry } from './transport/registry.js';
import { ExtensionResolver } from './registry/resolver.js';
import { ProviderExecutionAdapter } from './execution/provider-adapter.js';
import { ToolExecutionAdapter } from './execution/tool-adapter.js';
import { McpExecutionAdapter } from './execution/mcp-adapter.js';
import { ExecutionAdapter } from './execution/execution-adapter.js';
import { EvidenceGate } from './evidence/gate.js';
import { SessionService } from './session/service.js';
import { SessionClient } from './session/client.js';
import { AgentRunner } from './agents/runner.js';
import { buildSystemMessage } from './agents/system-prompt.js';
import { SessionStateStore } from './session/state.js';
import { ToolLoopExecutor } from './execution/tool-loop.js';
import { SystemLogger } from './core/logger.js';
import { publicErrorCode, REQUEST_FAILED } from './core/public-errors.js';
import { envLoadResult } from './config/env.js';
import { legacyFeatureReport } from './compatibility/legacy/feature-registry.js';
import { reconciliationReport } from './compatibility/legacy/reconciliation.js';
import { buildTaskPolicy } from './execution/task-policy.js';
import { routeMapReport } from './compatibility/route-map.js';
import { startTransportServers, stopTransportServers } from './transport/server.js';
import { SSOTService } from './context/ssot.js';
import { SyllabusService } from './context/syllabus.js';
import { ProjectMemoryService } from './context/memory.js';
import { NoteStore } from './notes/note.js';
import { AutoSetupService } from './context/auto-setup.js';
import { SmartRouter } from './providers/router/smart-router.js';
import { maskCanonicalResponse, maskEvidenceForPublic, maskRouteForPublic } from './providers/masking/provider-mask.js';
import { ZOMBIECODER_MODELS } from './providers/masking/zombie-models.js';
import { completionToStreamChunk } from './providers/normalizer/stream-chunk.js';
import { createRuntimeIdentity, acquireRuntimeLock } from './runtime/identity.js';
import { createExecutionContext } from './execution/context.js';
import { ToolPolicy } from './tools/policy.js';
import { sanitizeSessionMetadata } from './session/metadata.js';
import { ExecutionLifecycle } from './execution/lifecycle.js';
import { bootstrapProviders } from './startup/provider-bootstrap.js';
import { warnAboutAllowlistExclusions } from './startup/allowlist-guard.js';
import { buildBoundedContext } from './context/context-budget.js';
import { compileContext } from './context/compiler.js';
import { CapabilityConfigResolver } from './registry/config-resolver.js';
import { ExternalMcpRegistry } from './registry/external-mcp.js';
import { ECOMMERCE_AGENT_TOOL_BOUNDARIES, getAgentToolBoundary } from './agents/ecommerce-tool-boundaries.js';
import { channelSummary } from './channels/catalog.js';
import { TOOL_BOUNDARY_MODES, agentAccessRecord, isToolBoundaryMode, resolveAgentAccess } from './agents/access.js';
import { configureOutboundCircuitLogger, configureOutboundCircuitBreaker, sharedOutboundCircuitBreaker } from './network/circuit-breaker.js';
import { RUNTIME_VERSION, RUNTIME_PHASE } from './runtime/version.js';
import { memorySnapshot, startMemoryMonitor } from './runtime/memory.js';
import { auditAgentRuntime } from './agents/runtime-audit.js';
import { AgentMetrics } from './agents/metrics.js';
import { legacyModelList, legacyProviderModelList, legacyNormalizeList, legacyDomain, legacyPusherConfig } from './compatibility/legacy/frontend-contract.js';
import { toolParityReport } from './compatibility/legacy/tool-parity.js';

const logger = new SystemLogger({dir:config.logDir,file:config.logFile,level:config.logLevel,stdout:config.logToStdout,maxBytes:config.logMaxBytes,maxFiles:config.logMaxFiles,allowPayloads:config.logPayloads});
configureOutboundCircuitLogger(logger);
configureOutboundCircuitBreaker(config.circuitBreaker);
await mkdir(config.dataDir, {recursive:true});
const runtimeIdentity = createRuntimeIdentity(config);
const releaseRuntimeLock = await acquireRuntimeLock(config.dataDir, runtimeIdentity, {logger});
process.env.RUNTIME_ID = runtimeIdentity.runtimeId;
process.env.INSTANCE_ID = runtimeIdentity.instanceId;
if (config.uds.enabled && (!process.env.UDS_PATH || process.env.UDS_PATH === './data/runtime.sock')) config.uds.path = path.resolve(config.dataDir, `runtime-${runtimeIdentity.runtimeId.replace(/[^a-zA-Z0-9._-]/g,'_')}.sock`);
await logger.info('runtime.env_loaded', {path:envLoadResult.path,loaded:envLoadResult.loaded,keys:envLoadResult.keys,totalKeys:envLoadResult.totalKeys,skipped:envLoadResult.skipped});
const store = await createStore(config);
const mcp = new McpRegistry(store, {networkPolicy:config.mcpNetworkPolicy});
const externalMcp = new ExternalMcpRegistry({store, mcpRegistry:mcp, root:fromRoot('external-mcp'), logger});
const providers = new ProviderRegistry(store, config);
const providerBootstrap = await bootstrapProviders({ registry: providers, config, logger });
const externalMcpBootstrap = await externalMcp.sync({
  discover: config.externalMcpDiscoverOnStart,
  discoverTimeoutMs: config.externalMcpDiscoverTimeoutMs,
  refreshDiscovered: config.externalMcpRefreshToolsOnStart
});
const contexts = new ContextResolver(store);
// Allowed project roots: the runtime's own tree, its data directory, and the launch
// directory (the conventional "current project"). Extra roots come from PROJECT_ROOTS.
//
// Note that the launch directory IS in this list, so in `permissioned` mode the trust
// boundary does depend on where the shell happened to be — `cd / && npm start` would make
// `/` an allowed root. In `unrestricted` mode (and for any agent whose persisted scope is
// `global`, which resolves with `allowAnyRoot`) `allowedRoots` is not consulted at all, so
// today this only matters to an operator running `permissioned`. It is logged at boot as
// `runtime.project_roots` rather than changed here, because path scoping is a deliberate,
// currently frozen decision: see ProjectContextStore, which dropped the same cwd fallback
// for the same reason (a root that changes with the shell is not a boundary).
const projectAllowedRoots = config.projectRoots.length ? config.projectRoots : [...new Set([config.dataDir, PROJECT_ROOT, process.cwd()])];
const projectContext = new ProjectContextStore({defaultRoot:config.dataDir, allowedRoots:projectAllowedRoots});
await logger.info('runtime.project_roots', {
  source: config.projectRoots.length ? 'PROJECT_ROOTS' : 'default',
  allowedRoots: projectAllowedRoots,
  cwd: process.cwd(),
  cwdIsAllowed: projectAllowedRoots.includes(path.resolve(process.cwd())),
  toolAccessMode: config.toolAccessMode
});
const ssot = new SSOTService({contextStore:projectContext});
const syllabus = new SyllabusService({contextStore:projectContext});
const memory = new ProjectMemoryService({contextStore:projectContext, maxEntries:config.memoryMaxEntries ?? 500});
const notes = new NoteStore({maxNotes:config.notesMaxEntries ?? 500});
const autoSetup = new AutoSetupService({contextStore:projectContext, ssot, syllabus, memory});
await autoSetup.ensure(config.dataDir, {refreshSSOT:false});
const entityDoor = new EntityDoor();
const normalizer = new CanonicalResponseNormalizer();
const personas = new PersonaRegistry(store, logger);
await personas.ensureDefaults();
// Per-agent run counters for the admin console (see src/agents/metrics.js).
const agentMetrics = new AgentMetrics(store);
// The vault that seals user tokens at rest. Null when TOKEN_ENCRYPTION_KEY is unset,
// which is a supported state, not an error: tokens are then hash-only and the admin
// API reports `token_not_recoverable` instead of inventing one.
const tokenVault = createTokenVault(config.tokenEncryptionKey);
const admin = new AdminService(store, {vault:tokenVault});
const toolsRegistry = new ToolRegistry(store);
const skillsRegistry = new SkillRegistry(store);
const agentsRegistry = new AgentRegistry(store);
const transportsRegistry = new TransportRegistry(store);
const extensionResolver = new ExtensionResolver({agents: agentsRegistry, skills: skillsRegistry, tools: toolsRegistry, transports: transportsRegistry});
const permissions = new McpPermissions(store, {accessMode:config.toolAccessMode});
const mcpAudit = new McpAudit(store);
const connections = new McpConnections(store, {leaseMs:Number(process.env.MCP_CONNECTION_LEASE_MS ?? 300000)});
// Inbound MCP client sessions (clients talking to this runtime's /mcp server).
const mcpClients = new McpClientSessions(store, {idleMs:Number(process.env.MCP_CLIENT_IDLE_MS ?? 120000)});
// Inbound MCP auth policy: env default, admin override wins. See src/mcp/server-auth.js.
const mcpServerAuth = new McpServerAuth(store, {requireAuth: config.mcpRequireAuth});
const reconciliation = new McpReconciliation(mcpAudit, {graceMs:Number(process.env.MCP_RECONCILIATION_GRACE_MS ?? 30000)});
await connections.cleanupExpired();
if (process.env.MCP_RECONCILE_ON_START === 'true') await reconciliation.reconcile();
const limits = new AppLimits({maxRequests:Number(process.env.APP_RATE_LIMIT ?? 60), maxConcurrent:Number(process.env.APP_CONCURRENCY ?? 4)});
const smartRouter = new SmartRouter({providers, logger});
const capabilityConfig = new CapabilityConfigResolver({store});
const toolPolicy = new ToolPolicy(store, {configResolver:capabilityConfig, accessMode:config.toolAccessMode});
const toolExecution = new ToolExecutionAdapter({registry:toolsRegistry, toolRoot:config.toolRoot, logger, policy:toolPolicy});
// Registering a tool is not enough. `ZOMBIECODER_TOOLS` is a hand-maintained allowlist,
// and a runnable tool that is missing from it is refused as
// `tool_disabled_by_configuration` — which the executor reports as `tool_not_permitted`,
// exactly like a missing grant. Say so once at boot instead of leaving the first tool
// call to explain it. Read from `process.env` because that is the source the capability
// resolver itself reads, so there is only one list.
await warnAboutAllowlistExclusions({allowList:process.env.ZOMBIECODER_TOOLS,runnableToolIds:await runnableToolIds(),logger});
const mcpExecution = new McpExecutionAdapter({registry:mcp, permissions, audit:mcpAudit, connections, limits, logger, applications:(appId)=>admin.application(appId).catch(()=>null)});
const evidenceGate = new EvidenceGate({store, logger});
const sessions = new SessionService(store);
const executionLifecycle = new ExecutionLifecycle({sessions, evidenceGate, normalizer, logger, requireSystemPrompt:true});
const providerExecution = new ProviderExecutionAdapter({providers, normalizer, logger, router: smartRouter, lifecycle: executionLifecycle});
const sessionClient = new SessionClient({service:sessions});
const sessionState = new SessionStateStore({store, sessions, maxMessages:config.sessionMaxMessages});
const executionAdapter = new ExecutionAdapter({provider:providerExecution, tool:toolExecution, mcp:mcpExecution});
const toolLoop = new ToolLoopExecutor({providers, executionAdapter, normalizer, evidenceGate, sessionState, logger, router:smartRouter, lifecycle:executionLifecycle, maxRounds:config.toolLoopMaxRounds, maxToolCallsPerRound:config.toolLoopMaxToolCallsPerRound, maxRepeatedCalls:config.toolLoopMaxRepeatedCalls});
executionAdapter.loop = toolLoop;
const agentRunner = new AgentRunner({registry:agentsRegistry, personas, evidenceGate, logger});
const execution = new ExecutionOrchestrator({extensionResolver, executor:executionAdapter});
function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}
const adminOk = async (req) => {
  const raw = bearer(req);
  if (isAdminAuthorized(raw, config.adminToken)) return true;
  if (config.loopbackAuthBypass && !config.adminToken && isLoopbackRequest(req)) return true;
  // An application the operator marked `admin` reaches the admin API with its own
  // token. That is what the role is for: work from another machine, or from a
  // client's own Laravel, without copying the global admin secret onto it.
  //
  // A token with no role, or with `user`, is refused here — which is precisely the
  // behaviour every application had before roles existed, so the thirteen rows in
  // the store today are unaffected.
  return isAdminApplication(raw, await admin.stored());
};
// The status an application-credential failure deserves. A user that does not exist
// is a `404`; a token that exists but cannot be shown is a `409`. Keeping the two
// apart is invariant 14 — absent is not the same as switched off, and "I cannot show
// you this" is not "this does not exist".
const applicationErrorStatus = (code) => {
  if (code === 'application_not_found') return 404;
  if (code.startsWith('token_not_recoverable') || code.startsWith('token_vault_')) return 409;
  return 400;
};
// The runnable native tool surface. An agent's access scope is "all", so this is
// the surface every agent sees: registered tools that can actually execute.
async function runnableToolIds() {
  return (await toolsRegistry.list())
    .filter(tool => tool.entry && ['ENABLED','VERIFIED'].includes(tool.status))
    .map(tool => tool.id);
}
// One agent's persisted access scope plus the roots it implies.
//
//   projectRoot    where project state (SSOT, memory, context) is read from; may
//                  be absent for a global agent that named no root.
//   workspaceRoot  the cwd a tool starts from. Always set, so a tool that needs a
//                  working directory never has to invent one.
//
// Both are resolved with allowAnyRoot: an agent scope is never re-bounded by the
// runtime's PROJECT_ROOTS.
async function resolveAgentScope(agentId, { requestedRoot = null, requestedWorkingDirectory = null } = {}) {
  const agent = (await agentsRegistry.list()).find(item => item.id === String(agentId)) ?? null;
  const access = resolveAgentAccess(agent, { requestedRoot, requestedWorkingDirectory, defaultRoot: projectContext.defaultRoot });
  const projectRoot = access.projectRoot ? projectContext.root(access.projectRoot, { allowAnyRoot: true }) : null;
  // The agent scope has already authorized this root. Remember it, so the services that
  // only receive the resolved path (SSOT, syllabus, memory, auto-setup) do not re-check it
  // against PROJECT_ROOTS and refuse a root the agent was just granted.
  if (projectRoot) projectContext.trustRoot(projectRoot);
  const workspaceRoot = projectRoot ?? projectContext.root(process.cwd(), { allowAnyRoot: true });
  return { agent, access, projectRoot, workspaceRoot };
}
// Executes one native tool for an inbound MCP tools/call. Auth, the application
// tool-permission check and the project-root sandbox are enforced here, exactly
// as the chat tool loop enforces them: an MCP client gets no more authority than
// the application it authenticated as already has.
async function executeMcpServerTool(applicationId, toolId, args, requestId, meta = {}) {
  if (config.executionMode !== 'tools-enabled') { const error = new Error('tool_execution_not_verified'); error.statusCode = 503; throw error; }
  const decision = await toolPolicy.decision(applicationId, toolId);
  if (!decision.allowed) throw new Error(`tool_not_permitted:${decision.reason}`);
  const requestedRoot = String(meta?.projectRoot ?? config.mcpServerProjectRoot ?? '').trim() || null;
  // In the unrestricted mode the project-root allowlist is no longer the
  // boundary, matching what an agent scope already grants the chat path.
  const projectRoot = projectContext.root(requestedRoot, { allowAnyRoot: config.toolAccessMode === 'unrestricted' });
  const goal = `mcp tools/call ${toolId}`;
  const prepared = await execution.prepare({ goal, consent: true, agentId: 'code-guru', toolIds: [toolId] });
  const context = createExecutionContext({ applicationId, requestId, projectRoot, workingDirectory: projectRoot, allowAnyPath: config.toolAccessMode === 'unrestricted', allowAnyCommand: config.toolAccessMode === 'unrestricted', agentId: 'code-guru', goal, toolId, transport: 'mcp' }, runtimeIdentity);
  const outcome = await toolExecution.execute({ prepared, input: { toolId, arguments: args }, applicationId, context });
  return outcome.result ?? outcome;
}
// Bounded tail read of the structured runtime log, for the admin observability
// view. Reads at most the last 512 KiB so a large log can never be pulled into
// memory whole, and drops a possibly-truncated first line after a partial read.
async function tailJsonLines(limit) {
  const file = path.join(config.logDir, config.logFile);
  const info = await stat(file);
  const maxBytes = 512 * 1024;
  const start = Math.max(0, info.size - maxBytes);
  const handle = await open(file, 'r');
  try {
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    if (start > 0 && lines.length) lines.shift();
    return lines.slice(-limit).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { await handle.close(); }
}
// Server-Sent Events tail of the structured runtime log.
//
// The browser owns the filtering, so this stays a thin tail: replay the last
// `backfill` lines, then push every appended line as it lands. No log shipper,
// no extra process — just one read offset per open connection, and a heartbeat
// so an idle stream is not mistaken for a dead one.
async function streamJsonLines(req, res, { backfill = 40 } = {}) {
  const file = path.join(config.logDir, config.logFile);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let offset = 0;
  try {
    const info = await stat(file);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, info.size - maxBytes);
    const handle = await open(file, 'r');
    try {
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      if (start > 0 && lines.length) lines.shift();
      for (const line of lines.slice(-backfill)) {
        try { res.write(`data: ${JSON.stringify(JSON.parse(line))}\n\n`); } catch { /* skip malformed */ }
      }
    } finally { await handle.close(); }
    offset = info.size;
  } catch (error) {
    if (error?.code !== 'ENOENT') { try { res.write(`event: stream-error\ndata: ${JSON.stringify({error:'log_read_failed'})}\n\n`); } catch {} }
    offset = 0;
  }
  try { res.write(`event: ready\ndata: ${JSON.stringify({backfill})}\n\n`); } catch {}
  let pending = '';
  const poll = setInterval(async () => {
    try {
      const info = await stat(file);
      if (info.size < offset) { offset = 0; pending = ''; }   // rotated or truncated
      if (info.size <= offset) return;
      const length = info.size - offset;
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        offset = info.size;
        pending += buffer.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          res.write(`data: ${line}\n\n`);
        }
      } finally { await handle.close(); }
    } catch { /* the file may not exist yet; try again on the next tick */ }
  }, 700);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  const cleanup = () => { clearInterval(poll); clearInterval(heartbeat); };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}
async function applyAgentModelMapping(input) {
  const agentId=String(input?.agent??input?.persona??'code-guru');
  const mapping=(await store.read('agentModelMappings',[])).find(item=>item.agentId===agentId);
  // An agent mapping only supplies the DEFAULT model. A model the client named
  // explicitly always wins: rewriting an explicit public alias here would make
  // the published masking catalog and its response echo meaningless.
  if(mapping && !input?.model) {
    return {...input,model:mapping.model,meta:{...(input.meta??{}),agentModelMapping:{agentId,model:mapping.model}}};
  }
  return input;
}

function maskUrlSecrets(value) {
  if (!value) return value;
  try {
    const u = new URL(String(value));
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    for (const key of [...u.searchParams.keys()]) if (/key|token|secret|auth|password|credential/i.test(key)) u.searchParams.set(key, '***');
    return u.toString();
  } catch { return String(value).replace(/(key|token|secret|password)=([^&]+)/ig, '$1=***'); }
}
function publicProvider(provider) {
  const {apiKey, api_key, secret, token, ...safe} = provider ?? {};
  return {...safe, baseUrl:maskUrlSecrets(safe.baseUrl), syncUrl:maskUrlSecrets(safe.syncUrl)};
}

const applications = async () => store.read('applications', []);
async function authenticateRequest(req, requestLog, requestState) {
  const app = authenticateApiKey(bearer(req), await applications());
  if (!app) {
    requestState.outcome = 'unauthorized';
    await requestLog.warn('application.auth.failed', {reason:'missing_or_invalid_or_expired_key'});
    return null;
  }
  requestState.applicationId = app.id;
  requestState.outcome = 'accepted';
  await requestLog.info('application.auth.succeeded', {applicationId:app.id});
  return app;
}
const legacyAudit = legacyFeatureReport();
const legacyReconciliation = reconciliationReport();

function boundedConversation(inputMessages, recentSession, archiveSession, userInput) {
  const incoming = Array.isArray(inputMessages) ? inputMessages.filter(m => m?.role !== 'system') : [];
  const archive = Array.isArray(archiveSession) ? archiveSession : [];
  const recent = Array.isArray(recentSession) ? recentSession.slice(-config.contextRecentMessages) : archive.slice(-config.contextRecentMessages);
  const bounded = buildBoundedContext({userInput, recent, archive, maxBytes:config.contextBudgetBytes, recentLimit:config.contextRecentMessages});
  const seen = new Set();
  const messages = [];
  for (const m of [...bounded.recent, ...incoming]) {
    const key = JSON.stringify(m);
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(m);
  }
  let out = messages;
  while (Buffer.byteLength(JSON.stringify(out)) > config.contextBudgetBytes && out.length > 1) out = out.slice(1);
  return {messages:out, archiveSelected:bounded.archive.length, bytes:Buffer.byteLength(JSON.stringify(out)), maxBytes:config.contextBudgetBytes};
}

function latestUserMessage(messages = [], fallback = '') {
  const user = Array.isArray(messages) ? messages.filter(m => m?.role === 'user').at(-1) : null;
  return user ? {role:'user', content:user.content ?? ''} : {role:'user', content:fallback};
}

function compileRuntimeContext({goal, input, projectRoot, project, syllabusDoc, memoryDoc, session, taskPolicy}) {
  const archive = session ? session._compiledArchive ?? [] : [];
  return compileContext({
    goal,
    userInput: input.messages?.filter?.(m => m?.role === 'user').at(-1)?.content ?? goal,
    recent: Array.isArray(input.messages) ? input.messages.slice(-config.contextRecentMessages) : [],
    memory: memoryDoc ?? [],
    ssot: project,
    syllabus: syllabusDoc,
    projectRoot,
    workingDirectory: input.workingDirectory ?? projectRoot,
    sessionId: session?.id ?? input.sessionId ?? null,
    taskPolicy,
    maxBytes: config.compiledContextBytes,
    recentLimit: config.contextRecentMessages
  });
}

const requestHandler = async (req,res) => {
  const requestId = String(req.headers['x-request-id'] || id('req'));
  const traceId = String(req.headers['x-trace-id'] || id('trace'));
  const startedAt = Date.now();
  const requestState = {applicationId:null, operation:null, outcome:'unknown', agentId:null};
  // Agent run accounting. Failures are recorded once, from the outer catch, so
  // every path (chat, tool loop, stream, execution) is covered even when it
  // throws before its own completion hook runs.
  const recordAgentRun = (agentId, outcome, extra = {}) =>
    agentMetrics.record({ agentId, outcome, requestId, ...extra }).catch(() => {});
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-trace-id', traceId);
  // Hardening headers apply to every response (JSON, HTML, stream, UDS) because
  // Node merges headers set here with any later writeHead() call.
  applySecurityHeaders(res, {isTls:isTlsRequest(req), origin:req.headers.origin, allowedOrigins:config.corsAllowOrigins});
  const requestLog = logger.child({requestId, traceId, runtimeId:runtimeIdentity.runtimeId, instanceId:runtimeIdentity.instanceId, method:req.method, path:req.url});
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    const outcome = requestState.outcome === 'unknown'
      ? (res.statusCode >= 400 ? 'failure' : 'success')
      : requestState.outcome;
    requestLog.info('http.response', {statusCode:res.statusCode, durationMs:Date.now()-startedAt, applicationId:requestState.applicationId, operation:requestState.operation, outcome});
    return originalEnd(...args);
  };
  requestState.operation = `${req.method} ${new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname}`;
  requestLog.info('http.request', {operation:requestState.operation});
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    // CORS preflight: hardening + allowlisted CORS headers were applied above.
    if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }
    // No bundled frontend: this runtime is API-only. UIs are external clients that
    // receive the base URL and a token as values and are never read from this
    // process. 410 (not 404) is deliberate — the page used to exist here and its
    // absence is a boundary, not a typo.
    if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/chat' || url.pathname==='/chat/' || url.pathname==='/admin' || url.pathname==='/admin/')) {
      return send(res,410,{error:'frontend_not_bundled',message:'This runtime serves no UI. Use an external client with the API base URL and an application key or ADMIN_TOKEN.',uiConfig:'/v1/ui-config'});
    }
    // Public, non-secret bootstrap for external UIs. Any client (admin console,
    // chat client, script) can learn the shape of this runtime without holding an
    // admin token; authorization still happens per endpoint on every call. Provider
    // identities and API keys never appear here — only public masking models.
    if (req.method==='GET' && url.pathname==='/v1/ui-config') {
      const publicAgents = (await agentsRegistry.list()).map(a => ({id:a.id,name:a.name,role:a.role,publicModel:a.publicModel ?? null}));
      return send(res,200,{
        service:'zombiecoder-runtime', version:RUNTIME_VERSION, phase:RUNTIME_PHASE,
        executionMode:config.executionMode,
        ui:{bundled:false,admin:'external'},
        maskingModels:ZOMBIECODER_MODELS,
        agents:publicAgents,
        endpoints:{chat:'/v1/chat/completions',models:'/v1/models',health:'/health',mcp:config.mcpServerEnabled ? '/mcp' : null},
        auth:{admin:'bearer ADMIN_TOKEN',application:'bearer application key'},
        features:{streaming:true,toolLoop:typeof toolLoop?.execute==='function',agentRuns:typeof agentRunner?.prepare==='function'},
        generatedAt:new Date().toISOString()
      });
    }
    if (req.method==='GET' && url.pathname==='/health') {
      const coreModules = {
        ssot: typeof ssot?.read === 'function', memory: typeof memory?.recent === 'function', entityDoor: typeof entityDoor?.resolve === 'function', normalizer: typeof normalizer?.normalize === 'function',
        adminApi: typeof admin?.applications === 'function', personas: typeof personas?.resolve === 'function', executionBoundary: typeof execution?.prepare === 'function', registries: Boolean(agentsRegistry && toolsRegistry && skillsRegistry && transportsRegistry),
        extensionResolution: typeof extensionResolver?.resolve === 'function', providerExecution: typeof providerExecution?.execute === 'function', toolExecution: typeof toolExecution?.execute === 'function', mcpExecutionBoundary: typeof mcpExecution?.execute === 'function',
        providerAdapters: Boolean(providers), evidenceGate: typeof evidenceGate?.canClaimSuccess === 'function', sessionClient: typeof sessionClient?.resolve === 'function', agentBoundary: typeof agentRunner?.prepare === 'function', transportLayer: Boolean(transportServers),
        toolLoop: typeof toolLoop?.execute === 'function', sessionState: typeof sessionState?.list === 'function', envLoader: Boolean(envLoadResult), systemLogger: typeof logger?.info === 'function', ssotService: typeof ssot?.read === 'function',
        syllabusService: typeof syllabus?.read === 'function', memoryService: typeof memory?.recent === 'function', autoSetup: typeof autoSetup?.ensure === 'function', smartRouter: typeof smartRouter?.route === 'function', providerMasking: typeof maskCanonicalResponse === 'function',
        toolParser: true, verificationGate: typeof evidenceGate?.canClaimSuccess === 'function', systemPrompt: typeof buildSystemMessage === 'function', capabilityConfig: typeof capabilityConfig?.snapshot === 'function', externalMcpRegistry: typeof externalMcp?.sync === 'function',
        commonTools: typeof toolsRegistry?.list === 'function', agentToolBoundaries: Object.keys(ECOMMERCE_AGENT_TOOL_BOUNDARIES).length > 0, sessionMetadata: typeof sanitizeSessionMetadata === 'function', circuitBreaker: Boolean(sharedOutboundCircuitBreaker), mcpClient: typeof mcp?.tools === 'function', mcpServer: config.mcpServerEnabled===true
      };
      const agentAudit = await auditAgentRuntime({registry:agentsRegistry,personas,boundaryResolver:getAgentToolBoundary});
      requestState.outcome = 'success';
      return send(res,200,{ok:true,service:'zombiecoder-runtime',version:RUNTIME_VERSION,phase:RUNTIME_PHASE,runtime:runtimeIdentity,executionMode:config.executionMode,providerMode:'configured-compatible-endpoint',providerBootstrap:{registered:providerBootstrap.registered.length,sync:providerBootstrap.sync ? {ok:providerBootstrap.sync.ok !== false,providerCount:providerBootstrap.sync.providerCount ?? null,modelCount:providerBootstrap.sync.modelCount ?? null} : null},externalMcp:{folderCount:externalMcpBootstrap.folderCount,environmentCount:externalMcpBootstrap.environmentCount,registered:externalMcpBootstrap.definitions.filter(x=>x.status==='registered').length},legacyFeatureAudit:{source:legacyAudit.source,behaviorParityVerified:legacyAudit.behaviorParityVerified,counts:legacyAudit.counts,warnings:legacyAudit.warnings.length},legacyPurposeReconciliation:{behaviorParityVerified:legacyReconciliation.behaviorParityVerified,counts:legacyReconciliation.counts},coreModules,agentRuntime:agentAudit,circuitBreaker:{failureThreshold:sharedOutboundCircuitBreaker.failureThreshold,resetTimeoutMs:sharedOutboundCircuitBreaker.resetTimeoutMs,halfOpenMaxCalls:sharedOutboundCircuitBreaker.halfOpenMaxCalls}});
    }
    // Legacy frontend read contracts. These are compatibility envelopes, not provider disclosure.
    if (req.method==='GET' && url.pathname==='/v1/models') {
      return send(res,200,legacyModelList({agents:await agentsRegistry.list(),providers:await providers.list()}));
    }
    if (req.method==='GET' && (url.pathname==='/api/v0/models' || url.pathname==='/api/v1/models')) {
      return send(res,200,legacyProviderModelList(await providers.list()));
    }
    if (req.method==='GET' && url.pathname==='/api/agents') {
      const agents=await agentsRegistry.list();
      return send(res,200,{count:agents.length,source:'runtime-agent-registry',agents:agents.map(a=>({id:a.id,name:a.name,role:a.role,model:'masked',provider:'ZombieCoder'}))});
    }
    if (req.method==='GET' && url.pathname==='/api/domain') return send(res,200,legacyDomain({requestHost:req.headers.host||'localhost',version:RUNTIME_VERSION,projectRoot:config.dataDir}));
    if (req.method==='GET' && url.pathname==='/api/pusher-config') return send(res,200,legacyPusherConfig());
    if (req.method==='GET' && url.pathname==='/api/normalize-list') return send(res,200,legacyNormalizeList({providers:await providers.list(),models:(await providers.list()).flatMap(p=>p.models||[])}));
    if (req.method==='GET' && url.pathname==='/api/ssot') {
      const root=url.searchParams.get('projectRoot')||config.dataDir;
      await autoSetup.ensure(root);
      const doc=await ssot.read(root);
      return send(res,doc?200:404,doc?{success:true,source:'runtime',project_root:root,ssot_path:path.join(root,'.zombiecoder','SSOT.md'),length:doc.content?.length??0,content:doc.content,note:'Runtime SSOT compatibility view'}:{success:false,message:'No SSOT found'});
    }
    if (req.method==='GET' && url.pathname==='/api/config') {
      return send(res,200,{success:true,config:{version:RUNTIME_VERSION,phase:RUNTIME_PHASE,projectRoot:config.dataDir,toolRoot:config.toolRoot},domain:legacyDomain({requestHost:req.headers.host||'localhost',version:RUNTIME_VERSION,projectRoot:config.dataDir})});
    }
    if (url.pathname==='/mcp') {
      if (config.mcpServerEnabled !== true) {
        // Honest answer instead of a bare 404. Without MCP_SERVER_ENABLED=true this
        // runtime consumes MCP servers as a CLIENT only; the API must not advertise
        // a server capability that is switched off.
        return send(res,501,{error:'mcp_server_not_implemented',role:'mcp-client',protocol:'JSON-RPC 2.0',supported_protocol_versions:MCP_PROTOCOL_VERSIONS,note:'This runtime consumes MCP servers as a client; it does not expose an MCP server endpoint.'});
      }
      // Inbound MCP (Streamable HTTP server). POST carries JSON-RPC 2.0;
      // GET/DELETE are the optional session-channel/termination verbs.
      if (req.method==='DELETE') {
        const ended=req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : '';
        if (ended) await mcpClients.close(ended).catch(()=>{});
        res.writeHead(204,{'mcp-session-id':ended}); return res.end();
      }
      if (req.method!=='POST') { res.writeHead(405,{'allow':'POST, DELETE'}); return res.end(); }
      // A presented key always wins, so an authenticated client is attributed to
      // its own application even while authentication is disabled. Only when no
      // key is presented (or the key is invalid) does the policy decide: either
      // 401 as before, or the auto-provisioned application signs the call in
      // so sessions, tool permissions and audit still have an owner.
      const presentedApp=authenticateApiKey(bearer(req), await applications());
      const mcpAuthPolicy=await mcpServerAuth.policy();
      let mcpApp=presentedApp;
      if (!mcpApp && mcpAuthPolicy.requireAuth===false) mcpApp=await mcpServerAuth.autoProvisionedApplication();
      if (!mcpApp) {
        requestState.outcome='unauthorized';
        await requestLog.warn('mcp.server.auth_failed',{reason:'missing_or_invalid_or_expired_key',requireAuth:true});
        // RFC 6750: a 401 on a bearer-protected resource carries a challenge.
        // No `resource_metadata` is advertised on purpose: this runtime is not an
        // OAuth authorization server, so an OAuth-capable client should fall back
        // to a static token instead of attempting Dynamic Client Registration.
        return send(res,401,{jsonrpc:'2.0',id:null,error:{code:-32001,message:'unauthorized'}},{'www-authenticate':'Bearer realm="zombiecoder", error="invalid_token"'});
      }
      let mcpMessage;
      try { mcpMessage=await body(req, config.maxBodyBytes); }
      catch (error) { return send(res, Number(error?.statusCode)||400, {jsonrpc:'2.0',id:null,error:{code:-32700,message:'parse_error'}}); }
      const mcpRequestId=String(mcpMessage?.id ?? id('req'));
      const inboundSession=req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null;
      requestState.operation='POST /mcp';
      const outcome=await handleMcpServerMessage(mcpMessage, {
        tools: await toolsRegistry.list(),
        sessionId: inboundSession,
        executeTool: (name,args,meta)=>executeMcpServerTool(mcpApp.id,name,args,mcpRequestId,meta)
      });
      requestState.outcome='accepted';
      // Record the inbound client session so the console can answer "which
      // client is connected, what is its id, and what is it doing".
      const effectiveSession=outcome.sessionId ?? inboundSession;
      if (effectiveSession) {
        await mcpClients.touch({
          sessionId: effectiveSession,
          clientInfo: mcpMessage?.method === 'initialize' ? (mcpMessage?.params?.clientInfo ?? null) : null,
          protocolVersion: mcpMessage?.method === 'initialize' ? negotiateProtocolVersion(mcpMessage?.params?.protocolVersion) : null,
          applicationId: mcpApp.id,
          applicationName: mcpApp.name ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          authMode: presentedApp ? 'key' : 'auto',
          method: mcpMessage?.method ?? null,
          requestId: mcpRequestId
        }).catch(()=>{});
      }
      const headers=outcome.sessionId?{'mcp-session-id':outcome.sessionId,'mcp-protocol-version':LATEST_MCP_PROTOCOL_VERSION}:{};
      if (!outcome.body) { res.writeHead(202,headers); return res.end(); }
      return send(res,200,outcome.body,headers);
    }
    if (req.method==='GET' && url.pathname==='/api/config/mcp') {
      const publicUrl=`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host||`localhost:${config.port}`}`;
      const endpoints=await mcp.list();
      const serverEnabled=config.mcpServerEnabled===true;
      const serverTools=serverEnabled?mcpServerToolCatalog(await toolsRegistry.list()).map(tool=>tool.name):[];
      return send(res,200,{name:'ZombieCoder Runtime',role:serverEnabled?'mcp-client+server':'mcp-client',server:{implemented:serverEnabled,protocol:'JSON-RPC 2.0',protocol_version:LATEST_MCP_PROTOCOL_VERSION,supported_protocol_versions:MCP_PROTOCOL_VERSIONS,note:serverEnabled?'This runtime consumes MCP servers as a client and, because MCP_SERVER_ENABLED=true, also serves MCP on POST /mcp.':'This runtime consumes MCP servers as a client; it does not expose an MCP server endpoint.',tools:serverTools},transport:{type:'http',url:serverEnabled?`${publicUrl}/mcp`:null,implemented:serverEnabled},endpoints:{http:publicUrl,connect:null},client:{supported_protocol_versions:MCP_PROTOCOL_VERSIONS,endpoints:endpoints.map(endpoint=>({id:endpoint.id,name:endpoint.name,status:endpoint.status,protocol_version:endpoint.protocolVersion??null,toolCount:Array.isArray(endpoint.tools)?endpoint.tools.length:0}))},tools:(await mcp.tools()).map(t=>t.qualifiedName),timeout:300000});
    }
    if (req.method==='GET' && url.pathname==='/api/mcp-clients') {
      const publicUrl=`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host||`localhost:${config.port}`}`;
      const serverEnabled=config.mcpServerEnabled===true;
      return send(res,200,{domain:req.headers.host||'localhost',serverType:'runtime',version:RUNTIME_VERSION,total_requests:null,active_connections:null,connected_clients:await connections.list(),tools:(await mcp.tools()).length,server_url:serverEnabled?`${publicUrl}/mcp`:null,server_implemented:serverEnabled,protocol:'JSON-RPC 2.0',protocol_version:LATEST_MCP_PROTOCOL_VERSION,supported_protocol_versions:MCP_PROTOCOL_VERSIONS,outbound_protocol_version:LATEST_MCP_PROTOCOL_VERSION,note:serverEnabled?'This runtime also serves MCP on POST /mcp (MCP_SERVER_ENABLED=true); protocol_version is the version this runtime uses as an MCP client and server.':'No MCP server endpoint is exposed; protocol_version is the version this runtime uses when it acts as an MCP client.'});
    }
    if (req.method==='GET' && url.pathname==='/api/clients') return send(res,200,{clients:await connections.list(),count:(await connections.list()).length});

    if (req.method==='POST' && url.pathname==='/v1/admin/applications') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      // The notice travels with the record, so create and rotate cannot drift into
      // telling the operator two different things about the same token.
      return send(res,201,await admin.createApplication(await body(req, config.maxBodyBytes)));
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/applications') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      // `publicApplication()` already drops the hash and the sealed copy, so this
      // route no longer has to remember to.
      const applications=await admin.applications();
      return send(res,200,{
        applications,
        // Additive alias. The runtime's own word for a caller is "application"; the
        // operator's word is "user". A client should not have to translate.
        users:applications,
        // The ceiling a user inherits when they have none of their own. The console
        // shows it rather than hard-coding a number, so the screen and the runtime
        // can never disagree about the default.
        limitsDefault:{rateLimit:config.appRateLimit,concurrency:config.appConcurrency,windowMs:limits.windowMs},
        tokenVault:{configured:Boolean(tokenVault),keyId:tokenVault?.keyId??null,note:tokenVault?'Tokens are sealed with AES-256-GCM under a key held in the environment; a copy of the store alone will not open them.':'No TOKEN_ENCRYPTION_KEY is set, so a token exists only as a hash and cannot be shown again.'}
      });
    }
    if (req.method==='GET' && url.pathname.match(/^\/v1\/admin\/applications\/[^/]+\/token$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const appId=url.pathname.split('/')[4];
      try {
        const revealed=await admin.revealKey(appId);
        // Reading a customer's credential is a privileged act, so it leaves a row.
        await requestLog?.info?.('application.token.revealed',{applicationId:appId,role:revealed.role});
        return send(res,200,{...revealed,tokenNotice:'Live credentials: anyone holding this token can use the API as this user. It is never written to a log.'});
      } catch(error) {
        const code=String(error?.message ?? 'token_not_recoverable');
        return send(res,applicationErrorStatus(code),{error:code});
      }
    }
    if (req.method==='PATCH' && url.pathname.match(/^\/v1\/admin\/applications\/[^/]+$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const appId=url.pathname.split('/')[4];
      try {
        return send(res,200,{application:await admin.updateApplication(appId,await body(req, config.maxBodyBytes))});
      } catch(error) {
        const code=String(error?.message ?? 'application_update_failed');
        return send(res,applicationErrorStatus(code),{error:code});
      }
    }
    if (req.method==='POST' && url.pathname.match(/^\/v1\/admin\/applications\/[^/]+\/rotate-key$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const appId=url.pathname.split('/')[4]; return send(res,200,await admin.rotateKey(appId));
    }
    if (req.method==='POST' && url.pathname.match(/^\/v1\/admin\/applications\/[^/]+\/(revoke|extend)$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const appId=url.pathname.split('/')[4], action=url.pathname.split('/')[5], input=await body(req, config.maxBodyBytes);
      const patch=action==='revoke'?{status:'revoked'}:{expiresAt:input.expiresAt??null};
      return send(res,200,{application:await admin.updateApplication(appId,patch)});
    }
    // What a client's Laravel needs in order to trust the token it was handed: who
    // this is, what it may do, and the ceiling it is under. This is the whole point
    // of a per-user token — the shop verifies its own user against the runtime and
    // then does everything else itself.
    if (req.method==='GET' && url.pathname==='/v1/auth/verify') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      requestState.outcome='accepted';
      // `limits` is the effective ceiling, not the stored override: a client asking
      // "what am I allowed" must not have to know the runtime's defaults as well.
      const ceiling=limits.ceilingFor(app);
      return send(res,200,{verified:true,user:{id:app.id,name:app.name,role:roleOf(app)},limits:{rateLimit:ceiling.maxRequests,concurrency:ceiling.maxConcurrent,windowMs:limits.windowMs},expiresAt:app.expiresAt??null,issuedAt:app.createdAt??null});
    }
    if (req.method==='POST' && url.pathname==='/v1/sessions') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      requestState.outcome = 'accepted';
      const input = await body(req, config.maxBodyBytes);
      return send(res,201,{session:await sessions.create({applicationId:app.id,userId:input.userId ?? null,metadata:sanitizeSessionMetadata(input.metadata ?? {})})});
    }
    if (req.method==='GET' && url.pathname.match(/^\/v1\/sessions\/[^/]+$/)) {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const session=await sessions.get(url.pathname.split('/')[3],app.id);
      return session ? send(res,200,{session}) : send(res,404,{error:'session_not_found'});
    }
    if (req.method==='PATCH' && url.pathname.match(/^\/v1\/sessions\/[^/]+\/metadata$/)) {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const sessionId=url.pathname.split('/')[3];
      const input=await body(req, config.maxBodyBytes);
      const session=await sessions.updateMetadata(sessionId,app.id,input.metadata ?? input);
      if (!session) return send(res,404,{error:'session_not_found'});
      return send(res,200,{session});
    }
    if (req.method==='GET' && url.pathname.match(/^\/v1\/sessions\/[^/]+\/messages$/)) {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const sessionId=url.pathname.split('/')[3];
      try { return send(res,200,{sessionId,messages:await sessionState.list(sessionId,app.id)}); }
      catch (e) { if (e?.message === 'session_not_found') return send(res,404,{error:'session_not_found'}); throw e; }
    }
    if (req.method==='POST' && url.pathname.match(/^\/v1\/sessions\/[^/]+\/close$/)) {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const session=await sessions.close(url.pathname.split('/')[3],app.id);
      return session ? send(res,200,{session}) : send(res,404,{error:'session_not_found'});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/compatibility/tools') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,toolParityReport(await toolsRegistry.list()));
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/compatibility/features') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,legacyFeatureReport());
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/task-profiles') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{profiles:(await import('./execution/task-policy.js')).getTaskProfiles()});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/compatibility/reconciliation') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,legacyReconciliation);
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/compatibility/routes') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,routeMapReport());
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/evidence') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{evidence:await store.read('evidence',[])});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/logs/stream') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const backfill=Math.max(0,Math.min(200,Number(url.searchParams.get('backfill')??40)||0));
      await streamJsonLines(req,res,{backfill});
      return;
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/logs') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit')??200)||200));
      try { return send(res,200,{file:path.join(config.logDir,config.logFile),limit,events:await tailJsonLines(limit)}); }
      catch(error) { if(error?.code==='ENOENT') return send(res,200,{file:null,limit,events:[],note:'log file not created yet'}); throw error; }
    }
    if (req.method==='POST' && url.pathname==='/v1/context/setup') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,200,{applicationId:app.id, setup:await autoSetup.ensure(input.projectRoot || config.dataDir,{refreshSSOT:input.refreshSSOT === true})});
    }
    if (req.method==='GET' && url.pathname==='/v1/context') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const root=url.searchParams.get('projectRoot') || config.dataDir;
      await autoSetup.ensure(root);
      const [project,syllabusDoc,memoryDoc]=await Promise.all([ssot.read(root),syllabus.read(root),memory.read(root)]);
      return send(res,200,{applicationId:app.id,project,syllabus:syllabusDoc,memory:memoryDoc});
    }
    if (req.method==='POST' && url.pathname==='/v1/context/ssot/refresh') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,200,{applicationId:app.id,ssot:await ssot.refresh(input.projectRoot || config.dataDir,{reason:input.reason || 'api_refresh'})});
    }
    if (req.method==='POST' && url.pathname==='/v1/context/syllabus') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,201,{applicationId:app.id,entry:await syllabus.append(input.projectRoot || config.dataDir,input)});
    }
    if (req.method==='POST' && url.pathname==='/v1/context/memory') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,201,{applicationId:app.id,entry:await memory.append(input.projectRoot || config.dataDir,{...input,applicationId:app.id})});
    }
    if (req.method==='GET' && url.pathname==='/v1/context/memory/recent') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const root=url.searchParams.get('projectRoot') || config.dataDir;
      return send(res,200,{applicationId:app.id,entries:await memory.recent(root,url.searchParams.get('limit') || 10)});
    }
    // Project notes. The agent writes these through the `note_store` tool; this is the
    // same store for the console and for an application, so a note an agent left behind
    // is visible to the person who owns the folder.
    if (req.method==='GET' && url.pathname==='/v1/context/notes') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const root=url.searchParams.get('projectRoot') || config.dataDir;
      const query=url.searchParams.get('query') || '';
      const limit=url.searchParams.get('limit') || 20;
      const result=query
        ? await notes.search(root,{query,limit})
        : await notes.list(root,{limit,topic:url.searchParams.get('topic') || undefined,tag:url.searchParams.get('tag') || undefined});
      return send(res,200,{applicationId:app.id,path:result.path,total:result.total,returned:result.returned,notes:result.notes,warnings:result.warnings});
    }
    if (req.method==='POST' && url.pathname==='/v1/context/notes') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      try {
        const result=await notes.append(input.projectRoot || config.dataDir,{...input,source:input.source || `application:${app.id}`});
        return send(res,201,{applicationId:app.id,path:result.path,count:result.count,note:result.note});
      } catch (error) {
        if (String(error?.message)==='note_text_required') return send(res,400,{error:'note_text_required'});
        throw error;
      }
    }
    if (req.method==='DELETE' && url.pathname==='/v1/context/notes') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      if (!input.id) return send(res,400,{error:'note_id_required'});
      try {
        const result=await notes.remove(input.projectRoot || config.dataDir,{id:input.id});
        return send(res,200,{applicationId:app.id,path:result.path,removed:result.removed,count:result.count});
      } catch (error) {
        if (String(error?.message)==='note_not_found') return send(res,404,{error:'note_not_found'});
        throw error;
      }
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/tools/permissions') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{permissions:await toolPolicy.list()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/tools/permissions') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req,config.maxBodyBytes);
      const knownTools=await toolsRegistry.list();
      if (!input?.toolId || !knownTools.some(tool=>tool.id===String(input.toolId))) return send(res,400,{error:'tool_not_found',toolId:input?.toolId??null});
      return send(res,201,{permission:await toolPolicy.grant(input)});
    }
    if (req.method==='DELETE' && url.pathname==='/v1/admin/tools/permissions') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req,config.maxBodyBytes); return send(res,200,{revoked:await toolPolicy.revoke(input.applicationId,input.toolId)});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/external-mcp') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{servers:await externalMcp.status(),endpoints:await mcp.list()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/registry/external-mcp/sync') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{sync:await externalMcp.sync(),servers:await externalMcp.status()});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/applications/capabilities') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const applicationId=String(url.searchParams.get('applicationId') ?? '');
      if (!applicationId) return send(res,400,{error:'application_id_required'});
      const tools=await toolsRegistry.list();
      return send(res,200,{applicationId,tools:await capabilityConfig.snapshot(applicationId,tools.map(x=>x.id))});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/applications/capabilities/tools') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req,config.maxBodyBytes);
      const setting=await capabilityConfig.setToolSetting(input.applicationId,input.toolId,input.enabled);
      return send(res,200,{setting,decision:await toolPolicy.decision(input.applicationId,input.toolId)});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/tools') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{components:await toolsRegistry.list()});
    }
    // The messaging channels the runtime is being built to serve. This reports a
    // declaration, not health: nothing here calls Meta yet, and `status` says so.
    // It exists so the operator can see the plan without reading the source.
    if (req.method==='GET' && url.pathname==='/v1/admin/channels') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,channelSummary());
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/registry/tools') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{component:await toolsRegistry.register(await body(req, config.maxBodyBytes))});
    }
    // Global tool switch. Execution only accepts REGISTERED/ENABLED/VERIFIED
    // (see canResolveManifest), so DISABLED is what actually stops a tool from
    // being runnable. Per-application switches live on
    // /v1/admin/applications/capabilities/tools.
    if (req.method==='PATCH' && /^\/v1\/admin\/registry\/tools\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const toolId=decodeURIComponent(url.pathname.split('/')[5]);
      const current=(await toolsRegistry.list()).find(t=>t.id===toolId);
      if(!current) return send(res,404,{error:'tool_not_found'});
      const patch=await body(req,config.maxBodyBytes);
      return send(res,200,{component:await toolsRegistry.register({...current,...patch,id:toolId})});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/skills') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{components:await skillsRegistry.list()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/registry/skills') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{component:await skillsRegistry.register(await body(req, config.maxBodyBytes))});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/agents/tool-boundaries') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{boundaries:ECOMMERCE_AGENT_TOOL_BOUNDARIES});
    }
    if (req.method==='GET' && url.pathname.match(/^\/v1\/admin\/registry\/agents\/[^/]+\/tool-boundary$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const agentId=url.pathname.split('/')[5];
      const boundary=getAgentToolBoundary(agentId);
      if (!boundary) return send(res,404,{error:'agent_tool_boundary_not_found'});
      return send(res,200,{agentId,boundary});
    }
    // Agent tool-access scope: the persisted boundary mode plus the working
    // directory it pins to. The legacy /tool-boundary route above is the static
    // ecommerce profile; this one is the operator-editable scope every agent has.
    if ((req.method==='GET'||req.method==='PATCH') && url.pathname.match(/^\/v1\/admin\/registry\/agents\/[^/]+\/boundary$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const agentId=decodeURIComponent(url.pathname.split('/')[5]);
      // `resolve()` throws for an unknown or disabled agent; the admin surface
      // wants a plain 404 for "no such agent", so look the record up directly.
      const agent=(await agentsRegistry.list()).find(item=>item.id===agentId) ?? null;
      if (!agent) return send(res,404,{error:'agent_not_found',agentId});
      const effective=(record)=>resolveAgentAccess(record,{defaultRoot:projectContext.defaultRoot});
      if (req.method==='GET') {
        return send(res,200,{agentId,access:agentAccessRecord(agent),modes:TOOL_BOUNDARY_MODES,effective:effective(agent)});
      }
      const input=await body(req,config.maxBodyBytes);
      if (input?.toolBoundary !== undefined && !isToolBoundaryMode(input.toolBoundary)) {
        return send(res,400,{error:'tool_boundary_mode_invalid',allowedModes:TOOL_BOUNDARY_MODES,toolBoundary:input.toolBoundary});
      }
      const wanted=agentAccessRecord({...agent,...input});
      if (wanted.toolBoundary==='working-directory' && !wanted.workingDirectory) {
        return send(res,400,{error:'working_directory_required',toolBoundary:wanted.toolBoundary});
      }
      const next=await agentsRegistry.setAccess(agentId,input);
      const access=agentAccessRecord(next);
      await requestLog.info('agent.access.updated',{agentId,toolBoundary:access.toolBoundary,workingDirectory:access.workingDirectory});
      return send(res,200,{agentId,access,modes:TOOL_BOUNDARY_MODES,effective:effective(next)});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/agents') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{components:await agentsRegistry.list()});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/agents/runtime-audit') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,await auditAgentRuntime({registry:agentsRegistry,personas,boundaryResolver:getAgentToolBoundary}));
    }
    // Real observed run outcomes per agent (success/failure/incomplete), recorded
    // at the point each chat path actually completes or fails.
    if (req.method==='GET' && url.pathname==='/v1/admin/agents/metrics') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const metrics=await agentMetrics.list();
      const known=new Set((await agentsRegistry.list()).map(a=>a.id));
      return send(res,200,{metrics:metrics.map(m=>({...m,averageLatencyMs:m.runs&&m.totalLatencyMs?Math.round(m.totalLatencyMs/Math.max(1,m.success+m.failure+m.incomplete)):null,registered:known.has(m.agentId)})),total:metrics.length});
    }
    // Counters are observations, not history: an operator reset is the only way
    // to clear them, and it is explicit rather than time-based.
    if (req.method==='DELETE' && url.pathname==='/v1/admin/agents/metrics') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      await store.write('agentMetrics',[]);
      return send(res,200,{reset:true});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/registry/agents') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{component:await agentsRegistry.register(await body(req, config.maxBodyBytes))});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/registry/transports') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{components:await transportsRegistry.list()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/registry/transports') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{component:await transportsRegistry.register(await body(req, config.maxBodyBytes))});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/providers') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{providers:(await providers.list()).map(publicProvider)});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/providers/route') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,200,{route:await smartRouter.route(input)});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/providers') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{provider:publicProvider(await providers.register(await body(req, config.maxBodyBytes)))});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/masking-models') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{models:ZOMBIECODER_MODELS});
    }
    // Each normalizer/masking module is testable on its own: the console sends one
    // payload and gets the exact transform back, without touching a provider. The
    // same modules the request path uses are the ones under test — no re-implementation.
    if (req.method==='POST' && url.pathname==='/v1/admin/normalizer/test') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req, config.maxBodyBytes);
      const module=String(input.module ?? 'response');
      try {
        if (module==='response') {
          const output=normalizer.normalize(input.payload ?? {}, {model:String(input.model ?? 'admin-probe'),providerId:String(input.providerId ?? 'probe')});
          return send(res,200,{module,ok:true,output});
        }
        if (module==='stream') return send(res,200,{module,ok:true,output:completionToStreamChunk(input.payload ?? {})});
        if (module==='mask') {
          const output=maskCanonicalResponse(input.payload ?? {}, {agentId:String(input.agentId ?? 'code-guru'),configuredModel:String(input.model ?? 'zombie-mini'),capabilities:Array.isArray(input.capabilities)?input.capabilities:[]});
          return send(res,200,{module,ok:true,output});
        }
        return send(res,400,{error:'normalizer_module_unknown',modules:['response','stream','mask']});
      } catch (error) {
        const raw=String(error?.message ?? 'normalizer_test_failed');
        const code=/^[a-zA-Z0-9_.:-]{1,100}$/.test(raw)?raw:'normalizer_test_failed';
        return send(res,200,{module,ok:false,error:code});
      }
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/models') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const filter=url.searchParams.get('provider');
      const list=(await providers.list()).filter(p=>!filter||p.id===filter);
      return send(res,200,{models:list.flatMap(p=>(p.models??[]).map(model=>({id:`${p.id}:${model}`,providerId:p.id,providerName:p.name,model,enabled:p.enabled!==false,defaultModel:p.defaultModel===model,priority:p.priority??10}))) });
    }
    if (req.method==='PATCH' && /^\/v1\/admin\/providers\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const providerId=decodeURIComponent(url.pathname.split('/')[4]);
      const current=(await providers.list()).find(p=>p.id===providerId);
      if (!current) return send(res,404,{error:'provider_not_found'});
      const patch=await body(req,config.maxBodyBytes);
      const merged={...current,...patch,id:providerId}; delete merged.apiKey; delete merged.api_key;
      return send(res,200,{provider:publicProvider(await providers.register(merged))});
    }
    if (req.method==='DELETE' && /^\/v1\/admin\/providers\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const providerId=decodeURIComponent(url.pathname.split('/')[4]); const list=await providers.list();
      if(!list.some(p=>p.id===providerId)) return send(res,404,{error:'provider_not_found'});
      await store.write('providers',list.filter(p=>p.id!==providerId)); return send(res,200,{deleted:true,providerId});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/models/sync-all') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const results=[];
      for (const item of (await providers.list()).filter(p=>p.enabled!==false)) {
        try { const updated=await providers.refreshModels(item.id); results.push({providerId:item.id,status:'updated',modelCount:updated.models.length}); }
        catch(error) { results.push({providerId:item.id,status:'failed',error:String(error?.message??'model_sync_failed').replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,100)}); }
      }
      return send(res,200,{results});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/agent-model-mappings') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{mappings:await store.read('agentModelMappings',[])});
    }
    if (req.method==='PUT' && /^\/v1\/admin\/agent-model-mappings\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const agentId=decodeURIComponent(url.pathname.split('/')[4]);
      if (!(await agentsRegistry.list()).some(a=>a.id===agentId)) return send(res,404,{error:'agent_not_found'});
      const input=await body(req,config.maxBodyBytes); const model=String(input.model??'').trim();
      if (!model) return send(res,400,{error:'model_required'});
      const list=await store.read('agentModelMappings',[]); const item={id:agentId,agentId,model,updatedAt:new Date().toISOString()};
      await store.write('agentModelMappings',[...list.filter(x=>x.agentId!==agentId),item]); return send(res,200,{mapping:item});
    }
    if (req.method==='DELETE' && /^\/v1\/admin\/agent-model-mappings\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const agentId=decodeURIComponent(url.pathname.split('/')[4]);
      await store.write('agentModelMappings',(await store.read('agentModelMappings',[])).filter(x=>x.agentId!==agentId));
      return send(res,200,{deleted:true,agentId});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/metrics') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const [ps,as,apps,maps,auditEvents]=await Promise.all([providers.list(),agentsRegistry.list(),applications(),store.read('agentModelMappings',[]),store.read('mcp-audit',[])]);
      return send(res,200,{generatedAt:new Date().toISOString(),providers:{total:ps.length,enabled:ps.filter(p=>p.enabled!==false).length},models:{total:ps.reduce((n,p)=>n+(p.models?.length??0),0)},agents:{total:as.length,mapped:maps.length},applications:{total:apps.length,active:apps.filter(a=>a.status==='active').length},auditEvents:auditEvents.length,executionMode:config.executionMode,memory:memorySnapshot()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/providers/sync') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,200,{sync:await providers.syncAll({syncUrl:input.syncUrl || config.providerCatalogSyncUrl, apiKey:input.apiKey || config.providerCatalogApiKey, timeoutMs:input.timeoutMs || config.providerSyncTimeoutMs})});
    }
    if (req.method==='POST' && url.pathname.match(/^\/v1\/admin\/providers\/[^/]+\/health$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const providerId=decodeURIComponent(url.pathname.split('/')[4]);
      const current=(await providers.list()).find(p=>p.id===providerId); if(!current) return send(res,404,{error:'provider_not_found'});
      const checkedAt=new Date().toISOString();
      try {
        const refreshed=await providers.refreshModels(providerId);
        const healthy=await providers.register({...refreshed,healthStatus:'healthy',lastHealthCheckAt:checkedAt,lastHealthError:null});
        return send(res,200,{provider:publicProvider(healthy),health:{status:'healthy',checkedAt,modelCount:healthy.models?.length??0}});
      } catch(error) {
        const raw=String(error?.message??'provider_health_check_failed');
        const code=/^[a-zA-Z0-9_.:-]{1,100}$/.test(raw)?raw:'provider_health_check_failed';
        const failed=await providers.register({...current,healthStatus:'error',lastHealthCheckAt:checkedAt,lastHealthError:code});
        return send(res,200,{provider:publicProvider(failed),health:{status:'error',checkedAt,error:code}});
      }
    }
    // Admin-only live probe. Sends one non-streaming completion straight to a
    // chosen provider+model so the console can show the real request and the
    // real response, bypassing the masked agent path (which redacts upstream
    // identity). Loopback/admin-gated like the rest of /v1/admin.
    if (req.method==='POST' && url.pathname.match(/^\/v1\/admin\/providers\/[^/]+\/test$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const providerId=decodeURIComponent(url.pathname.split('/')[4]);
      const current=(await providers.list()).find(p=>p.id===providerId);
      if(!current) return send(res,404,{error:'provider_not_found'});
      const input=await body(req,config.maxBodyBytes);
      const prompt=String(input.prompt ?? 'Reply with the single word: ok').slice(0,4000);
      const requestedModel=String(input.model ?? '').trim();
      const messages=[{role:'user',content:prompt}];
      const startedAt=Date.now();
      const checkedAt=new Date().toISOString();
      try {
        const provider=await providers.resolve(providerId);
        const model=await providers.resolveModel(providerId, requestedModel);
        const raw=await provider.chatCompletions({model,messages,stream:false});
        const canonicalInput=typeof provider.toCanonical==='function' ? provider.toCanonical(raw) : raw;
        const canonical=normalizer.normalize(canonicalInput,{model,providerId:provider.id});
        await providers.register({...current,healthStatus:'healthy',lastHealthCheckAt:checkedAt,lastHealthError:null});
        return send(res,200,{ok:true,providerId,model,latencyMs:Date.now()-startedAt,request:{model,messages,stream:false},response:canonical,upstream:raw});
      } catch(error) {
        const rawMessage=String(error?.message??'provider_test_failed');
        const code=/^[a-zA-Z0-9_.:-]{1,100}$/.test(rawMessage)?rawMessage:'provider_test_failed';
        // A disabled provider is a configuration state, not a health failure, so
        // it must not flip the stored health flag.
        if (code !== 'provider_not_found_or_disabled') {
          await providers.register({...current,healthStatus:'error',lastHealthCheckAt:checkedAt,lastHealthError:code}).catch(()=>{});
        }
        return send(res,200,{ok:false,providerId,model:requestedModel||null,latencyMs:Date.now()-startedAt,request:{model:requestedModel||null,messages,stream:false},error:code});
      }
    }
    if (req.method==='POST' && url.pathname.match(/^\/v1\/admin\/providers\/[^/]+\/sync$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const providerId=url.pathname.split('/')[5];
      const input=await body(req, config.maxBodyBytes);
      return send(res,200,{sync:await providers.syncProvider(providerId,{syncUrl:input.syncUrl,timeoutMs:input.timeoutMs || config.providerSyncTimeoutMs})});
    }
    if (req.method==='POST' && url.pathname.match(/^\/v1\/admin\/providers\/[^/]+\/models\/refresh$/)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{provider:await providers.refreshModels(url.pathname.split('/')[4])});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/personas') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{personas:await personas.list()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/personas') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{persona:await personas.register(await body(req, config.maxBodyBytes))});
    }
    if (req.method==='PATCH' && /^\/v1\/admin\/personas\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const personaId=decodeURIComponent(url.pathname.split('/')[4]);
      const current=(await personas.list()).find(p=>p.id===personaId); if(!current) return send(res,404,{error:'persona_not_found'});
      const patch=await body(req,config.maxBodyBytes);
      return send(res,200,{persona:await personas.register({...current,...patch,id:personaId})});
    }
    if (req.method==='DELETE' && /^\/v1\/admin\/personas\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const personaId=decodeURIComponent(url.pathname.split('/')[4]);
      const current=await personas.list(); if(!current.some(p=>p.id===personaId)) return send(res,404,{error:'persona_not_found'});
      const item=current.find(p=>p.id===personaId);
      return send(res,200,{persona:await personas.register({...item,enabled:false})});
    }
    if (req.method==='PATCH' && /^\/v1\/admin\/registry\/agents\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const agentId=decodeURIComponent(url.pathname.split('/')[5]);
      const current=(await agentsRegistry.list()).find(a=>a.id===agentId); if(!current) return send(res,404,{error:'agent_not_found'});
      const patch=await body(req,config.maxBodyBytes);
      return send(res,200,{component:await agentsRegistry.register({...current,...patch,id:agentId})});
    }
    if (req.method==='DELETE' && /^\/v1\/admin\/registry\/agents\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const agentId=decodeURIComponent(url.pathname.split('/')[5]);
      const current=await agentsRegistry.list(); if(!current.some(a=>a.id===agentId)) return send(res,404,{error:'agent_not_found'});
      const agent=current.find(a=>a.id===agentId);
      return send(res,200,{component:await agentsRegistry.register({...agent,status:'DISABLED'})});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/constitution') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      // `constitution` keeps the short names it has always returned; `statements`
      // adds the rule each name stands for, which is what the agent is actually
      // given. Additive on purpose — an existing reader keeps working.
      return send(res,200,{constitution:CORE_CONSTITUTION,statements:CONSTITUTION_STATEMENTS});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/mcp/endpoints') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{endpoint:redactEndpoint(await mcp.register(await body(req, config.maxBodyBytes)))});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/endpoints') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{endpoints:(await mcp.list()).map(redactEndpoint)});
    }
    if (req.method==='DELETE' && /^\/v1\/admin\/mcp\/endpoints\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const endpointId=decodeURIComponent(url.pathname.split('/')[5]);
      try { const removed=await mcp.remove(endpointId); return send(res,200,{removed:redactEndpoint(removed)}); }
      catch (error) { return send(res,404,{error:String(error?.message??'mcp_endpoint_not_found')}); }
    }
    if (req.method==='POST' && url.pathname.startsWith('/v1/admin/mcp/endpoints/') && url.pathname.endsWith('/discover')) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const endpointId = url.pathname.split('/')[5];
      const input = await body(req, config.maxBodyBytes);
      const endpoint = await mcp.discover(endpointId);
      let connection = null;
      if (input.runtimeId || input.clientId) connection = await connections.upsert({ ...input, endpointId, sessionId:endpoint.sessionId });
      return send(res,200,{endpoint:redactEndpoint(endpoint),connection});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/mcp/permissions') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,201,{permission:await permissions.grant(await body(req, config.maxBodyBytes))});
    }
    if (req.method==='DELETE' && url.pathname==='/v1/admin/mcp/permissions') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input=await body(req, config.maxBodyBytes);
      return send(res,200,{revoked:await permissions.revoke(input.applicationId,input.qualifiedName)});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/permissions') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{permissions:await permissions.list()});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/connections') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{connections:await connections.list()});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/mcp/connections') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{connection:await connections.upsert(await body(req, config.maxBodyBytes))});
    }
    if (req.method==='POST' && url.pathname==='/v1/admin/mcp/reconcile') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,await reconciliation.reconcile());
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/incomplete') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{incomplete:await reconciliation.findIncomplete()});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/audit') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{events:await mcpAudit.list(url.searchParams.get('limit'))});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/tools') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,{tools:await mcp.tools()});
    }
    // Inbound MCP authentication policy. The env var sets the default; an admin
    // override persisted in `mcp-settings` wins, so authentication can be turned
    // off from the console without editing .env or restarting.
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/auth') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const policy=await mcpServerAuth.policy();
      const autoApp=policy.requireAuth===false ? await mcpServerAuth.autoProvisionedApplication() : null;
      const autoAppView=autoApp?{id:autoApp.id,name:autoApp.name,createdAt:autoApp.createdAt,autoProvisioned:true}:null;
      return send(res,200,{
        requireAuth:policy.requireAuth,
        source:policy.source,
        envRequireAuth:policy.envRequireAuth,
        updatedAt:policy.updatedAt,
        serverEnabled:config.mcpServerEnabled===true,
        application:autoAppView,
        // `localApplication` is the field name an earlier release returned; it is kept
        // so an already-installed client keeps reading the same payload.
        localApplication:autoAppView,
        note:policy.requireAuth
          ?'POST /mcp requires a valid application key (Authorization: Bearer zc_...).'
          :'POST /mcp accepts unauthenticated calls; they are signed in as the auto-provisioned application.'
      });
    }
    if (req.method==='PATCH' && url.pathname==='/v1/admin/mcp/auth') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      let input;
      try { input=await body(req, config.maxBodyBytes); }
      catch (error) { return send(res,Number(error?.statusCode)||400,{error:'invalid_body'}); }
      if (typeof input?.requireAuth!=='boolean') return send(res,400,{error:'requireAuth_must_be_boolean'});
      const policy=await mcpServerAuth.setRequireAuth(input.requireAuth);
      const autoApp=policy.requireAuth===false ? await mcpServerAuth.autoProvisionedApplication() : null;
      const autoAppView=autoApp?{id:autoApp.id,name:autoApp.name}:null;
      await requestLog.info('mcp.server.auth_policy_changed',{requireAuth:policy.requireAuth,source:policy.source});
      return send(res,200,{requireAuth:policy.requireAuth,source:policy.source,envRequireAuth:policy.envRequireAuth,application:autoAppView,localApplication:autoAppView});
    }
    if (req.method==='DELETE' && url.pathname==='/v1/admin/mcp/auth') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const policy=await mcpServerAuth.clearOverride();
      await requestLog.info('mcp.server.auth_policy_reset',{requireAuth:policy.requireAuth,source:policy.source});
      return send(res,200,{requireAuth:policy.requireAuth,source:policy.source,envRequireAuth:policy.envRequireAuth});
    }
    // Inbound MCP server: what it advertises and who is connected to it.
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/server') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const enabled=config.mcpServerEnabled===true;
      const clients=await mcpClients.list();
      const authPolicy=await mcpServerAuth.policy();
      return send(res,200,{
        enabled,
        requireAuth:authPolicy.requireAuth,
        authSource:authPolicy.source,
        url:enabled?`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host||`localhost:${config.port}`}/mcp`:null,
        name:MCP_SERVER_NAME,
        protocolVersion:LATEST_MCP_PROTOCOL_VERSION,
        supportedProtocolVersions:MCP_PROTOCOL_VERSIONS,
        tools:enabled?mcpServerToolCatalog(await toolsRegistry.list()).map(t=>({name:t.name,description:t.description})):[],
        clients:{total:clients.length,active:clients.filter(c=>c.active).length},
        idleMs:Number(process.env.MCP_CLIENT_IDLE_MS ?? 120000)
      });
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/mcp/clients') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const clients=await mcpClients.list();
      return send(res,200,{clients,active:clients.filter(c=>c.active).length,total:clients.length,idleMs:Number(process.env.MCP_CLIENT_IDLE_MS ?? 120000)});
    }
    if (req.method==='DELETE' && /^\/v1\/admin\/mcp\/clients\/[^/]+$/.test(url.pathname)) {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const closed=await mcpClients.close(decodeURIComponent(url.pathname.split('/')[5]));
      if (!closed) return send(res,404,{error:'mcp_client_not_found'});
      return send(res,200,{client:closed});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/providers/models') {
      if (!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      const input = Object.fromEntries(url.searchParams.entries());
      if (!input.provider) return send(res,400,{error:'provider_required'});
      const provider = await providers.resolve(String(input.provider));
      return send(res,200,{providerId:input.provider,models:await provider.listModels()});
    }
    if (req.method==='POST' && url.pathname==='/v1/mcp/tools/call') {
      if (config.executionMode !== 'tools-enabled') return send(res,503,{error:'tool_execution_not_verified',executionMode:config.executionMode,required:'tools-enabled',message:'Tool execution is disabled until the deployment verification loop passes.'});
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req, config.maxBodyBytes);
      const requestId=String(input.requestId || id('req'));
      const qualifiedName=String(input.qualifiedName ?? '');
      if (!qualifiedName) return send(res,400,{error:'qualified_tool_required'});
      let release;
      try { release=limits.acquire(app.id,app); } catch(e) { const code=String(e?.message ?? 'application_limit'); return send(res,429,{error:code==='application_rate_limited'||code==='application_concurrency_limited'?code:'application_limit'}); }
      const allowed=await permissions.allowed(app.id,qualifiedName);
      if (!allowed) { release();
        await mcpAudit.append({requestId,applicationId:app.id,qualifiedName,action:'tool_call',stage:'permission',outcome:'denied'});
        return send(res,403,{error:'mcp_tool_not_permitted',qualifiedName,requestId});
      }
      let endpoint;
      try {
        const resolved=await mcp.resolveTool(qualifiedName); endpoint=resolved.endpoint; const tool=resolved.tool;
        validateToolArguments(tool,input.arguments ?? {});
        const connection=await connections.resolve({connectionId:input.connectionId,sessionId:input.sessionId,runtimeId:input.runtimeId,clientId:input.clientId});
        const sessionId=connection?.sessionId || input.sessionId || endpoint.sessionId;
        await mcpAudit.append({requestId,applicationId:app.id,endpointId:endpoint.id,qualifiedName,action:'tool_call',stage:'request',outcome:'started',connectionId:connection?.connectionId??null,sessionId:sessionId??null});
        const result=await callMcpTool(endpoint,tool.name,input.arguments ?? {},{sessionId});
        if(connection) await connections.touch(connection.connectionId,{sessionId});
        await mcpAudit.append({requestId,applicationId:app.id,endpointId:endpoint.id,qualifiedName,action:'tool_call',stage:'result',outcome:'success',connectionId:connection?.connectionId??null,sessionId:sessionId??null});
        release(); return send(res,200,{result,applicationId:app.id,endpointId:endpoint.id,qualifiedName,requestId,connectionId:connection?.connectionId??null,sessionId:sessionId??null});
      } catch (e) {
        await mcpAudit.append({requestId,applicationId:app.id,endpointId:endpoint?.id,qualifiedName,action:'tool_call',stage:'result',outcome:'error',error:e.message,remoteCode:e.remoteCode??null,remoteMessage:e.remoteMessage??null});
        release(); throw e;
      }
    }
    if (req.method==='POST' && url.pathname==='/v1/execution/prepare') {
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input = await applyAgentModelMapping(await body(req, config.maxBodyBytes));
      const taskPolicy = buildTaskPolicy(input);
      return send(res,200,{applicationId:app.id, taskPolicy, ...await execution.prepare({...input, toolIds:taskPolicy.effectiveToolIds})});
    }
    if (req.method==='POST' && url.pathname==='/v1/execution/run') {
      if (config.executionMode !== 'tools-enabled') return send(res,503,{error:'tool_execution_not_verified',executionMode:config.executionMode,required:'tools-enabled',message:'Execution is disabled until the deployment verification loop passes.'});
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      let input=await applyAgentModelMapping(await body(req, config.maxBodyBytes));
      const taskPolicy=buildTaskPolicy(input);
      input={...input,toolIds:taskPolicy.effectiveToolIds,allowedToolIds:taskPolicy.effectiveToolIds};
      const registeredNativeTools=(await toolsRegistry.list()).filter(t=>input.toolIds.includes(t.id)&&t.entry&&['ENABLED','VERIFIED'].includes(t.status));
      const generatedToolBindings=Object.fromEntries(registeredNativeTools.map(t=>[t.id,{toolId:t.id}]));
      // Discovered external MCP tools join the same surface here as in the chat tool
      // loop, so an execution run can reach a remote tool the same way.
      const externalSurface=buildExternalToolSurface({endpoints:await mcp.list(),allowedEndpointIds:boundaryEndpointIds(String(input.agent ?? input.persona ?? 'code-guru')),maxTools:config.externalToolSurfaceMax});
      input={...input,tools:[...registeredNativeTools.map(t=>({type:'function',function:{name:t.id,description:t.description??t.name,parameters:t.metadata?.toolSchema??{type:'object',properties:{}}}})),...externalSurface.definitions],toolBindings:{...(input.toolBindings??{}),...generatedToolBindings,...externalSurface.bindings},allowedToolIds:[...(Array.isArray(input.allowedToolIds)?input.allowedToolIds:[]),...externalSurface.entries.map(e=>e.qualifiedName)],allowJsonToolFallback:true};
      const session=input.sessionId ? await sessionClient.resolve({sessionId:input.sessionId,applicationId:app.id}) : (input.createSession ? await sessionClient.resolve({applicationId:app.id,createIfMissing:true,userId:input.userId}) : null);
      const executionMetadata={sessionSource:input.sessionSource ?? req.headers['x-session-source'] ?? 'execution',clientId:input.clientId ?? req.headers['x-client-id'] ?? null,editor:input.editor ?? req.headers['x-editor'] ?? null,editorVersion:input.editorVersion ?? req.headers['x-editor-version'] ?? null,clientVersion:input.clientVersion ?? req.headers['x-client-version'] ?? null,osPlatform:input.osPlatform ?? req.headers['x-os-platform'] ?? null,deviceInfo:input.deviceInfo ?? req.headers['x-device-info'] ?? null};
      if(session) await sessions.updateMetadata(session.id,app.id,Object.fromEntries(Object.entries(executionMetadata).filter(([,v])=>v != null && String(v).trim())));
      const currentSession=session ? await sessions.get(session.id,app.id) : null;
      const executionEvidence=currentSession ? (await store.read('evidence',[])).filter(item=>item.contextId===currentSession.id).slice(-8) : [];
      // The agent's persisted access scope supplies both the tool surface and the
      // project root, so a working-directory agent is pinned before anything reads
      // project state and a global agent may name any existing root.
      const executionAgentId=String(input.agent ?? input.persona ?? 'code-guru');
      const executionScope=await resolveAgentScope(executionAgentId,{requestedRoot:input.projectRoot,requestedWorkingDirectory:input.workingDirectory});
      const executionProjectRoot=executionScope.projectRoot;
      if(executionProjectRoot) await autoSetup.ensure(executionProjectRoot);
      const executionProject=executionProjectRoot ? await ssot.read(executionProjectRoot) : null;
      const executionMemory=executionProjectRoot ? await memory.recent(executionProjectRoot,10) : [];
      const executionSyllabus=executionProjectRoot ? await syllabus.read(executionProjectRoot) : null;
      const executionGoal=String(input.goal ?? 'execution');
      const executionAgent=await agentRunner.prepare({agentId:executionAgentId,personaId:executionAgentId,goal:executionGoal,expectedOutcome:input.expectedOutcome,tools:input.toolIds});
      const executionRoute=await smartRouter.route(input);
      const executionCompiledContext=compileContext({goal:executionGoal,userInput:input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content ?? executionGoal,recent:input.messages ?? [],memory:executionMemory ?? [],ssot:executionProject,syllabus:executionSyllabus,projectRoot:executionProjectRoot,workingDirectory:input.workingDirectory ?? executionProjectRoot,sessionId:currentSession?.id ?? input.sessionId ?? null,taskPolicy,evidence:executionEvidence,maxBytes:config.compiledContextBytes,recentLimit:config.contextRecentMessages});
      const executionSystem=buildSystemMessage({constitution:CORE_CONSTITUTION,agent:executionAgent.agent,persona:executionAgent.persona,goal:executionGoal,expectedOutcome:input.expectedOutcome,projectRoot:executionProjectRoot,ssot:executionProject,syllabus:executionSyllabus,memory:executionMemory,session:currentSession,route:executionRoute,tools:input.toolIds,toolCatalog:registeredNativeTools,compiledContext:executionCompiledContext});
      const executionArchive=session ? await sessionState.archive(session.id,app.id) : [];
      const boundedExecution=boundedConversation(input.messages,[...(executionMemory ?? [])],executionArchive,executionGoal);
      const incomingMessages=boundedExecution.messages.length ? boundedExecution.messages : [{role:'user',content:executionGoal}];
      input={...input,messages:[executionSystem,...incomingMessages],sessionId:currentSession?.id ?? input.sessionId};
      const prepared=await execution.prepare(input);
      const executionContext=createExecutionContext({...input,applicationId:app.id,sessionId:session?.id ?? input.sessionId,requestId,projectRoot:executionScope.workspaceRoot,workingDirectory:input.workingDirectory ?? executionScope.workspaceRoot,allowAnyPath:executionScope.access.allowAnyRoot,allowAnyCommand:executionScope.access.allowAnyRoot,agentId:executionAgentId,goal:executionGoal,expectedOutcome:input.expectedOutcome,transport:'http'},runtimeIdentity);
      const result=await execution.execute(prepared,{...input,sessionId:session?.id ?? input.sessionId,requestId,workingDirectory:executionContext.workingDirectory,applicationId:app.id},app.id,executionContext);
      requestState.outcome = result?.status === 'completed' && result?.verified === true ? 'verified' : (result?.status ?? 'completed');
      requestState.agentId=executionAgent.agent?.id ?? executionAgentId;
      await recordAgentRun(requestState.agentId, result?.status==='completed'?'success':'incomplete', {latencyMs:Date.now()-startedAt, model:result?.model ?? null, providerId:result?.providerId ?? null, path:'execution'});
      await requestLog.info('execution.completed', {applicationId:app.id,agentId:input.agent ?? input.persona ?? 'code-guru',personaId:input.persona ?? input.agent ?? 'code-guru',providerId:result?.providerId ?? null,model:result?.model ?? null,status:result?.status ?? null,stoppedReason:result?.stoppedReason ?? null,verified:result?.verified ?? false});
      const evidence=Array.isArray(result?.evidence)?result.evidence:[];
      // Evidence from an adapter must never be able to fail a request whose work
      // has already executed. A malformed item degrades to "awaiting
      // verification" and is logged instead of turning a completed tool run into
      // an opaque 400.
      const evidenceState=[];
      for (const item of evidence) {
        try { evidenceState.push(...evidenceGate.validate([item])); }
        catch (error) { await requestLog.warn('execution.evidence.invalid',{applicationId:app.id,reason:String(error?.message??error)}); }
      }
      const verified=evidenceGate.canClaimSuccess(evidenceState);
      const safeResult={...result,verified};
      if (!verified) { safeResult.response=null; safeResult.status='awaiting_verification'; }
      // Public projection: the run result is internal routing/execution state. A client
      // only ever sees the masked provider identity, a masked route summary and masked
      // evidence sources; the real upstream ids stay in the runtime log.
      const publicModel=safeResult.route?.publicModel ?? safeResult.identity?.model ?? executionRoute?.publicModel ?? null;
      const publicResult={...safeResult,
        providerId:'masked',
        model:publicModel,
        route:maskRouteForPublic(safeResult.route,{publicModel}),
        evidence:maskEvidenceForPublic(safeResult.evidence),
        verification:safeResult.verification ? {...safeResult.verification,evidence:maskEvidenceForPublic(safeResult.verification.evidence)} : safeResult.verification
      };
      if (input.projectRoot) {
        await autoSetup.ensure(input.projectRoot);
        await syllabus.append(input.projectRoot,{topic:String(input.goal ?? 'execution').slice(0,120),source:'runtime.phase-22',summary:verified?'Execution produced verified evidence':'Execution observed a provider/tool result but verification evidence is still required',status:verified?'verified':'unverified',evidence:evidence.map(x=>x.summary ?? x.source).join('; ')});
      }
      return send(res,200,{applicationId:app.id,session,taskPolicy,prepared,result:publicResult,evidence:maskEvidenceForPublic(evidenceState),verified});
    }
    if (req.method==='POST' && url.pathname==='/v1/execution/stream') {
      if (config.executionMode !== 'tools-enabled') return send(res,503,{error:'tool_execution_not_verified',executionMode:config.executionMode,required:'tools-enabled',message:'Execution is disabled until the deployment verification loop passes.'});
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      let input=await applyAgentModelMapping(await body(req, config.maxBodyBytes));
      const taskPolicy=buildTaskPolicy(input);
      input={...input,stream:true,toolIds:taskPolicy.effectiveToolIds,allowedToolIds:taskPolicy.effectiveToolIds};
      const registeredNativeTools=(await toolsRegistry.list()).filter(t=>input.toolIds.includes(t.id)&&t.entry&&['ENABLED','VERIFIED'].includes(t.status));
      const generatedToolBindings=Object.fromEntries(registeredNativeTools.map(t=>[t.id,{toolId:t.id}]));
      // Discovered external MCP tools join the same surface here as in the chat tool
      // loop, so an execution run can reach a remote tool the same way.
      const externalSurface=buildExternalToolSurface({endpoints:await mcp.list(),allowedEndpointIds:boundaryEndpointIds(String(input.agent ?? input.persona ?? 'code-guru')),maxTools:config.externalToolSurfaceMax});
      input={...input,tools:[...registeredNativeTools.map(t=>({type:'function',function:{name:t.id,description:t.description??t.name,parameters:t.metadata?.toolSchema??{type:'object',properties:{}}}})),...externalSurface.definitions],toolBindings:{...(input.toolBindings??{}),...generatedToolBindings,...externalSurface.bindings},allowedToolIds:[...(Array.isArray(input.allowedToolIds)?input.allowedToolIds:[]),...externalSurface.entries.map(e=>e.qualifiedName)],allowJsonToolFallback:true};
      const session=input.sessionId ? await sessionClient.resolve({sessionId:input.sessionId,applicationId:app.id}) : (input.createSession ? await sessionClient.resolve({applicationId:app.id,createIfMissing:true,userId:input.userId}) : null);
      const streamMetadata={sessionSource:input.sessionSource ?? req.headers['x-session-source'] ?? 'execution-stream',clientId:input.clientId ?? req.headers['x-client-id'] ?? null,editor:input.editor ?? req.headers['x-editor'] ?? null,editorVersion:input.editorVersion ?? req.headers['x-editor-version'] ?? null,clientVersion:input.clientVersion ?? req.headers['x-client-version'] ?? null,osPlatform:input.osPlatform ?? req.headers['x-os-platform'] ?? null,deviceInfo:input.deviceInfo ?? req.headers['x-device-info'] ?? null};
      if(session) await sessions.updateMetadata(session.id,app.id,Object.fromEntries(Object.entries(streamMetadata).filter(([,v])=>v != null && String(v).trim())));
      const currentSession=session ? await sessions.get(session.id,app.id) : null;
      const streamAgentId=String(input.agent ?? input.persona ?? 'code-guru');
      const executionStreamScope=await resolveAgentScope(streamAgentId,{requestedRoot:input.projectRoot,requestedWorkingDirectory:input.workingDirectory});
      const streamProjectRoot=executionStreamScope.projectRoot;
      if(streamProjectRoot) await autoSetup.ensure(streamProjectRoot);
      const streamProject=streamProjectRoot ? await ssot.read(streamProjectRoot) : null;
      const streamMemory=streamProjectRoot ? await memory.recent(streamProjectRoot,10) : [];
      const streamSyllabus=streamProjectRoot ? await syllabus.read(streamProjectRoot) : null;
      const streamEvidence=session ? (await store.read('evidence',[])).filter(item=>item.contextId===session.id).slice(-8) : [];
      const streamGoal=String(input.goal ?? 'execution stream');
      const streamAgent=await agentRunner.prepare({agentId:streamAgentId,personaId:streamAgentId,goal:streamGoal,expectedOutcome:input.expectedOutcome,tools:input.toolIds});
      const streamRoute=await smartRouter.route(input);
      const streamCompiledContext=compileContext({goal:streamGoal,userInput:input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content ?? streamGoal,recent:input.messages ?? [],memory:streamMemory ?? [],ssot:streamProject,syllabus:streamSyllabus,projectRoot:streamProjectRoot,workingDirectory:input.workingDirectory ?? streamProjectRoot,sessionId:currentSession?.id ?? input.sessionId ?? null,taskPolicy,evidence:streamEvidence,maxBytes:config.compiledContextBytes,recentLimit:config.contextRecentMessages});
      const streamSystem=buildSystemMessage({constitution:CORE_CONSTITUTION,agent:streamAgent.agent,persona:streamAgent.persona,goal:streamGoal,expectedOutcome:input.expectedOutcome,projectRoot:streamProjectRoot,ssot:streamProject,syllabus:streamSyllabus,memory:streamMemory,session:currentSession,route:streamRoute,tools:input.toolIds,toolCatalog:registeredNativeTools});
      const streamArchive=session ? await sessionState.archive(session.id,app.id) : [];
      const boundedStream=boundedConversation(input.messages,[...(streamMemory ?? [])],streamArchive,streamGoal);
      const streamMessages=boundedStream.messages.length ? boundedStream.messages : [{role:'user',content:streamGoal}];
      input={...input,messages:[streamSystem,...streamMessages],sessionId:currentSession?.id ?? input.sessionId};
      const prepared=await execution.prepare(input);
      if (!prepared.consent.allowed) return send(res,409,{error:'execution_consent_required',prepared});
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive'});
      const streamExecutionContext=createExecutionContext({...input,applicationId:app.id,sessionId:session?.id ?? input.sessionId,requestId,projectRoot:executionStreamScope.workspaceRoot,workingDirectory:input.workingDirectory ?? executionStreamScope.workspaceRoot,allowAnyPath:executionStreamScope.access.allowAnyRoot,allowAnyCommand:executionStreamScope.access.allowAnyRoot,agentId:streamAgentId,goal:streamGoal,expectedOutcome:input.expectedOutcome,transport:'http-stream'},runtimeIdentity);
      const streamInput={...input,sessionId:session?.id ?? input.sessionId,executionContext:streamExecutionContext};
      if (input.autoToolLoop === true && config.executionMode !== 'tools-enabled') {
        res.write(`event: error\ndata: ${JSON.stringify({error:'tool_execution_not_verified',executionMode:config.executionMode,requestId})}\n\n`); res.end(); return;
      }
      if (input.autoToolLoop === true) {
        const result=await toolLoop.stream({prepared,input:streamInput,applicationId:app.id,onChunk:chunk=>res.write(`data: ${JSON.stringify(chunk)}\n\n`),onEvent:event=>res.write(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`)});
        res.write(`event: runtime\ndata: ${JSON.stringify({type:'complete',status:result.status,stoppedReason:result.stoppedReason,verified:result.verified})}\n\n`);
      } else {
        await providerExecution.stream({prepared,input:streamInput,onChunk:chunk=>res.write(`data: ${JSON.stringify(chunk)}\n\n`)});
      }
      res.write('data: [DONE]\n\n'); res.end(); return;
    }
    if (req.method==='POST' && url.pathname==='/v1/chat/completions') {
      let input=await body(req, config.maxBodyBytes);
      // OpenAI requires a non-empty `messages` array. The runtime also accepts a
      // `goal`-only call — that is how the chat page and /v1/execution/run drive a
      // tool loop — so the rule is "at least one of the two". A request with
      // neither used to be answered with a completion about the literal string
      // "chat request", which hides a client bug instead of reporting it.
      const hasMessages=Array.isArray(input.messages)&&input.messages.length>0;
      const hasGoal=String(input.goal??'').trim().length>0;
      if(!hasMessages&&!hasGoal) return send(res,400,{error:'messages_required',param:'messages'});
      if (input.autoToolLoop === true && config.executionMode !== 'tools-enabled') return send(res,503,{error:'tool_execution_not_verified',executionMode:config.executionMode,required:'tools-enabled'});
      const app=await authenticateRequest(req, requestLog, requestState);
      if (!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      input=await applyAgentModelMapping(input);
      const requestedChatTools=Array.isArray(input.toolIds)?input.toolIds.map(String):(Array.isArray(input.tools)?input.tools.map(t=>String(t?.function?.name??t?.name??'')).filter(Boolean):[]);
      const chatGoal=String(input.goal??input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content??'chat request');
      const taskPolicy=buildTaskPolicy({...input,goal:chatGoal,toolIds:requestedChatTools});
      input={...input,goal:chatGoal,toolIds:taskPolicy.effectiveToolIds,allowedToolIds:taskPolicy.effectiveToolIds};
      if (input.autoToolLoop === true) {
        if (config.executionMode !== 'tools-enabled') return send(res,503,{error:'tool_execution_not_verified',executionMode:config.executionMode,required:'tools-enabled'});
        // An agent's persisted access scope decides both the tool surface and the
        // project root. The scope is "all" tools, so the default surface is the whole
        // runnable registry.
        const agentId=String(input.agent??input.persona??'code-guru');
        requestState.agentId=agentId;
        const agentScope=await resolveAgentScope(agentId,{requestedRoot:input.projectRoot,requestedWorkingDirectory:input.workingDirectory});
        // A request that names tools narrows the surface for that request; it does not
        // restrict the agent. Sending the whole registry for a one-tool task costs
        // ~2000 tokens on every round, which both distracts the model and, on its own,
        // can exceed a small provider's per-minute budget (a free tier can be 7000
        // input tokens per minute). A request that names no tools still gets the full
        // surface, so "unrestricted by default" is unchanged.
        const fullSurface=agentScope.access.toolSurface==='all'?await runnableToolIds():input.toolIds;
        // `fullSurface` is what the agent is *allowed* to use. Offer only the part of it
        // this request has a reason to use: a tool loop used to send all 25 definitions
        // (~1,900 tokens) on every round, which distracts the model and on its own can
        // exceed a free tier's per-minute input budget. A request that names tools keeps
        // its own narrowing, and `toolSurface:'full'` opts out entirely.
        const surfaceSelection=requestedChatTools.length||input.toolSurface==='full'
          ? null
          : selectToolSurface({
              text:selectionText({goal:chatGoal,expectedOutcome:input.expectedOutcome,messages:input.messages}),
              availableToolIds:fullSurface,
              requestedToolIds:Array.isArray(input.toolIds)?input.toolIds.map(String):[],
              profileToolIds:taskPolicy.allowedToolHints??[],
              mode:config.toolSurfaceMode,
              maxTools:config.toolSurfaceMax
            });
        const agentToolIds=requestedChatTools.length?fullSurface.filter(id=>requestedChatTools.includes(id)):(surfaceSelection?.toolIds??fullSurface);
        input={...input,toolIds:agentToolIds,allowedToolIds:agentToolIds};
        if(surfaceSelection) await requestLog.debug('tool.surface.selected',{agentId,offered:surfaceSelection.toolIds.length,allowed:fullSurface.length,mode:surfaceSelection.mode,groups:surfaceSelection.groups,reason:surfaceSelection.reason,dropped:surfaceSelection.dropped});
        // The persisted scope, not the task-policy profile, decided this surface, so
        // the reported policy must not claim a tool was denied while the run offers it.
        const reportedTaskPolicy=agentScope.access.toolSurface==='all'
          ? {...taskPolicy,toolSurfaceMinimal:false,effectiveToolIds:agentToolIds,deniedRequestedTools:[]}
          : taskPolicy;
        const runnableFrom=async(ids)=>(await toolsRegistry.list()).filter(t=>ids.includes(t.id)&&t.entry&&['ENABLED','VERIFIED'].includes(t.status));
        let registeredNativeTools=await runnableFrom(input.toolIds);
        // A narrowed offer that happens to contain only disabled tools must not turn a
        // request that used to work into a 400. Narrowing is an optimisation; the full
        // allowed surface stays the floor.
        if(!registeredNativeTools.length&&surfaceSelection){
          await requestLog.warn('tool.surface.fallback_full',{agentId,offered:input.toolIds.length,reason:'no_runnable_tool_in_narrowed_surface'});
          input={...input,toolIds:fullSurface,allowedToolIds:fullSurface};
          registeredNativeTools=await runnableFrom(fullSurface);
        }
        // Discovered external MCP tools join the same surface. The tool loop already
        // routes a `{qualifiedName, executionTarget:'mcp'}` binding to the MCP adapter
        // (`bindingFor()`); what was missing was offering those bindings at all. An
        // agent that declares an external-MCP boundary only sees those endpoints;
        // every other agent sees the whole discovered set, capped by
        // EXTERNAL_TOOL_SURFACE_MAX so one endpoint cannot dominate the surface.
        const externalSurface=buildExternalToolSurface({
          endpoints:await mcp.list(),
          allowedEndpointIds:boundaryEndpointIds(agentId),
          maxTools:config.externalToolSurfaceMax
        });
        if (!registeredNativeTools.length && !externalSurface.definitions.length) return send(res,400,{error:'no_registered_tool_allowed_for_task',taskProfile:taskPolicy.profileId,requestedToolIds:requestedChatTools});
        const externalCatalog=externalSurface.entries.map(e=>({id:e.qualifiedName,name:e.name,description:`External MCP tool on endpoint ${e.endpointId}`,status:'DISCOVERED'}));
        const toolDefinitions=[...registeredNativeTools.map(t=>({type:'function',function:{name:t.id,description:t.description??t.name,parameters:t.metadata?.toolSchema??{type:'object',properties:{}}}})),...externalSurface.definitions];
        const toolBindings={...(input.toolBindings??{}),...Object.fromEntries(registeredNativeTools.map(t=>[t.id,{toolId:t.id}])),...externalSurface.bindings};
        // The loop enforces `allowedToolIds` against the binding target, and an external
        // tool's target is its qualified name.
        if (externalSurface.entries.length) input={...input,allowedToolIds:[...(Array.isArray(input.allowedToolIds)?input.allowedToolIds:[]),...externalSurface.entries.map(e=>e.qualifiedName)]};
        const projectRoot=agentScope.projectRoot;
        // The tool loop is the path that actually works on a project, so it must carry
        // the same compiled project context as plain chat. Without this the agent was
        // told "SSOT: unavailable" even when SSOT.md existed — the one path where the
        // project facts matter most was the one path that never loaded them.
        if (projectRoot) await autoSetup.ensure(projectRoot);
        const toolLoopProject=projectRoot?await ssot.read(projectRoot):null;
        const toolLoopMemory=projectRoot?await memory.recent(projectRoot,10):null;
        const toolLoopSyllabus=projectRoot?await syllabus.read(projectRoot):null;
        const toolLoopUserMessage=String(input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content??chatGoal);
        const toolLoopCompiledContext=compileContext({goal:chatGoal,userInput:toolLoopUserMessage,recent:Array.isArray(input.messages)?input.messages:[],memory:toolLoopMemory??[],ssot:toolLoopProject,syllabus:toolLoopSyllabus,projectRoot,workingDirectory:input.workingDirectory??projectRoot,sessionId:input.sessionId??null,taskPolicy:reportedTaskPolicy,maxBytes:config.compiledContextBytes,recentLimit:config.contextRecentMessages});
        const agentPrepared=await agentRunner.prepare({agentId,personaId:agentId,goal:chatGoal,expectedOutcome:input.expectedOutcome,tools:input.toolIds});
        requestState.agentId=agentPrepared.agent?.id ?? agentId;
        const route=await smartRouter.route({...input,tools:toolDefinitions,allowJsonToolFallback:true});
        const systemMessage=buildSystemMessage({constitution:CORE_CONSTITUTION,agent:agentPrepared.agent,persona:agentPrepared.persona,goal:chatGoal,expectedOutcome:input.expectedOutcome,projectRoot,ssot:toolLoopProject,syllabus:toolLoopSyllabus,memory:toolLoopMemory,route,tools:[...input.toolIds,...externalSurface.entries.map(e=>e.name)],toolCatalog:[...registeredNativeTools,...externalCatalog],compiledContext:toolLoopCompiledContext});
        const prepared=await execution.prepare({...input,goal:chatGoal,toolIds:input.toolIds,allowedToolIds:input.allowedToolIds,consent:input.consent===true});
        if (!prepared.consent.allowed) return send(res,409,{error:'execution_consent_required',prepared});
        const executionContext=createExecutionContext({...input,applicationId:app.id,sessionId:input.sessionId ?? null,requestId,projectRoot:agentScope.workspaceRoot,workingDirectory:input.workingDirectory??agentScope.workspaceRoot,allowAnyPath:agentScope.access.allowAnyRoot,allowAnyCommand:agentScope.access.allowAnyRoot,agentId,goal:chatGoal,expectedOutcome:input.expectedOutcome,transport:'http-chat'},runtimeIdentity);
        const loopInput={...input,tools:toolDefinitions,toolBindings,allowJsonToolFallback:true,executionContext,messages:[systemMessage,...(Array.isArray(input.messages)?input.messages:[])],stream:input.stream===true};
        if (input.stream===true) {
          res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
          // The status line is already on the wire, so a failure here cannot become an
          // HTTP error status: it has to be delivered as a stream event and the response
          // must always end, otherwise the client stays blocked on an open connection
          // until its own timeout fires (the provider detail stays in the logs).
          try {
            const result=await toolLoop.stream({prepared,input:loopInput,applicationId:app.id,onChunk:chunk=>res.write(`data: ${JSON.stringify(chunk)}\n\n`),onEvent:event=>res.write(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`)});
            await recordAgentRun(agentPrepared.agent?.id ?? agentId, result.status==='completed'?'success':'incomplete', {latencyMs:Date.now()-startedAt, model:result.response?.model ?? null, providerId:route.providerId ?? null, path:'stream'});
            res.write(`event: runtime\ndata: ${JSON.stringify({type:'complete',status:result.status,stoppedReason:result.stoppedReason,roundCount:result.rounds.length,evidenceCount:result.evidence.length,agentId,model:result.response?.model ?? route.publicModel ?? null,providerId:'masked',verified:result.verified})}\n\n`);
            res.write('data: [DONE]\n\n');
          } catch (error) {
            await recordAgentRun(agentPrepared.agent?.id ?? agentId, 'failure', {latencyMs:Date.now()-startedAt, providerId:route.providerId ?? null, path:'stream'});
            await requestLog.warn('tool_loop.stream_failed',{agentId,error:String(error?.message ?? error),...providerErrorDetail(error)});
            // A mid-stream 429 carries the same instruction as an HTTP 429: wait,
            // then retry. The status line is already on the wire, so it can only be
            // delivered as an event — and it must stay distinguishable from a real
            // stream failure, otherwise the client cannot tell "retry" from "give up".
            const streamRateLimited = String(error?.message ?? '') === 'provider_http_error' && Number(error?.statusCode) === 429;
            const streamRetryAfterMs = streamRateLimited ? retryAfterMsFrom(error?.providerHeaders) : null;
            res.write(`event: error\ndata: ${JSON.stringify({error: streamRateLimited ? 'provider_rate_limited' : 'stream_failed', requestId, ...(streamRateLimited ? {retryable:true, ...(streamRetryAfterMs !== null ? {retryAfterMs:streamRetryAfterMs} : {})} : {})})}\n\n`);
          } finally { res.end(); }
          return;
        }
        const result=await toolLoop.execute({prepared,input:loopInput,applicationId:app.id});
        await recordAgentRun(agentPrepared.agent?.id ?? agentId, result.status==='completed'?'success':'incomplete', {latencyMs:Date.now()-startedAt, model:result.response?.model ?? null, providerId:route.providerId ?? null, path:'tool-loop'});
        requestState.outcome=result.status==='completed'?'observed_unverified':'incomplete';
        // The tool loop must expose the same provenance as the plain chat path, so a
        // client can tell which agent answered and what evidence was observed. The
        // public surface stays masked (providerId/provider.id = 'masked'); the real
        // provider and upstream model live only in the runtime log (tool_loop.started,
        // tool.execution.*).
        const toolLoopPublicModel=result.response?.model ?? route.publicModel ?? null;
        const toolLoopRoute={routeId:route.routeId,providerId:'masked',model:route.publicModel || toolLoopPublicModel,publicModel:route.publicModel || toolLoopPublicModel,requiredCapabilities:route.requiredCapabilities,candidateCount:route.candidates.length,reason:route.reason,status:route.status};
        return send(res,200,{...(result.response??{choices:[{index:0,message:{role:'assistant',content:null},finish_reason:'tool_calls'}]}),applicationId:app.id,meta:{runtime:'ZombieCoder',phase:RUNTIME_PHASE,executionMode:config.executionMode,route:toolLoopRoute,provider:{name:'ZombieCoder',id:'masked'},model:toolLoopPublicModel,agent:agentPrepared.agent,persona:agentPrepared.persona,agentAccess:agentScope.access,toolSurface:{count:registeredNativeTools.length,toolIds:registeredNativeTools.map(t=>t.id),allowedCount:fullSurface.length,mode:surfaceSelection?.mode??'full',reason:surfaceSelection?.reason??(requestedChatTools.length?'request_named_tools':'full_surface'),groups:surfaceSelection?.groups??[],dropped:surfaceSelection?.dropped??[],external:{count:externalSurface.entries.length,endpoints:externalSurface.endpointIds,tools:externalSurface.entries.map(e=>e.qualifiedName),dropped:externalSurface.dropped}},evidence:maskEvidenceForPublic(result.evidence),verified:result.verified,verificationRequired:true,toolLoop:{status:result.status,stoppedReason:result.stoppedReason,rounds:result.rounds,roundCount:result.rounds.length,evidenceCount:result.evidence.length,verified:result.verified},taskPolicy:reportedTaskPolicy}});
      }
      if (input.stream === true) {
        const streamContext = await contexts.resolve(input);
        const streamAgentId = String(input.agent ?? input.persona ?? 'code-guru');
        const chatStreamScope=await resolveAgentScope(streamAgentId,{requestedRoot:input.projectRoot,requestedWorkingDirectory:input.workingDirectory});
        const streamProjectRoot = chatStreamScope.projectRoot;
        if (streamProjectRoot) await autoSetup.ensure(streamProjectRoot);
        const streamProject = streamProjectRoot ? await ssot.read(streamProjectRoot) : null;
        const streamMemory = streamProjectRoot ? await memory.recent(streamProjectRoot,10) : null;
        const streamSyllabus = streamProjectRoot ? await syllabus.read(streamProjectRoot) : null;
        const streamGoal = String(input.goal ?? input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content ?? 'chat request');
        const streamAgent = await agentRunner.prepare({agentId:streamAgentId,personaId:streamAgentId,goal:streamGoal,expectedOutcome:input.expectedOutcome,tools:input.toolIds});
        requestState.agentId=streamAgent.agent?.id ?? streamAgentId;
        const streamSession = input.sessionId ? await sessionClient.resolve({sessionId:input.sessionId,applicationId:app.id}) : (input.createSession ? await sessionClient.resolve({applicationId:app.id,createIfMissing:true,userId:input.userId}) : null);
        const streamMetadata = {sessionSource:input.sessionSource ?? req.headers['x-session-source'] ?? 'api-stream',clientId:input.clientId ?? req.headers['x-client-id'] ?? null,editor:input.editor ?? req.headers['x-editor'] ?? null,editorVersion:input.editorVersion ?? req.headers['x-editor-version'] ?? null,clientVersion:input.clientVersion ?? req.headers['x-client-version'] ?? null,osPlatform:input.osPlatform ?? req.headers['x-os-platform'] ?? null,deviceInfo:input.deviceInfo ?? req.headers['x-device-info'] ?? null};
        if (streamSession) await sessions.updateMetadata(streamSession.id,app.id,Object.fromEntries(Object.entries(streamMetadata).filter(([,v])=>v != null && String(v).trim())));
        const currentStreamSession = streamSession ? await sessions.get(streamSession.id,app.id) : null;
        const route = await smartRouter.route(input);
        let providerId = route.providerId;
        let provider = await providers.resolve(providerId);
        let model = await providers.resolveModel(providerId, route.model || input.model);
        const streamArchiveForChat=streamSession ? await sessionState.archive(streamSession.id,app.id) : [];
        const streamEvidence=streamSession ? (await store.read('evidence',[])).filter(item=>item.contextId===streamSession.id).slice(-8) : [];
        const boundedChatStream=boundedConversation(input.messages,streamArchiveForChat,streamArchiveForChat,streamGoal);
        const streamUserMessage=latestUserMessage(input.messages,streamGoal);
        const userMessages = boundedChatStream.messages.length ? boundedChatStream.messages : [streamUserMessage];
        const streamCompiledContext=compileContext({goal:streamGoal,userInput:streamUserMessage.content,recent:userMessages,memory:streamMemory ?? [],ssot:streamProject,syllabus:streamSyllabus,projectRoot:streamProjectRoot,workingDirectory:input.workingDirectory ?? streamProjectRoot,sessionId:currentStreamSession?.id ?? input.sessionId ?? null,taskPolicy,evidence:streamEvidence,maxBytes:config.compiledContextBytes,recentLimit:config.contextRecentMessages});
        const systemMessage = buildSystemMessage({constitution:CORE_CONSTITUTION,agent:streamAgent.agent,persona:streamAgent.persona,goal:streamGoal,expectedOutcome:input.expectedOutcome,projectRoot:streamProjectRoot,ssot:streamProject,syllabus:streamSyllabus,memory:streamMemory,session:currentStreamSession,route,tools:input.toolIds,compiledContext:streamCompiledContext});
        input = {...input,provider:undefined,model,messages:[systemMessage,...userMessages],stream:true,sessionId:currentStreamSession?.id ?? input.sessionId};
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
        let streamText='';
        let streamToolCalls=[];
        let streamChunkCount=0;
        try {
          let streamSucceeded = false;
          let streamLastError = null;
          for (const candidate of route.candidates) {
            const beforeCandidateChunks = streamChunkCount;
            try {
              providerId = candidate.providerId;
              provider = await providers.resolve(providerId);
              model = await providers.resolveModel(providerId, route.publicModel ? candidate.model : (input.model || candidate.model));
              if (typeof provider.streamChat !== 'function') throw new Error('provider_streaming_not_supported');
              await provider.streamChat({...input, model, stream:true}, raw => {
                if (raw?.done === true && !raw?.choices) return;
                const canonicalInput = typeof provider.streamChunk === 'function' ? provider.streamChunk(raw) : raw;
                const chunk = canonicalInput?.choices ? normalizer.normalize(canonicalInput,{model,providerId:provider.id}) : null;
                if (chunk) {
                  streamChunkCount += 1;
                  const masked = maskCanonicalResponse(chunk,{agentId:streamAgent.agent?.id ?? streamAgentId,configuredModel:route.publicModel || '',capabilities:Object.keys(provider.capabilities ?? {}).filter(k=>provider.capabilities[k])});
                  const delta=masked?.choices?.[0]?.delta;
                  if (typeof delta?.content === 'string') streamText += delta.content;
                  if (Array.isArray(delta?.tool_calls)) streamToolCalls.push(...delta.tool_calls);
                  res.write(`data: ${JSON.stringify(masked)}\n\n`);
                }
              });
              if (streamChunkCount === beforeCandidateChunks) {
                // A 200 response without chunks is not a completed answer: retry via non-streaming.
                const fallbackRaw = await provider.chatCompletions({...input, model, stream:false});
                const fallbackInput = typeof provider.toCanonical === 'function' ? provider.toCanonical(fallbackRaw) : fallbackRaw;
                const fallbackCompletion = normalizer.normalize(fallbackInput,{model,providerId:provider.id});
                const fallbackChunk = normalizer.normalize(completionToStreamChunk(fallbackCompletion),{model,providerId:provider.id});
                const maskedFallback = maskCanonicalResponse(fallbackChunk,{agentId:streamAgent.agent?.id ?? streamAgentId,configuredModel:route.publicModel || '',capabilities:Object.keys(provider.capabilities ?? {}).filter(k=>provider.capabilities[k])});
                const delta = maskedFallback?.choices?.[0]?.delta;
                if (typeof delta?.content === 'string') streamText += delta.content;
                if (Array.isArray(delta?.tool_calls)) streamToolCalls.push(...delta.tool_calls);
                res.write(`data: ${JSON.stringify(maskedFallback)}\n\n`);
                streamChunkCount += 1;
              }
              streamSucceeded = true;
              break;
            } catch (error) {
              streamLastError = error;
              if (streamChunkCount > beforeCandidateChunks) throw error; // No replay after partial output.
              await requestLog.warn('provider.stream_candidate_failed',{routeId:route.routeId,providerId:candidate.providerId,model:candidate.model,error:String(error?.message ?? error)});
            }
          }
          if (!streamSucceeded) throw streamLastError ?? new Error('provider_stream_route_failed');
          if (currentStreamSession) {
            await evidenceGate.record({contextId:currentStreamSession.id,source:'provider:ZombieCoder',status:'observed',confidence:'direct-response',observedAt:new Date().toISOString(),summary:'Provider returned a streaming response; this is not execution verification'});
            await sessionState.append(currentStreamSession.id,app.id,streamUserMessage,{kind:'request'});
            await sessionState.append(currentStreamSession.id,app.id,{role:'assistant',content:streamText,...(streamToolCalls.length ? {tool_calls:streamToolCalls} : {})},{kind:'provider_response'});
          }
          await recordAgentRun(streamAgent.agent?.id ?? streamAgentId, 'success', {latencyMs:Date.now()-startedAt, model, providerId:provider.id, path:'stream'});
          res.write('data: [DONE]\n\n');
        } catch (e) {
          await recordAgentRun(streamAgent.agent?.id ?? streamAgentId, 'failure', {latencyMs:Date.now()-startedAt, path:'stream'});
          res.write(`event: error\ndata: ${JSON.stringify({error:'stream_failed',requestId})}\n\n`);
        } finally { res.end(); }
        return;
      }
      const context = await contexts.resolve(input);
      const plainAgentId = String(input.agent ?? input.persona ?? 'code-guru');
      const plainScope=await resolveAgentScope(plainAgentId,{requestedRoot:input.projectRoot,requestedWorkingDirectory:input.workingDirectory});
      const projectRoot = plainScope.projectRoot;
      if (projectRoot) await autoSetup.ensure(projectRoot);
      const project = projectRoot ? await ssot.read(projectRoot) : null;
      const memoryDoc = projectRoot ? await memory.recent(projectRoot, 10) : null;
      const syllabusDoc = projectRoot ? await syllabus.read(projectRoot) : null;
      const entities = entityDoor.resolve(input);
      const personaId = String(input.agent ?? input.persona ?? 'code-guru');
      const goal = String(input.goal ?? input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content ?? 'chat request');
      await requestLog.debug('agent.resolve.request', {applicationId:app.id,agentId:personaId,personaId,goalPresent:Boolean(input.goal),toolCount:Array.isArray(input.toolIds)?input.toolIds.length:0});
      requestState.agentId=personaId;
      const agentPrepared = await agentRunner.prepare({agentId:personaId,personaId,goal,expectedOutcome:input.expectedOutcome,tools:input.toolIds});
      requestState.agentId=agentPrepared.agent?.id ?? personaId;
      const session = input.sessionId ? await sessionClient.resolve({sessionId:input.sessionId,applicationId:app.id}) : (input.createSession ? await sessionClient.resolve({applicationId:app.id,createIfMissing:true,userId:input.userId}) : null);
      const incomingMetadata = {
        sessionSource: input.sessionSource ?? req.headers['x-session-source'] ?? 'api',
        clientId: input.clientId ?? req.headers['x-client-id'] ?? null,
        editor: input.editor ?? req.headers['x-editor'] ?? null,
        editorVersion: input.editorVersion ?? req.headers['x-editor-version'] ?? null,
        clientVersion: input.clientVersion ?? req.headers['x-client-version'] ?? null,
        osPlatform: input.osPlatform ?? req.headers['x-os-platform'] ?? null,
        deviceInfo: input.deviceInfo ?? req.headers['x-device-info'] ?? null
      };
      if (session) await sessions.updateMetadata(session.id,app.id,Object.fromEntries(Object.entries(incomingMetadata).filter(([,v])=>v != null && String(v).trim())));
      const currentSession = session ? await sessions.get(session.id,app.id) : null;
      const route = await smartRouter.route(input);
      let providerId = route.providerId;
      let provider = await providers.resolve(providerId);
      let model = await providers.resolveModel(providerId, route.model || input.model);
      const chatArchive=session ? await sessionState.archive(session.id,app.id) : [];
      const chatEvidence=session ? (await store.read('evidence',[])).filter(item=>item.contextId===session.id).slice(-8) : [];
      const boundedChat=boundedConversation(input.messages,chatArchive,chatArchive,goal);
      const sessionMessages = boundedChat.messages.length ? boundedChat.messages : [latestUserMessage(input.messages,goal)];
      const currentUserMessage = latestUserMessage(input.messages,goal);
      const compiledContext = compileContext({goal,userInput:currentUserMessage.content,recent:sessionMessages,memory:memoryDoc ?? [],ssot:project,syllabus:syllabusDoc,projectRoot,workingDirectory:input.workingDirectory ?? projectRoot,sessionId:currentSession?.id ?? input.sessionId ?? null,taskPolicy,maxBytes:config.compiledContextBytes,recentLimit:config.contextRecentMessages});
      await requestLog.debug('context.compiled',{applicationId:app.id,sessionId:currentSession?.id ?? null,projectRoot,workingDirectory:input.workingDirectory ?? projectRoot,ssotSections:compiledContext.ssot.sections.length,syllabusEntries:compiledContext.syllabus.length,memoryEntries:compiledContext.memory.length,recentCount:compiledContext.recent.length,sessionCount:sessionMessages.length,archiveSelected:boundedChat.archiveSelected,bytes:Buffer.byteLength(JSON.stringify(compiledContext))});
      const requestedToolIds = Array.isArray(input.toolIds) ? input.toolIds.map(String) : [];
      const allToolDefinitions = await toolsRegistry.list();
      const toolCatalog = allToolDefinitions.filter(tool => requestedToolIds.includes(String(tool.id)));
      const systemMessage = buildSystemMessage({constitution:CORE_CONSTITUTION,agent:agentPrepared.agent,persona:agentPrepared.persona,goal,expectedOutcome:input.expectedOutcome,projectRoot,ssot:project,syllabus:syllabusDoc,memory:memoryDoc,session:currentSession,route,tools:requestedToolIds,toolCatalog,compiledContext});
      const userMessages = sessionMessages;
      const providerMessages = [systemMessage,...userMessages];
      let result = null;
      let providerLastError = null;
      for (const candidate of route.candidates) {
        try {
          providerId = candidate.providerId;
          provider = await providers.resolve(providerId);
          model = await providers.resolveModel(providerId, route.publicModel ? candidate.model : (input.model || candidate.model));
          result = await provider.chatCompletions({...input,provider:undefined,model,messages:providerMessages,stream:false});
          break;
        } catch (error) {
          providerLastError = error;
          await requestLog.warn('provider.chat_candidate_failed',{routeId:route.routeId,providerId:candidate.providerId,model:candidate.model,error:String(error?.message ?? error),...providerErrorDetail(error)});
        }
      }
      if (result === null) throw providerLastError ?? new Error('provider_route_failed');
      const canonicalInput = typeof provider.toCanonical === 'function' ? provider.toCanonical(result) : result;
      const canonical = normalizer.normalize(canonicalInput,{model,providerId:provider.id});
      const masked = maskCanonicalResponse(canonical,{agentId:agentPrepared.agent?.id ?? personaId,configuredModel:route.publicModel || '',capabilities:Object.keys(provider.capabilities ?? {}).filter(k=>provider.capabilities[k])});
      // Internal provenance keeps the real upstream provider id: the log and the evidence
      // store are not client-visible. The response payload is masked separately below.
      const evidence=[{source:`provider:${provider.id}`,status:'observed',confidence:'direct-response',observedAt:new Date().toISOString(),summary:'Provider returned a response; this is not execution verification'}];
      if (currentSession) await evidenceGate.record({contextId:currentSession.id,...evidence[0]});
      const verificationRequired=Boolean(input.goal || input.projectRoot || input.toolIds || input.autoToolLoop);
      if (currentSession) {
        await sessionState.append(currentSession.id,app.id,currentUserMessage,{kind:'request'});
        const assistantMessage=masked?.choices?.[0]?.message ?? {role:'assistant',content:''};
        await sessionState.append(currentSession.id,app.id,{role:'assistant',content:assistantMessage.content ?? '',...(assistantMessage.tool_calls ? {tool_calls:assistantMessage.tool_calls} : {})},{kind:'provider_response'});
      }
      requestState.outcome = 'observed_unverified';
      requestState.agentId=agentPrepared.agent?.id ?? null;
      await recordAgentRun(agentPrepared.agent?.id, 'success', {latencyMs:Date.now()-startedAt, model, providerId:provider.id, path:'chat'});
      await requestLog.info('chat.completed',{applicationId:app.id,agentId:agentPrepared.agent?.id,personaId:agentPrepared.persona?.id,providerId:provider.id,model,sessionId:currentSession?.id ?? null,evidenceStatus:'observed',verified:false,routeId:route.routeId,contextInjected:true});
      return send(res,200,{...masked,applicationId:app.id,meta:{phase:RUNTIME_PHASE,taskPolicy,agentAccess:plainScope.access,route:{routeId:route.routeId,providerId:'masked',model:route.publicModel || masked.model,publicModel:route.publicModel || masked.model,requiredCapabilities:route.requiredCapabilities,candidateCount:route.candidates.length,reason:route.reason,status:route.status},provider:{name:'ZombieCoder',id:'masked'},model:masked.model,session:currentSession,context,project,syllabus:syllabusDoc,memory:memoryDoc,entities,agent:agentPrepared.agent,persona:agentPrepared.persona,constitution:CORE_CONSTITUTION,sessionMetadata:currentSession?.metadata ?? incomingMetadata,systemPrompt:{injected:true,visibleToClient:false,contextCompiled:true},receivedMessages:Array.isArray(input.messages)?input.messages.length:0,evidence:maskEvidenceForPublic(evidence),verified:false,verificationRequired}});
    }
    if (req.method==='GET' && url.pathname==='/api/syllabus') {
      const root=url.searchParams.get('projectRoot')||config.dataDir; await autoSetup.ensure(root); const doc=await syllabus.read(root);
      return send(res,200,{ok:true,syllabus:doc?.content??'',path:path.join(root,'.zombiecoder','syllabus.md')});
    }
    if (req.method==='GET' && url.pathname==='/api/memory') {
      const root=url.searchParams.get('projectRoot')||config.dataDir; await autoSetup.ensure(root); const doc=await memory.read(root);
      return send(res,200,{ok:true,memory:doc,path:path.join(root,'.zombiecoder','memory.json')});
    }
    if (req.method==='POST' && url.pathname==='/api/workspace') {
      const app=await authenticateRequest(req,requestLog,requestState); if(!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req,config.maxBodyBytes); const root=input.projectRoot||input.path||config.dataDir;
      return send(res,200,{success:true,applicationId:app.id,working_dir:root,setup:await autoSetup.ensure(root,{refreshSSOT:true}),ssot:await ssot.read(root)});
    }
    if (req.method==='POST' && url.pathname==='/api/syllabus') {
      const app=await authenticateRequest(req,requestLog,requestState); if(!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await body(req,config.maxBodyBytes); const root=input.projectRoot||config.dataDir;
      return send(res,201,{applicationId:app.id,entry:await syllabus.append(root,input)});
    }
    if (req.method==='POST' && url.pathname==='/api/input') {
      const app=await authenticateRequest(req,requestLog,requestState); if(!app) return send(res,401,{error:'application_unauthorized_or_expired'});
      const input=await applyAgentModelMapping(await body(req,config.maxBodyBytes));
      const goal=String(input.input||input.prompt||input.goal||input.messages?.filter?.(m=>m?.role==='user').at(-1)?.content||'chat request');
      const callerMessages=Array.isArray(input.messages)?input.messages:[];
      const messages=callerMessages.length?callerMessages:[{role:'user',content:goal}];
      // The execution lifecycle requires an explicit system prompt, while this legacy shim
      // may only receive the caller's input. Bind the runtime identity prompt when the
      // caller supplied none; otherwise the route always failed with system_prompt_required.
      const boundMessages=messages.some(m=>m?.role==='system')?messages:[{role:'system',content:'ZombieCoder unified input session.'},...messages];
      const result=await providerExecution.execute({prepared:{contract:{goal,expectedOutcome:input.expectedOutcome||'legacy chat response'},consent:{allowed:true}},input:{...input,applicationId:app.id,messages:boundMessages,sessionId:input.sessionId||null}});
      const canonical=result.response;
      return send(res,200,{status:'ok',response:canonical,content:canonical?.choices?.[0]?.message?.content??null,model:canonical?.model??result.identity?.model??null,session_id:input.sessionId||null,evidence:maskEvidenceForPublic(result.evidence),verified:false,legacyCompatibility:true});
    }
    if (req.method==='GET' && url.pathname==='/v1/admin/routes') {
      if(!await adminOk(req)) return send(res,401,{error:'admin_unauthorized'});
      return send(res,200,routeMapReport());
    }
    return send(res,404,{error:'not_found'});
  } catch (e) {
    const message = String(e?.message ?? REQUEST_FAILED);
    // A provider that answered 429 is not a generic failure: it is an instruction
    // to wait and retry, and the upstream `retry-after` is the only honest source
    // for how long. Collapsing it into `request_failed` (the old behaviour) told
    // the user nothing and made a transient limit look permanent. The provider
    // identity still stays masked; only the limit and the wait are published.
    const rateLimited = message === 'provider_http_error' && Number(e?.statusCode) === 429;
    const retryAfterMs = rateLimited ? retryAfterMsFrom(e?.providerHeaders) : null;
    // The stored audit record keeps its own key, but the log field must not be
    // called remoteMessage: the logger omits any key containing "message".
    await requestLog.error('http.error', {error:message,name:e?.name ?? 'Error',statusCode:e?.statusCode ?? null,retryAfterMs:e?.retryAfterMs ?? null,remoteCode:e?.remoteCode ?? null,remoteReason:e?.remoteMessage ?? null});
    const statusCode = message === 'outbound_circuit_open' ? 503 : (Number(e?.statusCode) || 400);
    const headers = message === 'outbound_circuit_open'
      ? {'retry-after': String(Math.max(1, Math.ceil((Number(e?.retryAfterMs) || 0) / 1000)))}
      : (rateLimited && retryAfterMs !== null ? {'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000)))} : {});
    // Which internal codes may be published is decided by src/core/public-errors.js, so
    // the rule is testable without booting a server and cannot drift entry by entry. The
    // upstream message stays in the logs and audit trail, never in the response, because
    // it can contain the remote server's filesystem layout.
    const publicError = rateLimited ? 'provider_rate_limited' : publicErrorCode(message);
    // An agent-scoped request that threw before its completion hook is a failed
    // run for that agent; record it here so the counter cannot silently miss it.
    if (requestState.agentId) await recordAgentRun(requestState.agentId, 'failure', {latencyMs:Date.now()-startedAt, path:requestState.operation});
    return send(res, statusCode, {error: publicError, requestId, ...(message === 'outbound_circuit_open' ? {retryAfterMs:e.retryAfterMs} : {}), ...(rateLimited ? {retryable:true, ...(retryAfterMs !== null ? {retryAfterMs} : {})} : {}), ...(e?.mcpCode ? {mcpCode:e.mcpCode} : {}), ...(e?.remoteCode ? {remoteCode:e.remoteCode} : {})}, headers);
  }
};

const transportServers = await startTransportServers({handler:requestHandler, config, logger, runtimeIdentity});
// Server-Sent Events are not a standalone listener in this runtime: streamed
// events are delivered as HTTP responses. The mode is reported to the registry
// so a stale VERIFIED status from an older run cannot survive a restart.
const SSE_DELIVERY_MODE = 'http-response-mode';
// Reconcile declared transport status with what actually started, so a disabled
// or failed transport is never reported as VERIFIED.
await transportsRegistry.syncRuntimeState({servers:transportServers, config, sseMode:SSE_DELIVERY_MODE});
await logger.info('runtime.started', {version:RUNTIME_VERSION,phase:RUNTIME_PHASE,runtimeId:runtimeIdentity.runtimeId,instanceId:runtimeIdentity.instanceId,transports:Object.fromEntries(Object.entries(transportServers).map(([key,server])=>[key,Boolean(server)])),sse:SSE_DELIVERY_MODE});
// Memory is written at startup and then on an interval, so a leak has a history rather than
// only a post-mortem. `MEMORY_LOG_INTERVAL_MS=0` keeps the startup line and stops the rest.
const memoryMonitor = startMemoryMonitor({logger, intervalMs:config.memoryLogIntervalMs});

process.on('SIGINT', async () => { memoryMonitor.stop(); await stopTransportServers(transportServers); await releaseRuntimeLock(); process.exit(0); });
process.on('SIGTERM', async () => { memoryMonitor.stop(); await stopTransportServers(transportServers); await releaseRuntimeLock(); process.exit(0); });
