/**
 * FramePlayer end-to-end checks against synthetic videos whose frames carry their frame number as a
 * barcode. Every check compares three things: the frame we asked for, the player's displayedFrame,
 * and the barcode actually drawn on the canvas.
 */
import { test, expect, type Page } from '@playwright/test';
import type {} from '../harness/player';

interface FixtureInfo {
  name: string;
  frameCount: number;
  keyframes: number[];
  ptsUs: number[];
}

interface Probe {
  target: number;
  outcome: unknown;
  displayed: number | null;
  barcode: number | null;
}

const FIXTURES = [
  'cfr25_bframes',
  'ntsc2997',
  'vfr_mixed',
  'open_gop30',
  'baseline24_nob',
  'tiny3',
  'long720p_gop300',
] as const;

/** Files up to this many frames are checked exhaustively (every frame, every step). */
const SMALL_FILE_FRAMES = 300;

async function openPlayer(page: Page, name: string, query = ''): Promise<FixtureInfo> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/tests/harness/player.html?v=${name}${query}`);
  await page.waitForFunction(() => window.__loaded !== undefined);
  await page.evaluate(() => window.__loaded);
  expect(await page.evaluate(() => window.__harnessError)).toBeNull();
  expect(errors).toEqual([]);
  const info = await page.evaluate(() => {
    const h = window.__harness;
    if (!h) throw new Error('harness not initialised');
    return { name: h.name, frameCount: h.frameCount, keyframes: h.keyframes, ptsUs: h.ptsUs };
  });
  return info;
}

/** Seeks (or steps) in order, recording outcome, displayedFrame and barcode after each one. */
async function probeSeeks(page: Page, targets: number[], mode: 'seek' | 'step' = 'seek'): Promise<Probe[]> {
  return page.evaluate(
    async ({ targets, mode }) => {
      const p = window.__player;
      const out: Probe[] = [];
      for (const target of targets) {
        const outcome = mode === 'seek' ? await p.seek(target) : await p.step(target);
        out.push({ target, outcome, displayed: p.getSnapshot().displayedFrame, barcode: window.__readBarcode() });
      }
      return out;
    },
    { targets, mode },
  );
}

function expectExact(probes: Probe[], expected: (p: Probe, i: number) => number): void {
  const bad = probes
    .map((p, i) => ({ ...p, expected: expected(p, i) }))
    .filter((p) => {
      const o = p.outcome as { ok?: boolean; frame?: number };
      return !o.ok || o.frame !== p.expected || p.displayed !== p.expected || p.barcode !== p.expected;
    });
  expect(bad.slice(0, 10), `${bad.length} of ${probes.length} probes wrong`).toEqual([]);
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rnd = lcg(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function range(from: number, to: number, stride = 1): number[] {
  const out: number[] = [];
  for (let f = from; stride > 0 ? f <= to : f >= to; f += stride) out.push(f);
  return out;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

for (const name of FIXTURES) {
  test.describe(name, () => {
    test('first, middle and last frames', async ({ page }) => {
      const info = await openPlayer(page, name);
      const n = info.frameCount;
      const mid = Math.floor(n / 2);
      const snap = await page.evaluate(() => window.__player.getSnapshot());
      expect(snap.status).toBe('ready');
      expect(snap.displayedFrame).toBe(0);
      expect(await page.evaluate(() => window.__readBarcode())).toBe(0);
      expectExact(await probeSeeks(page, [n - 1, 0, mid, n - 1, mid, 0]), (p) => p.target);
    });

    test('seeking to every 7th frame (all frames for small files, shuffled)', async ({ page }) => {
      const info = await openPlayer(page, name);
      const n = info.frameCount;
      const every7 = range(0, n - 1, 7);
      expectExact(await probeSeeks(page, every7), (p) => p.target);
      const random = n <= SMALL_FILE_FRAMES ? shuffled(range(0, n - 1), 7) : shuffled(every7, 7).slice(0, 80);
      expectExact(await probeSeeks(page, random), (p) => p.target);
    });

    test('stepping +1 forward and -1 backward across GOP boundaries', async ({ page }) => {
      const info = await openPlayer(page, name);
      const n = info.frameCount;
      const small = n <= SMALL_FILE_FRAMES;
      // Forward: the whole small file; around the first two keyframe boundaries of a long file.
      const kf = info.keyframes.filter((k) => k > 0);
      const fwdStart = small ? 0 : Math.max(0, kf[0] - 20);
      const fwdEnd = small ? n - 1 : Math.min(n - 1, kf[1] + 20);
      await probeSeeks(page, [fwdStart]);
      const fwd = await probeSeeks(page, range(fwdStart + 1, fwdEnd).map(() => 1), 'step');
      expectExact(fwd, (_p, i) => fwdStart + 1 + i);

      // Backward from the end of the range down past keyframe boundaries.
      const bwdStart = small ? n - 1 : Math.min(n - 1, kf[1] + 15);
      const bwdEnd = small ? 0 : Math.max(0, kf[0] - 15);
      await probeSeeks(page, [bwdStart]);
      const bwd = await probeSeeks(page, range(bwdStart - 1, bwdEnd, -1).map(() => -1), 'step');
      expectExact(bwd, (_p, i) => bwdStart - 1 - i);
      const crossed = kf.filter((k) => k <= bwdStart && k > bwdEnd).length;
      if (n > 50) expect(crossed).toBeGreaterThanOrEqual(1);

      // Stepping past either end clamps.
      expectExact(await probeSeeks(page, [0]), () => 0);
      expectExact(await probeSeeks(page, [-1], 'step'), () => 0);
      expectExact(await probeSeeks(page, [n - 1]), () => n - 1);
      expectExact(await probeSeeks(page, [1], 'step'), () => n - 1);
    });

    test('rapid scrubbing: latest seek wins and the canvas never disagrees with displayedFrame', async ({ page }) => {
      const info = await openPlayer(page, name);
      for (const seed of [11, 29, 83]) {
        const r = await page.evaluate(
          async ({ n, seed }) => {
            const p = window.__player;
            let x = seed >>> 0;
            const rnd = (): number => {
              x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
              return x / 2 ** 32;
            };
            const mismatches: { displayed: number | null; barcode: number | null }[] = [];
            const shown = new Set<number>();
            let samples = 0;
            let sampling = true;
            const sample = (): void => {
              const displayed = p.getSnapshot().displayedFrame;
              const barcode = window.__readBarcode();
              samples++;
              if (displayed !== null) shown.add(displayed);
              if (barcode !== displayed) mismatches.push({ displayed, barcode });
              if (sampling) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            const initial = p.getSnapshot().displayedFrame;
            const targets: number[] = [];
            const outcomes: Promise<unknown>[] = [];
            const t0 = performance.now();
            for (let i = 0; i < 60; i++) {
              const t = Math.floor(rnd() * n);
              targets.push(t);
              outcomes.push(p.seek(t));
              // Also probe synchronously right after each seek call.
              const d = p.getSnapshot().displayedFrame;
              const b = window.__readBarcode();
              if (b !== d) mismatches.push({ displayed: d, barcode: b });
              if (d !== null) shown.add(d);
              await new Promise((res) => setTimeout(res, 5));
            }
            const burstMs = performance.now() - t0;
            const settled = await p.settled(20_000);
            sampling = false;
            const results = await Promise.all(outcomes);
            const final = p.getSnapshot();
            return {
              targets,
              results,
              settled,
              final,
              barcode: window.__readBarcode(),
              mismatches,
              samples,
              burstMs,
              initial,
              shown: [...shown],
            };
          },
          { n: info.frameCount, seed },
        );
        const last = r.targets[r.targets.length - 1];
        expect(r.burstMs).toBeLessThan(1000);
        expect(r.mismatches).toEqual([]);
        expect(r.samples).toBeGreaterThan(0);
        expect(r.settled).toEqual({ frame: last });
        expect(r.final.displayedFrame).toBe(last);
        expect(r.final.requestedFrame).toBeNull();
        expect(r.barcode).toBe(last);
        expect(r.results[r.results.length - 1]).toEqual({ ok: true, superseded: false, frame: last });
        r.results.forEach((o, i) => {
          const ok = (o as { superseded: boolean }).superseded || (o as { frame?: number }).frame === r.targets[i];
          expect(ok, `seek #${i} to ${r.targets[i]} resolved ${JSON.stringify(o)}`).toBe(true);
        });
        // Only requested frames are ever shown while seeking.
        const allowed = new Set([...r.targets, r.initial]);
        expect(r.shown.filter((f) => !allowed.has(f))).toEqual([]);
      }
    });

    test('playback at 1x for 1.5 s, then pause on an exact frame', async ({ page }) => {
      const info = await openPlayer(page, name);
      const n = info.frameCount;
      const start = n > 200 ? Math.floor(n / 3) : 0;
      expectExact(await probeSeeks(page, [start]), () => start);
      const r = await page.evaluate(async () => {
        const p = window.__player;
        const samples: { displayed: number | null; barcode: number | null; playing: boolean }[] = [];
        let sampling = true;
        const sample = (): void => {
          const s = p.getSnapshot();
          samples.push({ displayed: s.displayedFrame, barcode: window.__readBarcode(), playing: s.playing });
          if (sampling) requestAnimationFrame(sample);
        };
        p.play();
        requestAnimationFrame(sample);
        const t0 = performance.now();
        await new Promise((res) => setTimeout(res, 1500));
        p.pause();
        const elapsedMs = performance.now() - t0;
        sampling = false;
        const atPause = p.getSnapshot();
        const settled = await p.settled(2000);
        await new Promise((res) => setTimeout(res, 300));
        const later = p.getSnapshot();
        return { samples, atPause, settled, later, barcode: window.__readBarcode(), elapsedMs, stats: p.getStats() };
      });
      const shown = r.samples.map((s) => s.displayed);
      expect(r.samples.filter((s) => s.barcode !== s.displayed)).toEqual([]);
      for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeGreaterThanOrEqual(shown[i - 1]!);
      expect(r.atPause.playing).toBe(false);
      const end = r.atPause.displayedFrame!;
      expect(r.settled).toEqual({ frame: end });
      expect(r.later.displayedFrame).toBe(end);
      expect(r.barcode).toBe(end);
      // Media time covered at 1x should roughly match wall time (frames are dropped, never repeated).
      const expectedEnd = Math.min(n - 1, frameAt(info.ptsUs, info.ptsUs[start] + r.elapsedMs * 1000));
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(expectedEnd + 2);
      if (expectedEnd === n - 1) expect(end).toBe(n - 1);
      else expect(end - start).toBeGreaterThanOrEqual(Math.floor((expectedEnd - start) * 0.6));
      console.log(`${name}: played ${start}→${end} in ${Math.round(r.elapsedMs)} ms (expected ≈${expectedEnd}), dropped ${r.stats.framesDropped}`);
    });
  });
}

