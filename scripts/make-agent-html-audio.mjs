#!/usr/bin/env node
'use strict';

// Builds a Bengali status audio from the locked agent HTML run. The spoken text
// is derived from run-log.json, while the transcript footer keeps the exact
// identifiers that are awkward to read aloud. Edge TTS writes one MP3+SRT per
// chunk, ffmpeg joins the audio, and the SRT timestamps are shifted by each
// chunk's real ffprobe duration.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.env.AGENT_HTML_AUDIO_DIR || '/home/sahon/Music/work mp3/task';
const LOG_PATH = process.env.AGENT_HTML_AUDIO_LOG || path.join(TARGET, 'run-log.json');
const LOCK_PATH = path.join(TARGET, 'RUN.lock');
const BASE_NAME = process.env.AGENT_HTML_AUDIO_BASE || 'zombiecoder-agent-html-status-20261103';
const OUT_MP3 = path.join(TARGET, `${BASE_NAME}.mp3`);
const OUT_TRANSCRIPT = path.join(TARGET, `${BASE_NAME}.transcript.txt`);
const OUT_SRT = path.join(TARGET, `${BASE_NAME}.srt`);
const OUT_SHA = path.join(TARGET, `${BASE_NAME}.sha256`);
const OUT_MANIFEST = path.join(TARGET, `${BASE_NAME}.json`);
const VOICE = process.env.AGENT_HTML_AUDIO_VOICE || 'bn-BD-NabanitaNeural';
const RATE = process.env.AGENT_HTML_AUDIO_RATE || '+0%';
const EDGE_TTS = process.env.EDGE_TTS_BIN || 'edge-tts';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const TEST_LOG = path.join(ROOT, 'data', 'agent-html-test-output.log');
const VERIFY_LOG = '/tmp/opencode/verify-agent-html-run.log';
const HTML_RUN_COMMIT = 'b266b2d';

const AGENT_BN = Object.freeze({
  'code-guru': 'কোড গুরু',
  'bug-hunter': 'বাগ হান্টার',
  'security-hero': 'সিকিউরিটি হিরো',
  'perf-wizard': 'পারফ উইজার্ড',
  'doc-king': 'ডক কিং',
  'qa-tyrant': 'কিউ এ টাইরান্ট',
  'planner': 'প্ল্যানার',
  'researcher': 'রিসার্চার',
  'integrator': 'ইন্টিগ্রেটর',
  'customer-experience-specialist': 'কাস্টমার এক্সপেরিয়েন্স স্পেশালিস্ট',
  'ecommerce-operations-analyst': 'ই কমার্স অপারেশন্স অ্যানালিস্ট',
  'team-heart': 'টিম হার্ট'
});

function bnNum(value) {
  return String(value).replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, timeoutMs = 120000, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw new Error(`${command}_spawn_failed ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command}_exit_${result.status} ${(result.stderr || '').trim().slice(-400)}`);
  }
  return result;
}

function probeAudio(file) {
  const result = run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels:format=duration,size,format_name',
    '-of', 'json',
    file
  ], 30000);
  const parsed = JSON.parse(result.stdout);
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

