#!/usr/bin/env node
// Independent check of an export against its source video, using only ffprobe/ffmpeg.
//
//   node scripts/recover-frames.mjs <video.mp4> <export.csv|export.json> [--extract <outDir>]
//
// 1. Verifies the SHA-256, frame count and duration recorded in the export.
// 2. Lists the video's frames in presentation order with ffprobe (frame k = k-th decoded frame).
// 3. For every segment checks that start_us/end_us equal the timestamps of start_frame/end_frame
//    (end_frame = N maps to duration_us), i.e. that frames can be recovered either by index or by time.
// 4. With --extract, writes the first and last frame of each segment as PNG using ffmpeg's
//    `select=eq(n\,K)` (n = presentation-order frame index), so you can look at the boundaries.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [video, exportFile, flag, outDir] = process.argv.slice(2);
if (!video || !exportFile) {
  console.error('usage: node scripts/recover-frames.mjs <video.mp4> <export.csv|json> [--extract <outDir>]');
  process.exit(2);
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  const unprotect = (s) => (s.startsWith("'") ? s.slice(1) : s);
  const recs = body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  const v = recs[0];
  return {
    video: { sha256: v.video_sha256, frame_count: +v.frame_count, duration_us: +v.duration_us },
    segments: recs.filter((r) => r.start_frame !== '').map((r) => ({
      phase_id: unprotect(r.phase_id), phase_name: unprotect(r.phase_name),
      start_frame: +r.start_frame, end_frame: +r.end_frame, start_us: +r.start_us, end_us: +r.end_us,
    })),
  };
}

const text = readFileSync(exportFile, 'utf8');
const doc = text.replace(/^﻿/, '').trimStart().startsWith('{') ? JSON.parse(text) : parseCsv(text);

const sha = createHash('sha256').update(readFileSync(video)).digest('hex');
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
  '-show_entries', 'frame=best_effort_timestamp,duration:stream=time_base', '-of', 'json', video], { maxBuffer: 1 << 30 }).toString());
const [num, den] = probe.streams[0].time_base.split('/').map(BigInt);
const toUs = (t) => Number((BigInt(t) * 1000000n * num + den / 2n) / den);
const pts = probe.frames.map((f) => toUs(f.best_effort_timestamp));
const N = pts.length;

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); ok &&= cond; };
check(doc.video.sha256 === sha, `sha256 ${sha.slice(0, 16)}…`);
check(doc.video.frame_count === N, `frame_count ${doc.video.frame_count} (ffprobe ${N})`);
check(doc.video.duration_us > pts[N - 1], `duration_us ${doc.video.duration_us} > last frame pts ${pts[N - 1]}`);
const timeOf = (b) => (b === N ? doc.video.duration_us : pts[b]);
for (const s of doc.segments) {
  const good = s.start_frame >= 0 && s.end_frame <= N && s.start_frame < s.end_frame &&
    s.start_us === timeOf(s.start_frame) && s.end_us === timeOf(s.end_frame);
  check(good, `${s.phase_id} [${s.start_frame}, ${s.end_frame}) = frames ${s.start_frame}…${s.end_frame - 1}, ${s.start_us}–${s.end_us} µs`);
}

if (flag === '--extract' && outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const s of doc.segments) {
    for (const k of [s.start_frame, s.end_frame - 1]) {
      const out = path.join(outDir, `${s.phase_id}_frame${String(k).padStart(6, '0')}.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${k})`, '-fps_mode', 'passthrough', '-frames:v', '1', out]);
      console.log(`wrote ${out}`);
    }
  }
}
process.exit(ok ? 0 : 1);