function frameAt(ptsUs: number[], t: number): number {
  let f = 0;
  while (f + 1 < ptsUs.length && ptsUs[f + 1] <= t) f++;
  return f;
}

test.describe('long720p_gop300 extras', () => {
  test('random seek latency (p50/p95)', async ({ page }) => {
    const info = await openPlayer(page, 'long720p_gop300');
    const rnd = lcg(1234);
    const targets = Array.from({ length: 60 }, () => Math.floor(rnd() * info.frameCount));
    const r = await page.evaluate(async (targets) => {
      const p = window.__player;
      const out: { target: number; ms: number; displayed: number | null; barcode: number | null; ok: boolean }[] = [];
      for (const t of targets) {
        const t0 = performance.now();
        const o = await p.seek(t);
        const ms = performance.now() - t0;
        out.push({ target: t, ms, displayed: p.getSnapshot().displayedFrame, barcode: window.__readBarcode(), ok: o.ok });
        // Let prefetch run a little, as a user pausing between seeks would.
        await new Promise((res) => setTimeout(res, 50));
      }
      return { out, stats: p.getStats() };
    }, targets);
    expect(r.out.filter((o) => !o.ok || o.displayed !== o.target || o.barcode !== o.target)).toEqual([]);
    const ms = r.out.map((o) => o.ms).sort((a, b) => a - b);
    const p50 = percentile(ms, 50);
    const p95 = percentile(ms, 95);
    const line = `long720p_gop300 random seek latency: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${ms[ms.length - 1].toFixed(1)} ms (n=${ms.length}); runs=${r.stats.runs} reads=${r.stats.reads}`;
    console.log(line);
    test.info().annotations.push({ type: 'seek-latency', description: line });
    expect(p95).toBeLessThan(3000);
  });

  test('2x playback reaches the last frame and stops there', async ({ page }) => {
    const info = await openPlayer(page, 'long720p_gop300');
    const n = info.frameCount;
    expectExact(await probeSeeks(page, [n - 90]), () => n - 90);
    const r = await page.evaluate(async () => {
      const p = window.__player;
      p.setRate(2);
      p.play();
      const t0 = performance.now();
      while (p.getSnapshot().playing && performance.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 50));
      return { snap: p.getSnapshot(), barcode: window.__readBarcode(), ms: performance.now() - t0 };
    });
    expect(r.snap.playing).toBe(false);
    expect(r.snap.rate).toBe(2);
    expect(r.snap.displayedFrame).toBe(n - 1);
    expect(r.barcode).toBe(n - 1);
    expect(r.ms).toBeLessThan(4000);
  });
});