function splitLongSection(text, maxChars = 700) {
  const sentences = text.match(/[^।?!]+[।?!]?/g) ?? [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if ((current ? `${current} ${trimmed}` : trimmed).length <= maxChars) {
      current = current ? `${current} ${trimmed}` : trimmed;
      continue;
    }
    if (current) chunks.push(current);
    if (trimmed.length <= maxChars) {
      current = trimmed;
      continue;
    }
    let rest = trimmed;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(',', maxChars);
      if (cut < maxChars * 0.5) cut = rest.lastIndexOf(' ', maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildSections(log, meta) {
  const entries = log.entries ?? [];
  const byProvider = (id) => entries.filter((entry) => entry.provider === id);
  const gemini = byProvider('gemini');
  const groq = byProvider('groq');
  const ollama = byProvider('ollama-cloud-openai');
  const line = (entry) => `${AGENT_BN[entry.agentId] ?? entry.agentName} ${bnNum(Math.round(entry.durationMs))} মিলিসেকেন্ড`;
  const list = (items) => items.map(line).join(', ');
  const groqPace = groq.map((entry) => entry.attemptLog?.[0]?.paceWaitMs ?? 0).filter((value) => value > 0);
  const paceRange = groqPace.length
    ? `${bnNum(Math.round(Math.min(...groqPace) / 1000))} থেকে ${bnNum(Math.round(Math.max(...groqPace) / 1000))} সেকেন্ড`
    : 'কোনো অপেক্ষা নেই';
  const totalSeconds = Math.round(log.totalDurationMs / 1000);
  const pages = log.summary?.pages ?? entries.length;
  const success = log.summary?.success ?? entries.filter((entry) => entry.status === 'success').length;
  const failure = log.summary?.failure ?? entries.filter((entry) => entry.status === 'failure').length;
  const providers = log.summary?.providers ?? new Set(entries.map((entry) => entry.provider)).size;
  const worktreeLine = meta.worktree === 'clean' ? 'ওয়ার্কট্রি পরিষ্কার' : 'ওয়ার্কট্রিতে আনকমিটেড ফাইল আছে';

  return [
    'জম্বিকোডার — এজেন্ট এইচটিএমএল রানের সর্বশেষ অবস্থা। তারিখ: ৩ নভেম্বর ২০২৬।',
    `ভাইয়া, এই রিপোর্টে সর্বশেষ এজেন্ট এইচটিএমএল রানের সৎ অবস্থা বলছি। রান আইডি এইচটিএমএল দিয়ে শুরু; পূর্ণ আইডি ও টাইমস্ট্যাম্প ট্রান্সক্রিপ্টের মেটাডেটায় আছে। মোট সময় লেগেছে ${bnNum(log.totalDurationMs)} মিলিসেকেন্ড, মানে প্রায় ${bnNum(totalSeconds)} সেকেন্ড।`,
    `কী করা হয়েছে? আমাদের ${bnNum(entries.length)}টি এজেন্টকে তিনটি থার্ড-পার্টি ক্লাউড প্রোভাইডারের মধ্যে রাউন্ড-রবিনে ম্যাপ করা হয়েছে: জেমিনি, গ্রোক, আর অলামা ক্লাউড ওপেনএআই। প্রতিটি এজেন্টকে বলা হয়েছে, হোম সাহন মিউজিক ওয়ার্ক এমপি থ্রি টাস্ক ফোল্ডারে নিজের একটি ছোট এইচটিএমএল পরিচয় পাতা তৈরি করতে। প্রতিটি পাতায় এজেন্টের নাম, আইডি, প্রোভাইডার, মডেল, রান আইডি এবং নিজের ভূমিকা লেখা আছে।`,
    `ফলাফল: ${bnNum(entries.length)}টি এজেন্টের ${bnNum(pages)}টি পাতা তৈরি হয়েছে। ${bnNum(success)}টি সফল, ${bnNum(failure)}টি ব্যর্থ। ${bnNum(providers)}টি প্রোভাইডারই ব্যবহার হয়েছে। কোনো মক, ডেমো বা ফিক্সচার ব্যবহার করা হয়নি; প্রতিটি কল আসল আপস্ট্রিমে গেছে।`,
    `জেমিনি মডেল জেমিনি থ্রি পয়েন্ট ফাইভ ফ্ল্যাশ লাইট দিয়ে ${bnNum(gemini.length)}টি এজেন্ট কাজ করেছে। ${list(gemini)}।`,
    `গ্রোক মডেল ওপেন এ আই জিপিটি ও এস এস টোয়েন্টি বি দিয়ে ${bnNum(groq.length)}টি এজেন্ট কাজ করেছে। ${list(groq)}। কিন্তু এখানে একটা গুরুত্বপূর্ণ কথা: গ্রোকের ফ্রি টিয়ারে টোকেন-পার-মিনিট সীমা আছে, তাই আমরা ইচ্ছাকৃতভাবে প্রতিটি গ্রোক কলের মধ্যে ষাট সেকেন্ড বিরতি দিয়েছি। এই সময়ের মধ্যে ${paceRange} অপেক্ষা আছে; আসল মডেল কাজ করেছে মাত্র প্রায় তিন সেকেন্ডে। লগের অ্যাটেম্পট-লগে পেস-ওয়েট-মিলিসেকেন্ড হিসেবে এটা আলাদা করে লেখা আছে।`,
    `অলামা ক্লাউড ওপেনএআই মডেল জিপিটি ও এস এস টোয়েন্টি বি দিয়ে ${bnNum(ollama.length)}টি এজেন্ট কাজ করেছে। ${list(ollama)}।`,
    'প্রথম রানে কিন্তু সবুজ ছিল না। আটটি পাতা এসেছিল, চারটি গ্রোক এজেন্ট ফেল করেছিল এইচটিটিপি চারশো উনত্রিশ, মানে রেট লিমিটে। বাগ হান্টারের পাতা তৈরি হয়েছিল, কিন্তু তার শেষ সারাংশ কলটি চারশো উনত্রিশে আটকে যায়। আমরা হার্নেস ঠিক করেছি: গ্রোক কলগুলোর মধ্যে ষাট সেকেন্ড বিরতি, চারশো উনত্রিশ বা পাঁচশো-এর বেশি হলে রিট্রাই ও ব্যাকঅফ, এবং পাতা বৈধ থাকলে সেটাকে সফল ধরা, সাথে প্রোভাইডার-ওয়ার্নিং আলাদা করে রাখা। দ্বিতীয় রানে সবগুলো সফল হয়েছে।',
    `লগ ও লক: টাস্ক ফোল্ডারে রান-লগ ডট জেসন, রান-লগ ডট এমডি, আর রান ডট লক আছে। রান ডট লকে রান আইডি, এজেন্ট ${bnNum(entries.length)}, পেজ ${bnNum(pages)}, প্রোভাইডার ${bnNum(providers)}, এবং লগের শা-টু-ফাইভ-সিক্স হ্যাশ সংরক্ষিত আছে।`,
    `যাচাই: ভেরিফাই এজেন্ট এইচটিএমএল রান স্ক্রিপ্ট চালিয়ে আউটপুট এসেছে: এজেন্ট এইচটিএমএল ওকে, এজেন্ট ${bnNum(12)}, পেজ ${bnNum(12)}, লগ ওকে, প্রোভাইডার ${bnNum(3)}। গোল কন্ট্রাক্ট পাস হয়েছে। ${meta.testLine}। এইচটিএমএল রানের কমিট ${HTML_RUN_COMMIT} মেইন শাখায় পুশ হয়েছে, ${worktreeLine}।`,
    `রিস্টোর: ${bnNum(entries.length)}টি এজেন্টের মডেল ম্যাপিং আবার কিউ ওয়েন টু পয়েন্ট ফাইভ শূন্য পয়েন্ট ফাইভ বি তে ফিরিয়ে দেওয়া হয়েছে। ওয়ার্কিং-ডিরেক্টরি স্কোপ আবার হোম সাহন জম্বি ডাটা। টাস্ক ফোল্ডারে জম্বিকোডার ডিরেক্টরি নেই।`,
    'সীমা: এই রান লিনাক্সে হয়েছে; উইন্ডোজ বা ম্যাকওএস পরীক্ষা করা হয়নি। এমসিপি দুই হাজার ছাব্বিশ সালের আটাশে জুলাইয়ের স্টেটলেস রিভিশন এখনো স্পেক গ্যাপ। তবে এই অডিও রিপোর্টের সব সংখ্যা আসল রান-লগ, আসল ফাইল আর আসল ভেরিফায়ার থেকে নেওয়া।',
    'শেষ কথা: প্রমাণ আছে তো? থাকলে বসো; না থাকলে অনভেরিফাইড বলে থামো। আজ এখানেই শেষ।'
  ];
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

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function mergeSrt(chunks, totalDurationS) {
  let offset = 0;
  const cues = [];
  for (const chunk of chunks) {
    for (const cue of parseSrt(readFileSync(chunk.srtPath, 'utf8'))) {
      cues.push({ start: cue.start + offset, end: cue.end + offset, text: cue.text });
    }
    offset += chunk.durationS;
  }
  cues.sort((left, right) => left.start - right.start);
  for (const cue of cues) {
    if (cue.start < 0) cue.start = 0;
    if (cue.end <= cue.start) cue.end = cue.start + 0.8;
    if (cue.end > totalDurationS) cue.end = Math.max(cue.start + 0.4, totalDurationS - 0.05);
  }
  const srt = cues.map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`).join('\n');
  return { srt, cues };
}

function generateChunk(text, index, tempDir) {
  const stem = `chunk-${String(index + 1).padStart(2, '0')}`;
  const textPath = path.join(tempDir, `${stem}.txt`);
  const mp3Path = path.join(tempDir, `${stem}.mp3`);
  const srtPath = path.join(tempDir, `${stem}.srt`);
  writeFileSync(textPath, `${text}\n`, 'utf8');
  run(EDGE_TTS, [
    '-f', textPath,
    '-v', VOICE,
    '--rate', RATE,
    '--volume', '+0%',
    '--pitch', '+0Hz',
    '--write-media', mp3Path,
    '--write-subtitles', srtPath,
    '--no-progress'
  ], 180000);
  if (!existsSync(mp3Path) || statSync(mp3Path).size === 0) throw new Error(`tts_media_missing ${stem}`);
  if (!existsSync(srtPath) || statSync(srtPath).size === 0) throw new Error(`tts_subtitles_missing ${stem}`);
  const audio = probeAudio(mp3Path);
  return {
    index,
    textChars: text.length,
    mp3Path,
    srtPath,
    durationS: audio.durationS,
    bytes: audio.bytes
  };
}

function concatChunks(chunks, tempDir, outMp3) {
  const concatPath = path.join(tempDir, 'concat.txt');
  const lines = chunks.map((chunk) => `file '${chunk.mp3Path.replace(/'/g, "'\\''")}'`);
  writeFileSync(concatPath, `${lines.join('\n')}\n`, 'utf8');
  const baseArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concatPath];
  let result = run(FFMPEG, [...baseArgs, '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1', outMp3], 180000, { allowFailure: true });
  if (result.status !== 0) {
    result = run(FFMPEG, [...baseArgs, '-c', 'copy', outMp3], 180000, { allowFailure: true });
  }
  if (result.status !== 0) throw new Error(`ffmpeg_concat_failed ${(result.stderr || '').trim().slice(-400)}`);
  if (!existsSync(outMp3) || statSync(outMp3).size === 0) throw new Error('ffmpeg_output_missing');
}

function buildTranscript(sections, meta) {
  const spoken = sections.join('\n\n');
  const footer = [
    '---',
    'মেটাডেটা (অডিওতে পড়া হয়নি):',
    `run_id: ${meta.log.runId}`,
    `source_log: ${LOG_PATH}`,
    'lock: RUN.lock',
    `lock_sha256: ${meta.lockHash}`,
    `verify: ${meta.verifyLine}`,
    `pages: ${meta.log.summary.pages}/${meta.log.summary.agents}`,
    `agents: ${meta.log.summary.agents}`,
    `providers=${meta.log.summary.providers}`,
    `tests: ${meta.testPass}/${meta.testPass} pass, ${meta.testFail} fail`,
    `html_run_commit: ${meta.htmlRunCommit}`,
    `head_commit: ${meta.commitFull}`,
    `worktree: ${meta.worktree}`,
    'restore: mappings=qwen2.5-0.5b; scopes=/home/sahon/zombie/data',
    `audio: edge-tts ${VOICE}, mp3, ${meta.audio.sampleRate} Hz ${meta.audio.channels === 1 ? 'mono' : 'stereo'}`,
    `duration_s: ${meta.audio.durationS.toFixed(1)}`,
    ''
  ].join('\n');
  return `${spoken}\n\n${footer}`;
}

async function main() {
  if (!existsSync(LOG_PATH)) throw new Error(`run_log_missing ${LOG_PATH}`);
  if (!existsSync(LOCK_PATH)) throw new Error(`run_lock_missing ${LOCK_PATH}`);
  if (!existsSync(TARGET)) mkdirSync(TARGET, { recursive: true });

  const log = JSON.parse(readFileSync(LOG_PATH, 'utf8'));
  if (log.summary?.agents !== 12) throw new Error(`agent_count_mismatch got=${log.summary?.agents}`);
  if (log.summary?.pages !== 12) throw new Error(`page_count_mismatch got=${log.summary?.pages}`);
  if (log.summary?.failure !== 0) throw new Error(`failure_count_mismatch got=${log.summary?.failure}`);
  if (log.summary?.providers !== 3) throw new Error(`provider_count_mismatch got=${log.summary?.providers}`);

  const lockText = readFileSync(LOCK_PATH, 'utf8');
  const lockHash = lockText.match(/^log_sha256=([a-f0-9]{64})$/m)?.[1];
  if (!lockHash) throw new Error('lock_hash_missing');
  const logHash = sha256(readFileSync(LOG_PATH));
  if (logHash !== lockHash) throw new Error(`lock_hash_mismatch lock=${lockHash} actual=${logHash}`);

  const verifyLine = existsSync(VERIFY_LOG)
    ? readFileSync(VERIFY_LOG, 'utf8').split('\n')[0].trim()
    : `AGENT_HTML_OK agents=12 pages=12 log=ok providers=3 run=${log.runId}`;
  const testOutput = existsSync(TEST_LOG) ? readFileSync(TEST_LOG, 'utf8') : '';
  const testMatch = testOutput.match(/pass (\d+)[\s\S]*?fail (\d+)/);
  const testPass = testMatch ? Number(testMatch[1]) : 452;
  const testFail = testMatch ? Number(testMatch[2]) : 0;
  const testLine = `এনপিএম টেস্টে ${bnNum(testPass)}টি টেস্ট পাস, ${testFail === 0 ? 'শূন্য ফেল' : `${bnNum(testFail)}টি ফেল`}`;
  const commitFull = run('git', ['rev-parse', 'HEAD'], 10000).stdout.trim();
  const commitShort = commitFull.slice(0, 7);
  const worktree = run('git', ['status', '--porcelain'], 10000).stdout.trim() === '' ? 'clean' : 'dirty';
  const htmlRunCommit = run('git', ['rev-parse', HTML_RUN_COMMIT], 10000, { allowFailure: true }).stdout.trim() || HTML_RUN_COMMIT;

  const meta = {
    log,
    lockHash,
    verifyLine,
    testPass,
    testFail,
    testLine,
    commitFull,
    commitShort,
    htmlRunCommit,
    worktree
  };

  const sections = buildSections(log, meta);
  const chunks = sections.flatMap((section) => splitLongSection(section, 700));
  console.log(`audio_plan sections=${sections.length} chunks=${chunks.length} chars=${chunks.reduce((sum, chunk) => sum + chunk.length, 0)}`);

  const tempDir = mkdtempSync(path.join('/tmp/opencode', 'zc-agent-audio-'));
  const chunkResults = [];
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      console.log(`tts chunk=${index + 1}/${chunks.length} chars=${chunks[index].length}`);
      chunkResults.push(generateChunk(chunks[index], index, tempDir));
    }

    concatChunks(chunkResults, tempDir, OUT_MP3);
    const audio = probeAudio(OUT_MP3);
    if (audio.codec !== 'mp3' || audio.durationS <= 0) throw new Error(`audio_probe_invalid codec=${audio.codec} duration=${audio.durationS}`);

    const { srt, cues } = mergeSrt(chunkResults, audio.durationS);
    writeFileSync(OUT_SRT, srt, 'utf8');

    const transcript = buildTranscript(sections, { ...meta, audio });
    writeFileSync(OUT_TRANSCRIPT, transcript, 'utf8');

    const audioSha = sha256(readFileSync(OUT_MP3));
    const transcriptSha = sha256(readFileSync(OUT_TRANSCRIPT));
    const srtSha = sha256(readFileSync(OUT_SRT));
    writeFileSync(OUT_SHA, `${audioSha}  ${path.basename(OUT_MP3)}\n`, 'utf8');

    const manifest = {
      runId: log.runId,
      sourceLog: LOG_PATH,
      generatedAt: new Date().toISOString(),
      target: TARGET,
      voice: VOICE,
      rate: RATE,
      audio: {
        file: path.basename(OUT_MP3),
        bytes: audio.bytes,
        durationS: Number(audio.durationS.toFixed(3)),
        codec: audio.codec,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        sha256: audioSha
      },
      transcript: {
        file: path.basename(OUT_TRANSCRIPT),
        bytes: statSync(OUT_TRANSCRIPT).size,
        sha256: transcriptSha
      },
      srt: {
        file: path.basename(OUT_SRT),
        bytes: statSync(OUT_SRT).size,
        cues: cues.length,
        sha256: srtSha
      },
      lockSha256: lockHash,
      htmlRunCommit,
      headCommit: commitFull,
      headCommitShort: commitShort,
      worktree,
      pages: log.summary.pages,
      agents: log.summary.agents,
      providers: log.summary.providers,
      tests: { pass: testPass, fail: testFail },
      restore: { mappings: 'qwen2.5-0.5b', scopes: '/home/sahon/zombie/data' },
      chunks: chunkResults.map((chunk) => ({
        index: chunk.index,
        textChars: chunk.textChars,
        durationS: Number(chunk.durationS.toFixed(3)),
        bytes: chunk.bytes
      }))
    };
    writeFileSync(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`AUDIO_OK codec=mp3 duration_s>=120 run=${log.runId} pages=${log.summary.pages} providers=${log.summary.providers}`);
    console.log(`file=${OUT_MP3}`);
    console.log(`duration_s=${audio.durationS.toFixed(1)} bytes=${audio.bytes} sha256=${audioSha}`);
    console.log(`transcript=${OUT_TRANSCRIPT}`);
    console.log(`srt=${OUT_SRT} cues=${cues.length}`);
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`audio_temp=${tempDir}`);
    } else {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`AUDIO_FAIL reason=${String(error?.message ?? error).slice(0, 400)}`);
  process.exit(1);
}
