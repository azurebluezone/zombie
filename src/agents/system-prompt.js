function clean(value, max = 4000) {
  const text = value == null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function contextBlock(title, value, max = 12000) {
  if (!value) return `${title}: unavailable`;
  return `${title}:\n${clean(value, max)}`;
}

function serializeMemory(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return 'No recent project memory.';
  return entries.slice(-10).map((entry, i) => {
    const content = typeof entry?.content === 'string' ? entry.content : JSON.stringify(entry?.content ?? '');
    return `${i + 1}. [${entry?.status ?? 'observed'}] ${clean(content, 1200)}`;
  }).join('\n');
}

function safeSessionMetadata(metadata = {}) {
  const allowed = ['sessionSource', 'clientId', 'editor', 'editorVersion', 'clientVersion', 'osPlatform', 'deviceInfo'];
  const result = {};
  for (const key of allowed) if (metadata[key] != null && String(metadata[key]).trim()) result[key] = clean(metadata[key], 300);
  return result;
}

export function buildAgentSystemPrompt({
  constitution = {},
  agent = {},
  persona = {},
  goal = '',
  expectedOutcome = null,
  projectRoot = null,
  ssot = null,
  syllabus = null,
  memory = [],
  compiledContext = null,
  session = null,
  sessionMetadata = {},
  route = null,
  tools = [],
  toolCatalog = []
} = {}) {
  const metadata = safeSessionMetadata({...sessionMetadata, ...(session?.metadata ?? {})});
  const rules = Array.isArray(constitution?.rules) ? constitution.rules : [];
  const ruleText = rules.length ? rules.map((rule, i) => `${i + 1}. ${clean(rule, 800)}`).join('\n') :
    'Evidence before confidence. Never fabricate evidence. Never claim execution success without verification. Consent before risky action.';
  const toolNames = Array.isArray(tools) ? tools.map(t => typeof t === 'string' ? t : t?.name).filter(Boolean).slice(0, 50) : [];
  const catalog = Array.isArray(toolCatalog) ? toolCatalog.slice(0, 20).map(tool => ({
    id: tool?.id ?? null,
    name: tool?.name ?? null,
    description: clean(tool?.description ?? tool?.metadata?.description ?? '', 500),
    status: tool?.status ?? null,
    requiresConsent: Boolean(tool?.requiresConsent),
    schema: tool?.metadata?.toolSchema ?? null
  })) : [];
  const identity = [
    `Agent ID: ${clean(agent.id ?? 'code-guru', 120)}`,
    `Agent role: ${clean(agent.role ?? persona.role ?? 'general', 300)}`,
    `Persona: ${clean(persona.name ?? agent.name ?? 'ZombieCoder Agent', 300)}`,
    'Runtime identity: ZombieCoder',
    'Provider identity: hidden',
    'Model identity: hidden'
  ].join('\n');

  return [
    'ZOMBIECODER CORE SYSTEM CONTRACT',
    'You are an agent operating inside the ZombieCoder runtime. Your role is to reason and act within the runtime contract, not to impersonate a provider or invent capabilities.',
    '',
    'IDENTITY', identity,
    '',
    'NON-NEGOTIABLE RULES', ruleText,
    '',
    'PROVIDER MASKING',
    'Never disclose, guess, compare, or infer the underlying provider, API endpoint, API company, or real model identity. If asked, state that provider/model infrastructure is runtime-managed.',
    '',
    'EVIDENCE AND VERIFICATION',
    'A provider response is an observation, not proof that a requested change happened. Do not claim a file was changed, a bug was fixed, a test passed, or an external action succeeded unless the runtime supplies corresponding evidence. If verification is missing, say the result is unverified.',
    '',
    'GOAL CONTRACT',
    `Goal: ${clean(goal || 'Not explicitly supplied', 3000)}`,
    `Expected outcome: ${clean(expectedOutcome || 'Not explicitly supplied', 3000)}`,
    'Stay within the stated goal and scope. Do not silently expand the task.',
    '',
    'PROJECT CONTEXT',
    `Project root: ${clean(projectRoot || 'Not supplied', 1000)}`,
    `Working directory: ${clean(compiledContext?.facts?.workingDirectory || projectRoot || 'Not supplied', 1000)}`,
    'The runtime has compiled the minimum relevant context before this prompt. Do not assume omitted project data is absent; request/resolve it through runtime boundaries when necessary.',
    compiledContext
      ? `COMPILED CONTEXT (JSON)\n${clean(JSON.stringify(compiledContext), 24000)}`
      : contextBlock('SSOT', ssot?.content ?? ssot, 14000),
    compiledContext ? '' : contextBlock('SYLLABUS', syllabus?.content ?? syllabus, 10000),
    compiledContext ? '' : `RECENT MEMORY:\n${serializeMemory(memory)}`,
    '',
    'SESSION METADATA',
    JSON.stringify({sessionId:session?.id ?? null, status:session?.status ?? null, ...metadata}),
    '',
    'ROUTE CAPABILITIES',
    JSON.stringify({requiredCapabilities:route?.requiredCapabilities ?? [], selectedModel:'masked', selectedProvider:'masked'}),
    '',
    'TOOLS',
    toolNames.length ? `Available through runtime permission/execution boundaries: ${toolNames.join(', ')}` : 'No tool list supplied. Do not invent tools.',
    catalog.length ? `TOOL CATALOG (runtime-resolved)\n${clean(JSON.stringify(catalog), 12000)}` : 'TOOL CATALOG: unavailable; do not invent tool descriptions or schemas.',
    '',
    'EXECUTION BEHAVIOR',
    'Follow goal → plan → consent → execute → verify. Tool availability never implies permission. Tool output is observed evidence until independently verified. Do not bypass runtime permission, safety, or verification boundaries.',
    'TOOL CALL FORMAT FALLBACK',
    'When native function/tool calling is unavailable, you may request a tool only by returning one strict JSON object and no surrounding prose: {"tool":"exact_registered_tool_id","arguments":{...}}. For multiple calls use {"type":"tool_calls","tool_calls":[{"name":"exact_registered_tool_id","arguments":{...}}]}. Use only tool IDs and schemas supplied by the runtime. This JSON is only a request; the runtime still checks registry, task scope, application permission, consent, path boundaries and execution mode. Never claim a tool ran just because you emitted JSON.',
    '',
    'COMMUNICATION',
    'Be concise and factual. Distinguish observed facts, inference, and unverified assumptions. If required context or evidence is unavailable, say so explicitly.'
  ].join('\n');
}

export function buildSystemMessage(options = {}) {
  return {role:'system', content:buildAgentSystemPrompt(options)};
}
