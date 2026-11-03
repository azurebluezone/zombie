#!/usr/bin/env node
// Contract check for the audit audio: the file must be a real MP3, longer than
// two minutes and large enough to hold actual speech. ffprobe is the judge; the
// script does not trust the filename extension.
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('AUDIO_FAIL reason=missing_path');
  process.exit(2);
}

const absolute = path.resolve(target);
let stat;
try {
  stat = statSync(absolute);
} catch {
  console.error(`AUDIO_FAIL reason=file_not_found file=${absolute}`);
  process.exit(1);
}

const probe = spawnSync('ffprobe', [
  '-v', 'error',
  '-select_streams', 'a:0',
  '-show_entries', 'stream=codec_name,codec_type:format=format_name,duration',
  '-of', 'json',
  absolute,
], { encoding: 'utf8' });

if (probe.error || probe.status !== 0) {
  console.error(`AUDIO_FAIL reason=ffprobe_failed detail=${(probe.stderr || probe.error?.message || '').trim().slice(0, 200)}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(probe.stdout);
} catch {
  console.error('AUDIO_FAIL reason=ffprobe_output_not_json');
  process.exit(1);
}

const stream = parsed.streams?.[0] ?? {};
const format = parsed.format ?? {};
const duration = Number(format.duration ?? stream.duration ?? 0);
const codec = String(stream.codec_name ?? '');
const formatName = String(format.format_name ?? '');
const size = stat.size;

const problems = [];
if (stream.codec_type !== 'audio') problems.push('no_audio_stream');
if (codec !== 'mp3') problems.push(`codec=${codec || 'none'}`);
if (!formatName.split(',').includes('mp3')) problems.push(`container=${formatName || 'none'}`);
if (!Number.isFinite(duration) || duration <= 120) problems.push(`duration=${duration}`);
if (size <= 100 * 1024) problems.push(`size=${size}`);

if (problems.length > 0) {
  console.error(`AUDIO_FAIL reason=${problems.join(',')} file=${absolute}`);
  process.exit(1);
}

console.log(`AUDIO_OK codec=mp3 duration_gt=120 file=${absolute}`);
console.log(`audio_probe codec=${codec} container=${formatName} duration_s=${duration.toFixed(1)} bytes=${size}`);