test.describe('player extras', () => {
  test('keyframe thumbnails show keyframes near the requested frame', async ({ page }) => {
    const info = await openPlayer(page, 'cfr25_bframes');
    await page.waitForFunction((k) => window.__player.getStats().thumbnails >= k, info.keyframes.length);
    for (const f of [0, 60, 124, 249]) {
      const bc = await page.evaluate((f) => window.__readThumbnailBarcode(f), f);
      const nearest = info.keyframes.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
      expect(bc).toBe(nearest);
    }
  });

  test('missing WebCodecs reports webcodecs_missing', async ({ page }) => {
    await openPlayer(page, 'tiny3', '&nowebcodecs=1');
    const snap = await page.evaluate(() => window.__player.getSnapshot());
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('webcodecs_missing');
    expect(await page.evaluate(() => window.__player.seek(1))).toEqual({ ok: false, superseded: false, error: 'webcodecs_missing' });
    expect(await page.evaluate(() => window.__player.settled(100))).toEqual({ error: 'webcodecs_missing' });
  });

  test('step after seek is relative to the pending target', async ({ page }) => {
    await openPlayer(page, 'cfr25_bframes');
    const r = await page.evaluate(async () => {
      const p = window.__player;
      const a = p.seek(180);
      const b = p.step(5);
      return { a: await a, b: await b, d: p.getSnapshot().displayedFrame, bc: window.__readBarcode() };
    });
    expect(r.a).toEqual({ ok: false, superseded: true });
    expect(r.b).toEqual({ ok: true, superseded: false, frame: 185 });
    expect(r.d).toBe(185);
    expect(r.bc).toBe(185);
  });

  test('unsupported codec reports codec_unsupported', async ({ page }) => {
    await openPlayer(page, 'cfr25_bframes', '&unsupported=1');
    const snap = await page.evaluate(() => window.__player.getSnapshot());
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('codec_unsupported');
    expect(snap.displayedFrame).toBeNull();
  });

  test('read failure reports read_failed', async ({ page }) => {
    await openPlayer(page, 'long720p_gop300');
    const r = await page.evaluate(async () => {
      window.__setReadFault('throw');
      const o = await window.__player.seek(2950);
      return { o, snap: window.__player.getSnapshot(), barcode: window.__readBarcode() };
    });
    expect(r.o).toEqual({ ok: false, superseded: false, error: 'read_failed' });
    expect(r.snap.status).toBe('error');
    expect(r.snap.error?.code).toBe('read_failed');
    // The last verified frame stays on screen and is still reported truthfully.
    expect(r.barcode).toBe(r.snap.displayedFrame);
  });

  test('corrupt sample data reports decode_failed', async ({ page }) => {
    await openPlayer(page, 'long720p_gop300');
    const r = await page.evaluate(async () => {
      window.__setReadFault('garbage');
      const o = await window.__player.seek(2950);
      return { o, snap: window.__player.getSnapshot(), barcode: window.__readBarcode() };
    });
    expect(r.o).toEqual({ ok: false, superseded: false, error: 'decode_failed' });
    expect(r.snap.error?.code).toBe('decode_failed');
    expect(r.barcode).toBe(r.snap.displayedFrame);
  });

  test('loading another video replaces the old one completely', async ({ page }) => {
    await openPlayer(page, 'long720p_gop300');
    const r = await page.evaluate(async () => {
      const p = window.__player;
      void p.seek(3000);
      p.play();
      await window.__loadFixture('tiny3');
      const afterLoad = { snap: p.getSnapshot(), barcode: window.__readBarcode() };
      const o = await p.seek(2);
      return { afterLoad, o, snap: p.getSnapshot(), barcode: window.__readBarcode() };
    });
    expect(r.afterLoad.snap.status).toBe('ready');
    expect(r.afterLoad.snap.displayedFrame).toBe(0);
    expect(r.afterLoad.snap.playing).toBe(false);
    expect(r.afterLoad.barcode).toBe(0);
    expect(r.o).toEqual({ ok: true, superseded: false, frame: 2 });
    expect(r.barcode).toBe(2);
  });

  test('canvas resize redraws letterboxed and keeps the frame exact', async ({ page }) => {
    await openPlayer(page, 'cfr25_bframes');
    expectExact(await probeSeeks(page, [137]), () => 137);
    for (const [w, h] of [
      [480, 480],
      [1200, 400],
      [320, 180],
      [960, 540],
    ]) {
      const r = await page.evaluate(
        async ({ w, h }) => {
          const c = document.getElementById('screen') as HTMLCanvasElement;
          c.style.width = `${w}px`;
          c.style.height = `${h}px`;
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          const immediate = { d: window.__player.getSnapshot().displayedFrame, b: window.__readBarcode() };
          await new Promise((res) => setTimeout(res, 150));
          return { immediate, backing: [c.width, c.height], d: window.__player.getSnapshot().displayedFrame, b: window.__readBarcode() };
        },
        { w, h },
      );
      expect(r.backing).toEqual([w, h]);
      expect(r.immediate).toEqual({ d: 137, b: 137 });
      expect([r.d, r.b]).toEqual([137, 137]);
      expectExact(await probeSeeks(page, [1, 1], 'step'), (_p, i) => 138 + i);
      expectExact(await probeSeeks(page, [137]), () => 137);
    }
  });

  test('seeking during playback jumps there and keeps playing forward', async ({ page }) => {
    await openPlayer(page, 'ntsc2997');
    const r = await page.evaluate(async () => {
      const p = window.__player;
      const samples: { d: number | null; b: number | null }[] = [];
      let sampling = true;
      const sample = (): void => {
        samples.push({ d: p.getSnapshot().displayedFrame, b: window.__readBarcode() });
        if (sampling) requestAnimationFrame(sample);
      };
      p.play();
      requestAnimationFrame(sample);
      await new Promise((res) => setTimeout(res, 400));
      const before = p.getSnapshot().displayedFrame;
      const o = await p.seek(200);
      const marker = samples.length;
      await new Promise((res) => setTimeout(res, 500));
      sampling = false;
      p.pause();
      return { before, o, samples, marker, end: p.getSnapshot(), barcode: window.__readBarcode() };
    });
    expect(r.samples.filter((s) => s.b !== s.d)).toEqual([]);
    expect(r.o).toEqual({ ok: true, superseded: false, frame: 200 });
    expect(r.before).toBeGreaterThan(0);
    const after = r.samples.slice(r.marker).map((s) => s.d!);
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1]);
    expect(r.end.displayedFrame!).toBeGreaterThan(205);
    expect(r.barcode).toBe(r.end.displayedFrame);
  });
});
