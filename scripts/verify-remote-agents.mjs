#!/usr/bin/env node
'use strict';

// Live proof that remote provider catalogs load and that the agents can use them.
// Every provider call below goes to the real upstream with the key from .env; no
// fixture stands in for a provider. The script restores the agent mappings it
// changes, so a failed run does not leave the console pointed at a test model.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:9999';
const APP_KEY_FILE = '/tmp/opencode/remote-verify-app-key';
const SCRATCH = path.join(ROOT, 'data', 'remote-verify-scratch');
const TOOL_ID = 'runtime_echo';
const TOOL_PROMPT = 'Call the runtime_echo tool with value 7. Do not answer with prose.';

const TARGETS = [
  { id: 'gemini', model: 'gemini-3.5-flash-lite' },
  { id: 'groq', model: 'openai/gpt-oss-20b' },
  { id: 'ollama-cloud-openai', model: 'gpt-oss:20b' }
];
const AGENT_PROVIDER = process.env.VERIFY_AGENT_PROVIDER || 'gemini';
const AGENT_TARGET = TARGETS.find(target => target.id === AGENT_PROVIDER) ?? TARGETS[0];

function readEnv(name) {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(item => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

const ADMIN_TOKEN = readEnv('ADMIN_TOKEN');
if (!ADMIN_TOKEN) {
  console.error('REMOTE_AGENTS_FAIL reason=admin_token_missing');
  process.exit(2);
}
const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

class VerifyError extends Error {
  constructor(reason, detail = '') {
    super(`${reason}${detail ? ` ${detail}` : ''}`);
    this.reason = reason;
    this.detail = detail;
  }
}

function fail(reason, detail = '') {
  throw new VerifyError(reason, detail);
}

async function jsonFetch(url, options = {}, timeoutMs = 30000) {
  const started = Date.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, latencyMs: Date.now() - started };
}

async function adminFetch(pathname, options = {}, timeoutMs = 30000) {
  return jsonFetch(`${BASE}${pathname}`, { ...options, headers: { ...adminHeaders, ...(options.headers ?? {}) } }, timeoutMs);
}

async function ensureAppKey() {
  if (existsSync(APP_KEY_FILE)) {
    const key = readFileSync(APP_KEY_FILE, 'utf8').trim();
    if (key) return key;
  }
  const created = await adminFetch('/v1/admin/applications', {
    method: 'POST',
    body: JSON.stringify({ name: `remote-verify-${randomUUID().slice(0, 8)}`, role: 'user' })
  });
  const key = created.body?.apiKey;
  if (created.status !== 201 || !key) fail('application_create_failed', `status=${created.status}`);
  writeFileSync(APP_KEY_FILE, `${key}\n`, { mode: 0o600 });
  chmodSync(APP_KEY_FILE, 0o600);
  return key;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });

  const health = await jsonFetch(`${BASE}/health`, {}, 10000);
  if (health.status !== 200 || health.body?.ok !== true) fail('health_failed', `status=${health.status}`);

  const originalMappings = (await adminFetch('/v1/admin/agent-model-mappings')).body?.mappings ?? [];
  const restore = new Map(originalMappings.map(item => [item.agentId, item.model]));
  const results = { providers: [], agents: [], placeholderRecovery: null };

  try {
    // 1. The bug the console reported: an enabled provider whose seed still has a
    // placeholder default. Wipe Gemini's stored default/catalog, then let the
    // unmodified Test button path discover it. The seed is restored afterwards.
    const before = (await adminFetch('/v1/admin/providers')).body?.providers?.find(item => item.id === 'gemini');
    if (!before) fail('gemini_missing');
    const savedDefault = before.defaultModel;
    const savedModels = Array.isArray(before.models) ? before.models : [];
    try {
      const wiped = await adminFetch('/v1/admin/providers/gemini', {
        method: 'PATCH',
        body: JSON.stringify({ defaultModel: 'REPLACE_WITH_SUPPORTED_GEMINI_MODEL', models: [] })
      });
      if (wiped.status !== 200) fail('placeholder_setup_failed', `status=${wiped.status}`);
      const recovered = await adminFetch('/v1/admin/providers/gemini/test', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'Reply with the single word: ok' })
      }, 120000);
      if (recovered.body?.ok !== true) fail('placeholder_recovery_failed', `error=${recovered.body?.error ?? 'unknown'}`);
      if (/^REPLACE_WITH_/i.test(String(recovered.body?.model ?? ''))) fail('placeholder_recovery_used_placeholder');
      results.placeholderRecovery = { model: recovered.body.model, latencyMs: recovered.body.latencyMs };
    } finally {
      await adminFetch('/v1/admin/providers/gemini', {
        method: 'PATCH',
        body: JSON.stringify({ defaultModel: savedDefault, models: savedModels })
      }).catch(() => {});
    }

    // 2. Catalog + chat probe for every remote provider.
    for (const target of TARGETS) {
      const refresh = await adminFetch(`/v1/admin/providers/${target.id}/models/refresh`, { method: 'POST' }, 120000);
      if (refresh.status !== 200) fail('model_refresh_failed', `provider=${target.id} status=${refresh.status}`);
      const provider = refresh.body?.provider;
      const models = Array.isArray(provider?.models) ? provider.models : [];
      if (!models.length) fail('model_catalog_empty', `provider=${target.id}`);
      if (!models.includes(target.model)) fail('model_not_in_catalog', `provider=${target.id} model=${target.model}`);
      if (/^REPLACE_WITH_/i.test(String(provider?.defaultModel ?? ''))) fail('placeholder_default_survived', `provider=${target.id}`);

      const probe = await adminFetch(`/v1/admin/providers/${target.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ model: target.model, prompt: 'Reply with exactly: REMOTE_PROVIDER_OK' })
      }, 120000);
      const content = String(probe.body?.response?.choices?.[0]?.message?.content ?? '');
      if (probe.body?.ok !== true || !content.includes('REMOTE_PROVIDER_OK')) {
        fail('provider_probe_failed', `provider=${target.id} error=${probe.body?.error ?? 'sentinel_missing'}`);
      }
      results.providers.push({ id: target.id, model: target.model, catalog: models.length, latencyMs: probe.body.latencyMs });
    }

    // 3. One agent per provider proves the remote model actually emits a tool call.
    for (const target of TARGETS) {
      const mapped = await adminFetch('/v1/admin/agent-model-mappings/code-guru', {
        method: 'PUT',
        body: JSON.stringify({ model: target.model })
      });
      if (mapped.status !== 200) fail('mapping_failed', `provider=${target.id} status=${mapped.status}`);
      const tool = await adminFetch('/v1/admin/agents/code-guru/test', {
        method: 'POST',
        body: JSON.stringify({ mode: 'tool', toolChoice: 'required', prompt: TOOL_PROMPT, toolIds: [TOOL_ID], projectRoot: SCRATCH })
      }, 180000);
      const calls = Array.isArray(tool.body?.toolCalls) ? tool.body.toolCalls : [];
      if (tool.body?.ok !== true || tool.body?.providerId !== target.id || calls.length < 1) {
        fail('provider_tool_call_failed', `provider=${target.id} got=${tool.body?.providerId ?? 'none'} calls=${calls.length} error=${tool.body?.error ?? 'none'}`);
      }
      results.providers.find(item => item.id === target.id).toolCall = calls[0]?.function?.name ?? null;
    }

    // 4. All twelve agents through one remote provider.
    const agents = (await adminFetch('/v1/admin/registry/agents')).body?.components ?? [];
    if (agents.length !== 12) fail('agent_count_mismatch', `count=${agents.length}`);
    for (const agent of agents) {
      const mapped = await adminFetch(`/v1/admin/agent-model-mappings/${agent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ model: AGENT_TARGET.model })
      });
      if (mapped.status !== 200) fail('agent_mapping_failed', `agent=${agent.id} status=${mapped.status}`);
      const tool = await adminFetch(`/v1/admin/agents/${agent.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'tool', toolChoice: 'required', prompt: TOOL_PROMPT, toolIds: [TOOL_ID], projectRoot: SCRATCH })
      }, 180000);
      const calls = Array.isArray(tool.body?.toolCalls) ? tool.body.toolCalls : [];
      if (tool.body?.ok !== true || tool.body?.providerId !== AGENT_TARGET.id || calls.length < 1) {
        fail('agent_tool_call_failed', `agent=${agent.id} provider=${tool.body?.providerId ?? 'none'} calls=${calls.length} error=${tool.body?.error ?? 'none'}`);
      }
      results.agents.push({ id: agent.id, providerId: tool.body.providerId, model: tool.body.model, toolCalls: calls.length, latencyMs: tool.body.latencyMs });
    }

    // 5. One full tool loop: the model asks for the tool, the runtime executes it,
    // and the response carries observed evidence. This is the "actually works"
    // check, not just "the model said it would call a tool".
    const appKey = await ensureAppKey();
    const loop = await jsonFetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'code-guru',
        provider: AGENT_TARGET.id,
        model: AGENT_TARGET.model,
        messages: [{ role: 'user', content: 'Use the runtime_echo tool to echo the value 42. Then report the tool result.' }],
        toolIds: [TOOL_ID],
        autoToolLoop: true,
        consent: true,
        projectRoot: SCRATCH,
        max_tokens: 256,
        temperature: 0
      })
    }, 240000);
    const loopMeta = loop.body?.meta?.toolLoop;
    const evidence = Array.isArray(loop.body?.meta?.evidence) ? loop.body.meta.evidence : [];
    const echoEvidence = evidence.filter(item => String(item?.source ?? '').includes(TOOL_ID) && item?.status === 'observed' && item?.confidence !== 'execution-error');
    if (loop.status !== 200 || loopMeta?.status !== 'completed' || echoEvidence.length < 1) {
      fail('tool_loop_failed', `status=${loop.status} loop=${loopMeta?.status ?? 'none'} evidence=${echoEvidence.length} error=${loop.body?.error?.message ?? 'none'}`);
    }
    results.toolLoop = { providerId: loopMeta.providerId ?? AGENT_TARGET.id, status: loopMeta.status, rounds: loopMeta.roundCount ?? loopMeta.rounds?.length ?? null, evidence: echoEvidence.length, latencyMs: loop.latencyMs };

    const artifactPath = path.join(ROOT, 'data', 'remote-agents-verification.json');
    writeFileSync(artifactPath, `${JSON.stringify({
      runAt: new Date().toISOString(),
      baseUrl: BASE,
      providers: results.providers,
      agents: results.agents,
      toolLoop: results.toolLoop,
      placeholderRecovery: results.placeholderRecovery,
      summary: {
        providers: results.providers.length,
        agents: results.agents.length,
        toolCalls: results.agents.length,
        toolLoop: results.toolLoop.status,
        placeholderRecovery: 'ok'
      }
    }, null, 2)}\n`);

    console.log(`REMOTE_AGENTS_OK providers=${results.providers.length} agents=${results.agents.length} tool_calls=${results.agents.length} tool_loop=ok models=loaded placeholder_recovery=ok`);
    console.log('report=data/remote-agents-verification.json');
    for (const provider of results.providers) {
      console.log(`provider ${provider.id} model=${provider.model} catalog=${provider.catalog} chat=ok tool_call=${provider.toolCall} latency_ms=${provider.latencyMs}`);
    }
    console.log(`agents provider=${AGENT_TARGET.id} model=${AGENT_TARGET.model} tool_calls=${results.agents.map(item => item.id).join(',')}`);
    console.log(`tool_loop provider=${results.toolLoop.providerId} rounds=${results.toolLoop.rounds} evidence=${results.toolLoop.evidence} latency_ms=${results.toolLoop.latencyMs}`);
    console.log(`placeholder_recovery model=${results.placeholderRecovery.model} latency_ms=${results.placeholderRecovery.latencyMs}`);
  } finally {
    // Put every mapping back, even when a check above failed.
    for (const [agentId, model] of restore) {
      await adminFetch(`/v1/admin/agent-model-mappings/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify({ model })
      }).catch(() => {});
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof VerifyError) {
    console.error(`REMOTE_AGENTS_FAIL reason=${error.reason}${error.detail ? ` ${error.detail}` : ''}`);
  } else {
    console.error(`REMOTE_AGENTS_FAIL reason=unexpected detail=${String(error?.message ?? error).slice(0, 300)}`);
  }
  process.exit(1);
}
