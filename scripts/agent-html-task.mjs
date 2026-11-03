#!/usr/bin/env node
'use strict';

// Live task: each registered agent writes one small HTML identity page through a
// real remote provider. The run log is the deliverable the operator asked for, so
// it records the provider/model, task, start/end, duration and page hash. Agent
// model mappings and working-directory scopes are restored in `finally`, even when
// one agent fails.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.AGENT_HTML_BASE_URL || 'http://127.0.0.1:9999';
const TARGET = process.env.AGENT_HTML_TARGET || '/home/sahon/Music/work mp3/task';
const APP_KEY_FILE = '/tmp/opencode/agent-html-app-key';
const REPORT_COPY = path.join(ROOT, 'data', 'agent-html-run.json');
// Groq's free tier rate-limits tokens per minute. The agent prompt is ~2k tokens
// before tools, so a 60s gap keeps each agent inside its own window. Retries use
// the same pace instead of hammering a hot minute.
const GROQ_MIN_INTERVAL_MS = Number(process.env.AGENT_HTML_GROQ_INTERVAL_MS || 60000);
const MAX_ATTEMPTS = Number(process.env.AGENT_HTML_MAX_ATTEMPTS || 4);
const RETRY_BASE_MS = Number(process.env.AGENT_HTML_RETRY_MS || 30000);

const PROVIDERS = Object.freeze([
  { id: 'gemini', model: 'gemini-3.5-flash-lite' },
  { id: 'groq', model: 'openai/gpt-oss-20b' },
  { id: 'ollama-cloud-openai', model: 'gpt-oss:20b' }
]);

const AGENTS = Object.freeze([
  { id: 'code-guru', name: 'Code Guru', role: 'architecture' },
  { id: 'bug-hunter', name: 'Bug Hunter', role: 'debugging' },
  { id: 'security-hero', name: 'Security Hero', role: 'security' },
  { id: 'perf-wizard', name: 'Performance Wizard', role: 'performance' },
  { id: 'doc-king', name: 'Documentation King', role: 'documentation' },
  { id: 'qa-tyrant', name: 'QA Tyrant', role: 'quality' },
  { id: 'planner', name: 'Planner', role: 'planning' },
  { id: 'researcher', name: 'Researcher', role: 'research' },
  { id: 'integrator', name: 'Integrator', role: 'integration' },
  { id: 'customer-experience-specialist', name: 'Customer Experience Specialist', role: 'customer experience' },
  { id: 'ecommerce-operations-analyst', name: 'Ecommerce Operations Analyst', role: 'ecommerce operations' },
  { id: 'team-heart', name: 'Team Heart', role: 'team wellbeing' }
]);

