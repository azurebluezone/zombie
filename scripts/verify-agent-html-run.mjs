#!/usr/bin/env node
'use strict';

// Release check for the agent HTML task. It verifies the files the operator asked
// for, not the harness's own claim: every page is read from disk, its hash is
// recomputed, the lock is recomputed from run-log.json, and the live admin API is
// asked whether the original mappings and effective scopes are back.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.AGENT_HTML_BASE_URL || 'http://127.0.0.1:9999';
const TARGET = process.env.AGENT_HTML_TARGET || '/home/sahon/Music/work mp3/task';

function fail(reason, detail = '') {
  console.error(`AGENT_HTML_FAIL reason=${reason}${detail ? ` ${detail}` : ''}`);
  process.exit(1);
}

function readEnv(name) {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(item => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

const ADMIN_TOKEN = readEnv('ADMIN_TOKEN');
if (!ADMIN_TOKEN) fail('admin_token_missing');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function adminFetch(pathname, timeoutMs = 15000) {
  const response = await fetch(`${BASE}${pathname}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

async function main() {
  const target = realpathSync(TARGET);
  const logPath = path.join(target, 'run-log.json');
  const lockPath = path.join(target, 'RUN.lock');
  if (!existsSync(logPath)) fail('run_log_missing', logPath);
  if (!existsSync(lockPath)) fail('run_lock_missing', lockPath);

  const logText = readFileSync(logPath, 'utf8');
  const log = JSON.parse(logText);
  const lock = readFileSync(lockPath, 'utf8');
  const lockHash = lock.match(/^log_sha256=([a-f0-9]{64})$/m)?.[1];
  if (!lockHash) fail('lock_hash_missing');
  if (lockHash !== sha256(logText)) fail('lock_hash_mismatch', `lock=${lockHash} actual=${sha256(logText)}`);

  if (log.summary?.agents !== 12) fail('agent_count_mismatch', `got=${log.summary?.agents}`);
  if (log.summary?.pages !== 12) fail('page_count_mismatch', `got=${log.summary?.pages}`);
  if (log.summary?.failure !== 0) fail('agent_failures', `got=${log.summary?.failure}`);
  if (log.summary?.providers !== 3) fail('provider_count_mismatch', `got=${log.summary?.providers}`);
  if (!Array.isArray(log.entries) || log.entries.length !== 12) fail('entries_mismatch', `got=${log.entries?.length}`);

  const seen = new Set();
  const providerIds = new Set((log.providers ?? []).map(item => item.id));
  for (const entry of log.entries) {
    if (seen.has(entry.agentId)) fail('duplicate_agent', entry.agentId);
    seen.add(entry.agentId);
    if (entry.status !== 'success') fail('entry_not_success', `${entry.agentId}:${entry.error ?? 'unknown'}`);
    if (!entry.provider || !providerIds.has(entry.provider)) fail('entry_provider_invalid', entry.agentId);
    if (!entry.model) fail('entry_model_missing', entry.agentId);
    if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0) fail('entry_duration_invalid', entry.agentId);
    if (!Number.isFinite(entry.pageBytes) || entry.pageBytes <= 0) fail('entry_page_bytes_invalid', entry.agentId);

    const pagePath = path.join(target, `${entry.agentId}.html`);
    if (!existsSync(pagePath)) fail('page_missing', `${entry.agentId}:${pagePath}`);
    const page = readFileSync(pagePath, 'utf8');
    if (entry.pageSha256 !== sha256(page)) fail('page_hash_mismatch', entry.agentId);
    if (entry.pageBytes !== Buffer.byteLength(page)) fail('page_size_mismatch', entry.agentId);
    const lower = page.toLowerCase();
    if (!page.includes(entry.agentId)) fail('page_missing_agent_id', entry.agentId);
    if (!page.includes(entry.agentName)) fail('page_missing_agent_name', entry.agentId);
    if (!lower.includes(entry.provider.toLowerCase())) fail('page_missing_provider', entry.agentId);
    if (!lower.includes(entry.model.toLowerCase())) fail('page_missing_model', entry.agentId);
    if (!page.includes(log.runId)) fail('page_missing_run_id', entry.agentId);
  }
  if (seen.size !== 12) fail('unique_agent_count_mismatch', `got=${seen.size}`);

  // The harness restores mappings and scopes in `finally`. Verify the live state,
  // not the restore section of the log it wrote.
  const mappings = await adminFetch('/v1/admin/agent-model-mappings');
  if (mappings.status !== 200) fail('mapping_read_failed', `status=${mappings.status}`);
  const liveMappings = new Map((mappings.body?.mappings ?? []).map(item => [item.agentId, item.model]));
  const expectedMappings = new Map((log.restore?.mappings ?? []).map(item => [item.agentId, item.model]));
  for (const entry of log.entries) {
    const expected = expectedMappings.get(entry.agentId);
    if (expected && liveMappings.get(entry.agentId) !== expected) {
      fail('mapping_not_restored', `${entry.agentId} expected=${expected} live=${liveMappings.get(entry.agentId)}`);
    }
  }

  const restoreDirectory = log.restore?.restoreDirectory;
  if (!restoreDirectory) fail('restore_directory_missing');
  for (const entry of log.entries) {
    const boundary = await adminFetch(`/v1/admin/registry/agents/${entry.agentId}/boundary`);
    if (boundary.status !== 200) fail('boundary_read_failed', `${entry.agentId} status=${boundary.status}`);
    const effective = boundary.body?.effective;
    if (effective?.toolBoundary !== 'working-directory') fail('boundary_mode_not_restored', entry.agentId);
    if (effective?.projectRoot !== restoreDirectory) {
      fail('boundary_not_restored', `${entry.agentId} expected=${restoreDirectory} live=${effective?.projectRoot}`);
    }
  }

  const providers = new Set(log.entries.map(entry => entry.provider));
  if (providers.size !== 3) fail('provider_spread_mismatch', `got=${[...providers].join(',')}`);

  console.log(`AGENT_HTML_OK agents=12 pages=12 log=ok providers=3 run=${log.runId}`);
  console.log(`target=${target}`);
  console.log(`lock_sha256=${lockHash}`);
}

try {
  await main();
} catch (error) {
  fail('unexpected', String(error?.message ?? error).slice(0, 300));
}
