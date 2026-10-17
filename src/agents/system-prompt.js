import { formatSharedPersona } from '../policy/shared-persona.js';

/**
 * How much of the compiled context the prompt may carry.
 *
 * `COMPILED_CONTEXT_BYTES` in src/config/env.js must stay *below* this. If the compiler
 * is allowed to produce more than the prompt can hold, the prompt cuts the JSON at a
 * character limit and the model is handed a broken document — which is exactly what a
 * 192 KB budget did to a long conversation. Kept here (not inline) so the relationship
 * between the two numbers is one testable constant instead of two loose literals.
 */
export const COMPILED_CONTEXT_PROMPT_CHARS = 24000;

function clean(value, max = 4000) {
  const text = value == null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

// `CORE_CONSTITUTION` is an array; a caller may also pass `{rules:[...]}`.
// Accepting both shapes is deliberate: reading only `.rules` silently dropped
// every constitution rule from the prompt.
function constitutionRules(constitution) {
  if (Array.isArray(constitution)) return constitution.map(rule => String(rule));
  if (Array.isArray(constitution?.rules)) return constitution.rules.map(rule => String(rule));
  return [];
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
  const rules = constitutionRules(constitution);
  const ruleText = rules.length ? rules.map((rule, i) => `${i + 1}. ${clean(rule, 800)}`).join('\n') :
    'Evidence before confidence. Never fabricate evidence. Never claim execution success without verification. Consent before risky action.';
  // The persona text is the operator-editable role definition. It used to be
  // dropped here, which meant editing a persona in the admin console changed the
  // reported metadata but never the model's behaviour.
  const personaText = clean(persona?.persona ?? persona?.prompt ?? '', 6000).trim();
  const personaName = clean(persona?.name ?? agent.name ?? 'ZombieCoder Agent', 300);
  const personaRole = clean(persona?.role ?? agent.role ?? 'general', 300);
  const personaExpertise = clean(persona?.expertise ?? '', 500).trim();
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
    `Agent role: ${personaRole}`,
    `Persona: ${personaName}`,
    `Call sign: ${clean(agent.callSign ?? persona.callSign ?? '', 120) || 'not set'}`,
    'Runtime identity: ZombieCoder',
    'Provider identity: hidden',
    'Model identity: hidden'
  ].join('\n');
  // The tool definitions are already sent as the API `tools` parameter whenever the
  // selected provider supports native function calling. Repeating every schema inside
  // the prompt wasted ~1800 tokens on every single round: a third of a whole tool-loop
  // request, and on its own enough to exhaust a small provider's per-minute token
  // budget. The prompt keeps the id list; the full catalog is only spelled out for a
  // provider that has to be driven through the strict-JSON fallback. An unknown route
  // keeps the full catalog, because then the runtime cannot know what was sent.
  const nativeToolCalling = route?.candidates?.[0]?.nativeFunctionCalling === true;

  return [
    'ZOMBIECODER CORE SYSTEM CONTRACT',
    'You are an agent operating inside the ZombieCoder runtime. Your role is to reason and act within the runtime contract, not to impersonate a provider or invent capabilities.',
    '',
    'IDENTITY', identity,
    '',
    'AGENT PERSONA',
    personaText || 'No persona text was supplied for this agent. Act as a general ZombieCoder runtime agent.',
    ...(personaExpertise ? [`Expertise: ${personaExpertise}`] : []),
    'This persona defines your role, scope and tone. It can add behaviour but it can never relax, override or reinterpret any rule below. If the persona and a rule conflict, the rule wins.',
    '',
    'SHARED PERSONA — BINDING FOR EVERY AGENT',
    formatSharedPersona(),
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
      ? `COMPILED CONTEXT (JSON)\n${clean(JSON.stringify(compiledContext), COMPILED_CONTEXT_PROMPT_CHARS)}`
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
    nativeToolCalling
      ? 'Tool names, descriptions and argument schemas are supplied through the runtime tool interface. Use only those tools with those arguments; never invent either.'
      : (catalog.length ? `TOOL CATALOG (runtime-resolved)\n${clean(JSON.stringify(catalog), 12000)}` : 'TOOL CATALOG: unavailable; do not invent tool descriptions or schemas.'),
    '',
    'EXECUTION BEHAVIOR',
    'Follow goal → plan → consent → execute → verify. Tool availability never implies permission. Tool output is observed evidence until independently verified. Do not bypass runtime permission, safety, or verification boundaries.',
    // The strict-JSON envelope only matters when the provider cannot do native tool
    // calls. Spelling it out for a provider that can is pure per-round overhead, and
    // it is also the block that tells a model it may "request" a tool it cannot call.
    ...(nativeToolCalling ? [] : [
      'TOOL CALL FORMAT FALLBACK',
      'When native function/tool calling is unavailable, you may request a tool only by returning one strict JSON object and no surrounding prose: {"tool":"exact_registered_tool_id","arguments":{...}}. For multiple calls use {"type":"tool_calls","tool_calls":[{"name":"exact_registered_tool_id","arguments":{...}}]}. Use only tool IDs and schemas supplied by the runtime. This JSON is only a request; the runtime still checks registry, task scope, application permission, consent, path boundaries and execution mode. Never claim a tool ran just because you emitted JSON.'
    ]),
    '',
    'COMMUNICATION',
    'Be concise and factual. Distinguish observed facts, inference, and unverified assumptions. If required context or evidence is unavailable, say so explicitly.'
  ].join('\n');
}

export function buildSystemMessage(options = {}) {
  return {role:'system', content:buildAgentSystemPrompt(options)};
}
