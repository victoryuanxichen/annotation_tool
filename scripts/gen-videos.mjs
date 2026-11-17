#!/usr/bin/env node
// Generates synthetic H.264 MP4 test videos whose every frame shows its own
// presentation-order frame number twice:
//   1. as large seven-segment digits (for people), and
//   2. as a 24-cell binary barcode along the top edge (for automated checks).
// Barcode layout (all cells equal width, full width of the frame, BAR_H tall):
//   cell 0 = white guard, cell 1 = black guard,
//   cells 2..21 = frame number bits (MSB first, white = 1),
//   cells 22..23 = (frame mod 4) bits, a cheap checksum.
// Also writes manifest.json with ffprobe ground truth (pts per frame, in
// presentation order) for each file.
//
// Usage: node scripts/gen-videos.mjs [outDir]   (default tests/fixtures/videos)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? 'tests/fixtures/videos');
mkdirSync(outDir, { recursive: true });

export const BAR_CELLS = 24;
export const BAR_H_FRAC = 0.1; // barcode band height as a fraction of frame height

// Seven-segment glyphs: segments a,b,c,d,e,f,g
const SEG = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

function fillRect(buf, W, H, x0, y0, w, h, r, g, b) {
  const x1 = Math.min(W, Math.max(0, Math.round(x0 + w)));
  const y1 = Math.min(H, Math.max(0, Math.round(y0 + h)));
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  for (let y = y0; y < y1; y++) {
    let o = (y * W + x0) * 3;
    for (let x = x0; x < x1; x++) { buf[o++] = r; buf[o++] = g; buf[o++] = b; }
  }
}

function drawDigit(buf, W, H, d, x, y, dw, dh, col) {
  const t = Math.max(2, Math.round(dw * 0.16));
  const segs = SEG[d];
  const [r, g, b] = col;
  const half = dh / 2;
  if (segs.includes('a')) fillRect(buf, W, H, x + t, y, dw - 2 * t, t, r, g, b);
  if (segs.includes('g')) fillRect(buf, W, H, x + t, y + half - t / 2, dw - 2 * t, t, r, g, b);
  if (segs.includes('d')) fillRect(buf, W, H, x + t, y + dh - t, dw - 2 * t, t, r, g, b);
  if (segs.includes('f')) fillRect(buf, W, H, x, y + t, t, half - t, r, g, b);
  if (segs.includes('b')) fillRect(buf, W, H, x + dw - t, y + t, t, half - t, r, g, b);
  if (segs.includes('e')) fillRect(buf, W, H, x, y + half, t, half - t, r, g, b);
  if (segs.includes('c')) fillRect(buf, W, H, x + dw - t, y + half, t, half - t, r, g, b);
}