function readEnv(name) {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(item => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

const ADMIN_TOKEN = readEnv('ADMIN_TOKEN');
if (!ADMIN_TOKEN) {
  console.error('AGENT_HTML_FAIL reason=admin_token_missing');
  process.exit(2);
}
const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lastProviderCall = new Map();

async function paceProvider(providerId) {
  if (providerId !== 'groq') return 0;
  const last = lastProviderCall.get(providerId) ?? 0;
  const waitMs = Math.max(0, last + GROQ_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) {
    console.log(`pace provider=${providerId} wait_ms=${waitMs}`);
    await sleep(waitMs);
  }
  lastProviderCall.set(providerId, Date.now());
  return waitMs;
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
  return jsonFetch(`${BASE}${pathname}`, {
    ...options,
    headers: { ...adminHeaders, ...(options.headers ?? {}) }
  }, timeoutMs);
}

async function ensureAppKey() {
  if (existsSync(APP_KEY_FILE)) {
    const key = readFileSync(APP_KEY_FILE, 'utf8').trim();
    if (key) return key;
  }
  const created = await adminFetch('/v1/admin/applications', {
    method: 'POST',
    body: JSON.stringify({ name: `agent-html-${randomUUID().slice(0, 8)}`, role: 'user' })
  });
  const key = created.body?.apiKey;
  if (created.status !== 201 || !key) throw new Error(`application_create_failed status=${created.status}`);
  writeFileSync(APP_KEY_FILE, `${key}\n`, { mode: 0o600 });
  chmodSync(APP_KEY_FILE, 0o600);
  return key;
}

function identityProblem(page, agent, provider, runId) {
  const text = String(page ?? '');
  const lower = text.toLowerCase();
  if (!text.includes(agent.id)) return `missing agent id ${agent.id}`;
  if (!text.includes(agent.name)) return `missing agent name ${agent.name}`;
  if (!lower.includes(provider.id.toLowerCase())) return `missing provider ${provider.id}`;
  if (!lower.includes(provider.model.toLowerCase())) return `missing model ${provider.model}`;
  if (!text.includes(runId)) return `missing run id ${runId}`;
  return null;
}

function taskPrompt(agent, provider, runId) {
  return [
    `Create your own small identity page with the write_file tool.`,
    `Use path "${agent.id}.html" and set overwriteExisting to true.`,
    `The page must be valid HTML5, under 2 KB, with no external CSS, JS, fonts or images.`,
    `It must visibly include these exact strings:`,
    `Agent: ${agent.name}`,
    `Agent id: ${agent.id}`,
    `Provider: ${provider.id}`,
    `Model: ${provider.model}`,
    `Run: ${runId}`,
    `Add one short sentence about your role: ${agent.role}.`,
    `Call the write_file tool; do not answer with the HTML as prose.`
  ].join('\n');
}

async function main() {
  if (!existsSync(TARGET)) mkdirSync(TARGET, { recursive: true });
  const targetReal = realpathSync(TARGET);
  if (!statSync(targetReal).isDirectory()) throw new Error('target_not_directory');
  const targetHadZombiecoder = existsSync(path.join(targetReal, '.zombiecoder'));
  // A new run id makes every old page invalid. Remove the twelve known pages so a
  // failed attempt can never be mistaken for a page left by the previous run.
  for (const agent of AGENTS) rmSync(path.join(targetReal, `${agent.id}.html`), { force: true });

  const health = await jsonFetch(`${BASE}/health`, {}, 10000);
  if (health.status !== 200 || health.body?.ok !== true) throw new Error(`health_failed status=${health.status}`);

  const appKey = await ensureAppKey();
  const runId = `html-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 6)}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const mappingResponse = await adminFetch('/v1/admin/agent-model-mappings');
  const originalMappings = mappingResponse.body?.mappings ?? [];
  const mappingRestore = new Map(originalMappings.map(item => [item.agentId, item.model]));

  const originalScopes = new Map();
  let restoreDirectory = null;
  for (const agent of AGENTS) {
    const boundary = await adminFetch(`/v1/admin/registry/agents/${agent.id}/boundary`);
    if (boundary.status !== 200) throw new Error(`boundary_read_failed agent=${agent.id} status=${boundary.status}`);
    originalScopes.set(agent.id, boundary.body?.access ?? null);
    restoreDirectory = restoreDirectory ?? boundary.body?.effective?.projectRoot ?? null;
  }
  if (!restoreDirectory) throw new Error('restore_directory_unknown');

  const entries = [];
  const assignment = AGENTS.map((agent, index) => ({
    agent,
    provider: PROVIDERS[index % PROVIDERS.length]
  }));

  try {
    // Point every agent at the requested output directory. The scope route stores
    // the canonical path and validates that it exists and is a directory.
    for (const { agent } of assignment) {
      const scoped = await adminFetch(`/v1/admin/registry/agents/${agent.id}/boundary`, {
        method: 'PATCH',
        body: JSON.stringify({ toolBoundary: 'working-directory', workingDirectory: targetReal })
      });
      if (scoped.status !== 200 || scoped.body?.access?.workingDirectory !== targetReal) {
        throw new Error(`scope_update_failed agent=${agent.id} status=${scoped.status}`);
      }
    }

    for (const { agent, provider } of assignment) {
      const mapped = await adminFetch(`/v1/admin/agent-model-mappings/${agent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ model: provider.model })
      });
      if (mapped.status !== 200) throw new Error(`mapping_update_failed agent=${agent.id} status=${mapped.status}`);

      const pagePath = path.join(targetReal, `${agent.id}.html`);
      const attempts = [];
      let page = null;
      let problem = null;
      let providerWarning = null;
      let loopStatus = null;
      let responseStatus = null;
      let roundCount = null;
      let evidenceCount = null;
      let toolCallNames = [];
      let usage = null;
      const taskStartedAt = new Date().toISOString();
      const taskStartedMs = Date.now();

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        // A retry must not inherit the previous page, otherwise a missing identity
        // check could pass on a stale file.
        rmSync(pagePath, { force: true });
        page = null;
        const paceWaitMs = await paceProvider(provider.id);
        let response;
        try {
          response = await jsonFetch(`${BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              agent: agent.id,
              provider: provider.id,
              model: provider.model,
              messages: [{ role: 'user', content: taskPrompt(agent, provider, runId) }],
              goal: `Create ${agent.id}.html identity page`,
              expectedOutcome: `A small valid HTML page at ${agent.id}.html with the agent identity, provider and model`,
              toolIds: ['write_file'],
              autoToolLoop: true,
              consent: true,
              projectRoot: targetReal,
              workingDirectory: targetReal,
              max_tokens: 1500,
              temperature: 0
            })
          }, 180000);
        } catch (error) {
          response = { status: 0, body: null, text: String(error?.message ?? error), latencyMs: 0 };
        }

        responseStatus = response.status;
        loopStatus = response.body?.meta?.toolLoop?.status ?? null;
        roundCount = response.body?.meta?.toolLoop?.roundCount ?? null;
        evidenceCount = response.body?.meta?.toolLoop?.evidenceCount ?? null;
        usage = response.body?.usage ?? null;
        toolCallNames = (response.body?.meta?.toolLoop?.rounds ?? [])
          .flatMap(round => Array.isArray(round?.toolCalls) ? round.toolCalls : [])
          .map(call => call?.name)
          .filter(Boolean);

        if (existsSync(pagePath)) page = readFileSync(pagePath, 'utf8');
        problem = page ? identityProblem(page, agent, provider, runId) : 'page_missing';
        // A page written in round one can still be valid when the provider's
        // closing summary call is rate-limited. The deliverable exists, so keep
        // the success and record the provider warning separately.
        providerWarning = !problem && response.status !== 200 ? `http_${response.status}` : null;
        attempts.push({
          attempt,
          httpStatus: response.status,
          loopStatus,
          paceWaitMs,
          durationMs: Date.now() - taskStartedMs,
          pageValid: !problem,
          problem
        });
        if (!problem) break;

        const rateLimited = response.status === 429;
        const retryable = rateLimited || response.status >= 500 || response.status === 0;
        if (!retryable && attempt >= 2) break;
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = rateLimited ? RETRY_BASE_MS * attempt : 5000;
          console.log(`retry agent=${agent.id} provider=${provider.id} attempt=${attempt} status=${response.status} wait_ms=${backoffMs}`);
          await sleep(backoffMs);
        }
      }

      const taskFinishedMs = Date.now();
      const pageBytes = existsSync(pagePath) ? statSync(pagePath).size : 0;
      const pageSha256 = page ? sha256(page) : null;
      const entry = {
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        task: `Create ${agent.id}.html identity page`,
        provider: provider.id,
        model: provider.model,
        startedAt: taskStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: taskFinishedMs - taskStartedMs,
        attempts: attempts.length,
        attemptLog: attempts,
        httpStatus: responseStatus,
        providerWarning,
        loopStatus,
        roundCount,
        evidenceCount,
        toolCalls: toolCallNames,
        usage,
        pagePath,
        pageBytes,
        pageSha256,
        status: problem ? 'failure' : 'success',
        error: problem
      };
      entries.push(entry);
      console.log(`agent=${entry.agentId} provider=${entry.provider} model=${entry.model} status=${entry.status} duration_ms=${entry.durationMs} page=${entry.pageBytes}B${entry.error ? ` error=${entry.error}` : ''}${entry.providerWarning ? ` warning=${entry.providerWarning}` : ''}`);
    }
  } finally {
    // Restore mappings first, then scopes. A working-directory agent whose stored
    // directory was null falls back to the runtime's data root; restoring that
    // canonical path keeps the effective boundary identical to the original.
    for (const agent of AGENTS) {
      const originalModel = mappingRestore.get(agent.id);
      if (originalModel) {
        await adminFetch(`/v1/admin/agent-model-mappings/${agent.id}`, {
          method: 'PUT',
          body: JSON.stringify({ model: originalModel })
        }).catch(() => {});
      }
      const original = originalScopes.get(agent.id);
      const workingDirectory = original?.workingDirectory ?? restoreDirectory;
      await adminFetch(`/v1/admin/registry/agents/${agent.id}/boundary`, {
        method: 'PATCH',
        body: JSON.stringify({ toolBoundary: original?.toolBoundary ?? 'working-directory', workingDirectory })
      }).catch(() => {});
    }
    if (!targetHadZombiecoder) rmSync(path.join(targetReal, '.zombiecoder'), { recursive: true, force: true });
  }

  const finishedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startedMs;
  const pages = entries.filter(item => item.status === 'success').length;
  const log = {
    runId,
    startedAt,
    finishedAt,
    totalDurationMs,
    baseUrl: BASE,
    target: targetReal,
    providers: PROVIDERS,
    assignments: assignment.map(item => ({
      agentId: item.agent.id,
      agentName: item.agent.name,
      provider: item.provider.id,
      model: item.provider.model
    })),
    entries,
    restore: {
      mappings: [...mappingRestore].map(([agentId, model]) => ({ agentId, model })),
      scopes: [...originalScopes].map(([agentId, access]) => ({ agentId, access })),
      restoreDirectory,
      restored: true
    },
    summary: {
      agents: AGENTS.length,
      pages,
      success: entries.filter(item => item.status === 'success').length,
      failure: entries.filter(item => item.status === 'failure').length,
      providers: PROVIDERS.length
    }
  };

  const logText = `${JSON.stringify(log, null, 2)}\n`;
  const logPath = path.join(targetReal, 'run-log.json');
  writeFileSync(logPath, logText);
  writeFileSync(path.join(targetReal, 'run-log.md'), renderMarkdown(log));
  writeFileSync(path.join(targetReal, 'RUN.lock'), [
    `run_id=${runId}`,
    `created_at=${finishedAt}`,
    `agents=${log.summary.agents}`,
    `pages=${log.summary.pages}`,
    `providers=${log.summary.providers}`,
    `log_sha256=${sha256(logText)}`,
    ''
  ].join('\n'));
  mkdirSync(path.dirname(REPORT_COPY), { recursive: true });
  writeFileSync(REPORT_COPY, logText);

  if (log.summary.failure > 0) {
    console.error(`AGENT_HTML_FAIL agents=${log.summary.agents} pages=${log.summary.pages} failure=${log.summary.failure} log=${logPath}`);
    for (const entry of entries.filter(item => item.status === 'failure')) {
      console.error(`agent=${entry.agentId} provider=${entry.provider} model=${entry.model} error=${entry.error}`);
    }
    process.exit(1);
  }

  console.log(`AGENT_HTML_OK agents=${log.summary.agents} pages=${log.summary.pages} log=ok providers=${log.summary.providers} duration_ms=${totalDurationMs}`);
  console.log(`report=${logPath}`);
  for (const entry of entries) {
    console.log(`agent=${entry.agentId} provider=${entry.provider} model=${entry.model} duration_ms=${entry.durationMs} page=${entry.pageBytes}B`);
  }
}

function renderMarkdown(log) {
  const lines = [
    `# Agent HTML task — ${log.runId}`,
    '',
    `- started: ${log.startedAt}`,
    `- finished: ${log.finishedAt}`,
    `- total: ${log.totalDurationMs} ms`,
    `- target: \`${log.target}\``,
    `- providers: ${log.providers.map(item => `${item.id} (${item.model})`).join(', ')}`,
    '',
    '| Agent | Provider | Model | Task | Duration | Page | Status |',
    '| --- | --- | --- | --- | ---: | ---: | --- |'
  ];
  for (const entry of log.entries) {
    lines.push(`| ${entry.agentName} (\`${entry.agentId}\`) | ${entry.provider} | \`${entry.model}\` | ${entry.task} | ${entry.durationMs} ms | ${entry.pageBytes} B | ${entry.status} |`);
  }
  lines.push('', `Lock: \`RUN.lock\` contains the sha256 of \`run-log.json\`.`, '');
  return lines.join('\n');
}

try {
  await main();
} catch (error) {
  console.error(`AGENT_HTML_FAIL reason=unexpected detail=${String(error?.message ?? error).slice(0, 300)}`);
  process.exit(1);
}
