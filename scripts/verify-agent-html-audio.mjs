#!/usr/bin/env node
'use strict';

// Release check for the Bengali agent HTML status audio. It trusts ffprobe and
// the files on disk, not the generator's claim: the MP3, transcript, SRT, hash
// sidecar, manifest and the locked run log must all agree.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TARGET = process.env.AGENT_HTML_AUDIO_DIR || '/home/sahon/Music/work mp3/task';
const BASE_NAME = process.env.AGENT_HTML_AUDIO_BASE || 'zombiecoder-agent-html-status-20261103';
const MP3 = path.join(TARGET, `${BASE_NAME}.mp3`);
const TRANSCRIPT = path.join(TARGET, `${BASE_NAME}.transcript.txt`);
const SRT = path.join(TARGET, `${BASE_NAME}.srt`);
const SHA = path.join(TARGET, `${BASE_NAME}.sha256`);
const MANIFEST = path.join(TARGET, `${BASE_NAME}.json`);
const LOG = path.join(TARGET, 'run-log.json');
const LOCK = path.join(TARGET, 'RUN.lock');

function fail(reason, detail = '') {
  console.error(`AUDIO_FAIL reason=${reason}${detail ? ` detail=${detail}` : ''}`);
  process.exit(1);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function probe(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels:format=duration,size,format_name',
    '-of', 'json',
    file
  ], { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) {
    fail('ffprobe_failed', String(result.stderr || result.error?.message || '').trim().slice(0, 200));
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('ffprobe_output_not_json');
  }
  const stream = parsed.streams?.find((item) => item.codec_type === 'audio') ?? {};
  const format = parsed.format ?? {};
  return {
    codec: String(stream.codec_name ?? ''),
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: Number(stream.channels ?? 0),
    durationS: Number(format.duration ?? 0),
    bytes: Number(format.size ?? statSync(file).size),
    formatName: String(format.format_name ?? '')
  };
}

function parseSrt(text) {
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) continue;
    const start = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
    const end = Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(match[8]) / 1000;
    const textLines = lines.slice(timeIndex + 1).join('\n').trim();
    if (!textLines) continue;
    cues.push({ start, end, text: textLines });
  }
  return cues;
}

function main() {
  for (const file of [MP3, TRANSCRIPT, SRT, SHA, MANIFEST, LOG, LOCK]) {
    if (!existsSync(file)) fail('file_missing', file);
    if (statSync(file).size <= 0) fail('file_empty', file);
  }

  const audio = probe(MP3);
  if (audio.codec !== 'mp3') fail('codec_mismatch', audio.codec || 'none');
  if (!audio.formatName.split(',').includes('mp3')) fail('container_mismatch', audio.formatName || 'none');
  if (!Number.isFinite(audio.durationS) || audio.durationS < 120) fail('duration_too_short', String(audio.durationS));
  if (audio.bytes <= 100 * 1024) fail('audio_too_small', String(audio.bytes));

  const lockText = readFileSync(LOCK, 'utf8');
  const lockHash = lockText.match(/^log_sha256=([a-f0-9]{64})$/m)?.[1];
  if (!lockHash) fail('lock_hash_missing');
  const logText = readFileSync(LOG, 'utf8');
  const logHash = sha256(logText);
  if (logHash !== lockHash) fail('lock_hash_mismatch', `lock=${lockHash} actual=${logHash}`);

  let log;
  try {
    log = JSON.parse(logText);
  } catch {
    fail('run_log_not_json');
  }
  if (log.summary?.agents !== 12) fail('agent_count_mismatch', String(log.summary?.agents));
  if (log.summary?.pages !== 12) fail('page_count_mismatch', String(log.summary?.pages));
  if (log.summary?.failure !== 0) fail('failure_count_mismatch', String(log.summary?.failure));
  if (log.summary?.providers !== 3) fail('provider_count_mismatch', String(log.summary?.providers));
  if (!Array.isArray(log.entries) || log.entries.length !== 12) fail('entries_mismatch', String(log.entries?.length));

  const transcriptText = readFileSync(TRANSCRIPT, 'utf8');
  const required = ['12/12', 'providers=3', 'RUN.lock', lockHash, 'AGENT_HTML_OK', 'b266b2d', '452/452', 'qwen2.5-0.5b'];
  for (const needle of required) {
    if (!transcriptText.includes(needle)) fail('transcript_missing_fact', needle);
  }

  const srtText = readFileSync(SRT, 'utf8');
  const cues = parseSrt(srtText);
  if (cues.length === 0) fail('srt_has_no_cues');
  const lastEnd = Math.max(...cues.map((cue) => cue.end));
  if (!Number.isFinite(lastEnd) || lastEnd <= 0) fail('srt_last_cue_invalid', String(lastEnd));
  if (lastEnd > audio.durationS + 0.5) fail('srt_last_cue_after_audio', `last=${lastEnd.toFixed(3)} duration=${audio.durationS.toFixed(3)}`);

  const audioHash = sha256(readFileSync(MP3));
  const shaText = readFileSync(SHA, 'utf8');
  const sidecarHash = shaText.match(/^([a-f0-9]{64})\b/m)?.[1];
  if (!sidecarHash) fail('sha_sidecar_hash_missing');
  if (sidecarHash !== audioHash) fail('sha_sidecar_mismatch', `sidecar=${sidecarHash} actual=${audioHash}`);

  const transcriptHash = sha256(readFileSync(TRANSCRIPT));
  const srtHash = sha256(readFileSync(SRT));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch {
    fail('manifest_not_json');
  }
  if (manifest.runId !== log.runId) fail('manifest_run_id_mismatch', String(manifest.runId));
  if (manifest.voice !== 'bn-BD-NabanitaNeural') fail('manifest_voice_mismatch', String(manifest.voice));
  if (manifest.audio?.sha256 !== audioHash) fail('manifest_audio_sha_mismatch');
  if (Math.abs(Number(manifest.audio?.durationS) - audio.durationS) > 0.5) fail('manifest_duration_mismatch', `manifest=${manifest.audio?.durationS} actual=${audio.durationS}`);
  if (manifest.audio?.bytes !== statSync(MP3).size) fail('manifest_audio_bytes_mismatch', `${manifest.audio?.bytes} != ${statSync(MP3).size}`);
  if (manifest.transcript?.sha256 !== transcriptHash) fail('manifest_transcript_sha_mismatch');
  if (manifest.srt?.sha256 !== srtHash) fail('manifest_srt_sha_mismatch');
  if (manifest.srt?.cues !== cues.length) fail('manifest_cue_count_mismatch', `${manifest.srt?.cues} != ${cues.length}`);
  if (manifest.lockSha256 !== lockHash) fail('manifest_lock_mismatch');
  if (manifest.pages !== 12) fail('manifest_pages_mismatch', String(manifest.pages));
  if (manifest.providers !== 3) fail('manifest_providers_mismatch', String(manifest.providers));

  console.log(`AUDIO_OK codec=mp3 duration_s>=120 run=${log.runId} pages=12 providers=3`);
  console.log(`file=${MP3}`);
  console.log(`duration_s=${audio.durationS.toFixed(1)} bytes=${statSync(MP3).size} sha256=${audioHash}`);
  console.log(`transcript=${TRANSCRIPT}`);
  console.log(`srt=${SRT} cues=${cues.length} last_cue_s=${lastEnd.toFixed(1)}`);
}

try {
  main();
} catch (error) {
  fail('unexpected', String(error?.message ?? error).slice(0, 300));
}