function renderFrame(buf, W, H, n, seed) {
  // Background: dark, hue slowly drifting so neighbouring frames differ visibly.
  const hue = ((n * 7 + seed * 97) % 360) / 360;
  const bg = hsl(hue, 0.35, 0.22);
  fillRect(buf, W, H, 0, 0, W, H, ...bg);
  // A moving marker bar (motion makes the encoder actually use P/B prediction).
  const mx = ((n * 9 + seed * 31) % (W + 60)) - 60;
  fillRect(buf, W, H, mx, H * 0.78, 60, H * 0.08, ...hsl((hue + 0.5) % 1, 0.5, 0.55));
  // Seed tag square (lets two "same name" videos differ visibly).
  fillRect(buf, W, H, W - H * 0.12, H - H * 0.12, H * 0.09, H * 0.09, ...hsl((seed * 0.13) % 1, 0.7, 0.5));
  // Barcode band
  const barH = Math.round(H * BAR_H_FRAC);
  const cellW = W / BAR_CELLS;
  const bits = [1, 0];
  for (let i = 19; i >= 0; i--) bits.push((n >> i) & 1);
  bits.push((n % 4) >> 1 & 1, n % 2 & 1);
  for (let i = 0; i < BAR_CELLS; i++) {
    const v = bits[i] ? 235 : 16;
    fillRect(buf, W, H, i * cellW, 0, cellW + 1, barH, v, v, v);
  }
  // Seven segment digits, centred.
  const s = String(n).padStart(5, '0');
  const dh = Math.round(H * 0.42);
  const dw = Math.round(dh * 0.55);
  const gap = Math.round(dw * 0.3);
  const total = s.length * dw + (s.length - 1) * gap;
  let x = Math.round((W - total) / 2);
  const y = Math.round(H * 0.24);
  for (const ch of s) { drawDigit(buf, W, H, Number(ch), x, y, dw, dh, [245, 245, 240]); x += dw + gap; }
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

async function encode({ name, W, H, frames, rate, seed = 1, x264 = [], vf = null, extraOut = [] }) {
  const file = path.join(outDir, name);
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-framerate', rate, '-i', '-'];
  if (vf) args.push('-vf', vf);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...x264, ...extraOut, '-an', '-movflags', '+faststart', file);
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const buf = Buffer.alloc(W * H * 3);
  for (let n = 0; n < frames; n++) {
    renderFrame(buf, W, H, n, seed);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c} for ${name}`)))));
  return file;
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp,pts,duration,pkt_dts', '-show_entries', 'stream=time_base,r_frame_rate,avg_frame_rate,nb_frames,codec_name,profile,has_b_frames',
    '-of', 'json', file], { maxBuffer: 1 << 28 });
  const j = JSON.parse(out.toString());
  const st = j.streams[0];
  const [num, den] = st.time_base.split('/').map(Number);
  const pts = j.frames.map((f) => Number(f.best_effort_timestamp ?? f.pts));
  // ffprobe outputs frames in presentation order already; assert monotonic.
  for (let i = 1; i < pts.length; i++) if (!(pts[i] > pts[i - 1])) throw new Error(`${file}: non-monotonic pts at ${i}`);
  const toUs = (t) => Number((BigInt(t) * 1000000n * BigInt(num) + BigInt(den) / 2n) / BigInt(den));
  return {
    time_base: st.time_base, r_frame_rate: st.r_frame_rate, avg_frame_rate: st.avg_frame_rate,
    profile: st.profile, has_b_frames: st.has_b_frames,
    frame_count: pts.length, pts, pts_us: pts.map(toUs),
  };
}

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

const SPECS = [
  // Constant 25 fps, B-frames (x264 default b-frames=3) => ctts reordering + edit list.
  { name: 'cfr25_bframes.mp4', W: 640, H: 360, frames: 250, rate: '25', x264: ['-preset', 'veryfast', '-g', '50', '-bf', '3'] },
  // Fractional NTSC rate 30000/1001.
  { name: 'ntsc2997.mp4', W: 640, H: 360, frames: 300, rate: '30000/1001', x264: ['-preset', 'veryfast', '-g', '60', '-bf', '2'] },
  // Variable frame rate: per-frame durations of 21/52.7/84.4 ms plus a 50 ms extra every 17th frame.
  { name: 'vfr_mixed.mp4', W: 640, H: 360, frames: 240, rate: '50',
    vf: "settb=1/90000,setpts='if(eq(N,0),0,PREV_OUTPTS+(0.021+0.0317*mod(N,3)+0.050*eq(mod(N,17),0))/TB)'",
    x264: ['-preset', 'veryfast', '-g', '40', '-bf', '3'], extraOut: ['-fps_mode', 'passthrough', '-enc_time_base:v', '1/90000', '-video_track_timescale', '90000'] },
  // Baseline profile, no B-frames, 24 fps.
  { name: 'baseline24_nob.mp4', W: 640, H: 360, frames: 120, rate: '24', x264: ['-profile:v', 'baseline', '-preset', 'veryfast', '-g', '24'] },
  // Open-GOP stream (leading B-frames reference the previous GOP).
  { name: 'open_gop30.mp4', W: 640, H: 360, frames: 300, rate: '30', x264: ['-preset', 'veryfast', '-g', '45', '-bf', '3', '-x264-params', 'open_gop=1:scenecut=0'] },
  // Tiny edge case: three frames.
  { name: 'tiny3.mp4', W: 320, H: 180, frames: 3, rate: '10', x264: ['-preset', 'veryfast'] },
  // Long-GOP 720p for scrubbing/performance (2 minutes at 30 fps).
  { name: 'long720p_gop300.mp4', W: 1280, H: 720, frames: 3600, rate: '30', x264: ['-preset', 'veryfast', '-g', '300', '-bf', '3', '-crf', '28'] },
  // Two different videos that will share a filename in the batch fixture.
  { name: 'same_name_a.mp4', W: 640, H: 360, frames: 150, rate: '25', seed: 3, x264: ['-preset', 'veryfast', '-g', '50'] },
  { name: 'same_name_b.mp4', W: 640, H: 360, frames: 150, rate: '25', seed: 8, x264: ['-preset', 'veryfast', '-g', '50'] },
];

const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const manifest = existsSync(path.join(outDir, 'manifest.json'))
  ? JSON.parse((await import('node:fs')).readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) : {};
for (const spec of SPECS) {
  if (only && !only.has(spec.name)) continue;
  const t0 = Date.now();
  const file = await encode(spec);
  const p = probe(file);
  if (p.frame_count !== spec.frames) throw new Error(`${spec.name}: expected ${spec.frames} frames, ffprobe saw ${p.frame_count}`);
  manifest[spec.name] = { ...p, width: spec.W, height: spec.H, size: statSync(file).size, sha256: await sha256(file), seed: spec.seed ?? 1 };
  console.log(`${spec.name}: ${p.frame_count} frames, tb ${p.time_base}, b=${p.has_b_frames}, ${(statSync(file).size / 1e6).toFixed(2)} MB, ${Date.now() - t0} ms`);
}
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`manifest written to ${path.join(outDir, 'manifest.json')}`);
