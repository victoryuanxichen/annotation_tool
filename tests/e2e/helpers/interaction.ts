/**
 * Helpers for tests/e2e/interaction.spec.ts: OPFS batch folders built from the synthetic fixtures
 * (optionally padded with a trailing MP4 'free' box so hashing takes seconds), control geometry,
 * a per-frame sampler (counter text / player.displayedFrame / canvas barcode) and long-task probes.
 *
 * Everything here is deterministic and synthetic: padding is zero bytes inside a valid top-level
 * 'free' box appended after the fixture's last box, so the MP4 still parses and plays unchanged.
 */
import { expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../../../src/state/testHook';

export interface ManifestEntry {
  frame_count: number;
  sha256: string;
  pts_us: number[];
  size: number;
}

export const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/videos/manifest.json', import.meta.url)), 'utf8'),
) as Record<string, ManifestEntry>;

export const SHOTS = fileURLToPath(new URL('../../artifacts/interaction/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}${name}.png` });
}

// ------------------------------------------------------------------ OPFS folders

export interface LayoutEntry {
  /** Path inside the folder (forward slashes). */
  path: string;
  /** Fixture name under tests/fixtures/videos, or null for a text file. */
  fixture?: string;
  /** Bytes of zero padding appended inside a trailing 'free' box (0 = none). */
  padBytes?: number;
  text?: string;
}

/** (Re)creates OPFS directory `name` with the given layout. Returns the size of each file. */
export async function buildOpfsFolder(page: Page, name: string, layout: LayoutEntry[]): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ name, layout }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      const base = await root.getDirectoryHandle(name, { create: true });
      const sizes: Record<string, number> = {};
      const CHUNK = 16 * 1024 * 1024;
      const zeros = new Uint8Array(CHUNK);
      for (const e of layout) {
        const parts = e.path.split('/');
        let dir = base;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        if (e.fixture) {
          const res = await fetch(`/tests/fixtures/videos/${e.fixture}`);
          if (!res.ok) throw new Error(`fetch ${e.fixture}: ${res.status}`);
          await w.write(await res.blob());
          const pad = e.padBytes ?? 0;
          if (pad > 0) {
            const header = new Uint8Array(8);
            new DataView(header.buffer).setUint32(0, pad + 8);
            header.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
            await w.write(header);
            for (let left = pad; left > 0; left -= CHUNK) await w.write(left >= CHUNK ? zeros : zeros.subarray(0, left));
          }
        } else {
          await w.write(e.text ?? '');
        }
        await w.close();
        sizes[e.path] = (await fh.getFile()).size;
      }
      return sizes;
    },
    { name, layout },
  );
}

/** Opens OPFS folder `name` through the test hook; does not wait for the first video. */
export async function startOpenFolder(page: Page, name: string): Promise<void> {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name);
    void window.__pa?.openDirectoryHandle(dir);
  }, name);
}

/** Waits until `relPath` is open, ready and showing frame 0 (optionally: hash done + idle). */
export async function waitVideoReady(page: Page, relPath: string, opts: { hashed?: boolean; timeout?: number } = {}): Promise<void> {
  const hashed = opts.hashed ?? true;
  await page.waitForFunction(
    ({ rel, hashed }) => {
      const s = window.__pa?.state();
      const snap = window.__pa?.player()?.getSnapshot();
      return (
        s?.video.relPath === rel &&
        s.video.loadPhase === 'ready' &&
        snap?.status === 'ready' &&
        snap.displayedFrame !== null &&
        (!hashed || (s.video.hash.state === 'done' && s.video.identity === 'verified'))
      );
    },
    { rel: relPath, hashed },
    { timeout: opts.timeout ?? 60_000 },
  );
  if (hashed) await page.evaluate(() => window.__pa?.whenIdle());
}

export function frameInputSel(): string {
  return 'input[data-testid="frame-input"], [data-testid="frame-input"] input';
}

/** Waits until counter, player and barcode all show `frame`. */
export async function expectSettledAt(page: Page, frame: number, timeout = 15_000): Promise<void> {
  await expect(page.locator(frameInputSel()).first()).toHaveValue(String(frame), { timeout });
  await page.waitForFunction(
    (f) => {
      const pa = window.__pa;
      const snap = pa?.player()?.getSnapshot();
      return snap?.displayedFrame === f && snap.requestedFrame === null && pa?.readBarcode() === f;
    },
    frame,
    { timeout },
  );
}

export async function displayed(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__pa?.player()?.getSnapshot().displayedFrame ?? null);
}

// ------------------------------------------------------------------ control geometry

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Geometry = Record<string, Rect | null>;

/**
 * Bounding boxes of the controls that must never move. Located structurally (not by label),
 * because labels change with state (Play ↔ Pause) and language.
 */
export async function measureControls(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const m = window.__ixMeasure;
    if (!m) throw new Error('probes not installed');
    return m();
  });
}

/**
 * In-page geometry probe (installed by installProbes). Controls are located structurally, not by
 * label, because labels change with state (Play ↔ Pause) and language.
 */
function measureInPage(): Record<string, { x: number; y: number; w: number; h: number } | null> {
  const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
  const r = (el: Element | null | undefined): { x: number; y: number; w: number; h: number } | null => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) return null;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const fb = Array.from(document.querySelectorAll<HTMLButtonElement>('.wb-filebar button'));
  out.prev = r(fb[0]);
  out.next = r(fb[fb.length - 1]);
  const tb = Array.from(document.querySelectorAll<HTMLButtonElement>('.wb-transport button')).filter(
    (b) => !b.closest('.wb-transport-end'),
  );
  out.first = r(tb[0]);
  out.stepBack = r(tb[1]);
  out.play = r(tb[2]);
  out.stepForward = r(tb[3]);
  out.last = r(tb[4]);
  out.rate = r(document.querySelector('.wb-transport select'));
  out.frameInput = r(document.querySelector('input[data-testid="frame-input"], [data-testid="frame-input"] input'));
  out.counter = r(document.querySelector('.wb-counter'));
  out.total = r(document.querySelector('[data-testid="frame-total"]'));
  out.timecode = r(document.querySelector('[data-testid="timecode"]'));
  out.timeline = r(document.querySelector('.wb-timeline'));
  out.canvas = r(document.querySelector('[data-testid="player-canvas"]'));
  const chips = Array.from(document.querySelectorAll('[data-testid="recent-chips"] button'));
  for (let i = 0; i < 5; i++) out[`chip${i + 1}`] = r(chips[i]);
  out.selectedPhase = r(document.querySelector('[data-testid="selected-phase"]'));
  out.pendingStart = r(document.querySelector('[data-testid="pending-start"]'));
  const mark = Array.from(document.querySelectorAll<HTMLButtonElement>('.wb-markgrid button'));
  out.markStart = r(mark[0]);
  out.markFinish = r(mark[1]);
  out.markFinishNext = r(mark[2]);
  out.markThroughEnd = r(mark[3]);
  out.exportState = r(document.querySelector('[data-testid="export-state"]'));
  out.saveState = r(document.querySelector('[data-testid="save-state"]'));
  out.exportButton = r(document.querySelector('.wb-export-action button'));
  out.bottomTabs = r(document.querySelector('.wb-pane [role="tablist"]'));
  out.batchList = r(document.querySelector('.wb-bottom > section:last-of-type'));
  out.firstBatchRow = r(document.querySelector('[data-testid="batch-row"]'));
  return out;
}

/** Differences > tol px between a reference geometry and another one (only keys present in both). */
export function geometryDiff(ref: Geometry, other: Geometry, tol = 0.5, keys?: string[]): string[] {
  const out: string[] = [];
  for (const k of keys ?? Object.keys(ref)) {
    const a = ref[k];
    const b = other[k];
    if (a === null || a === undefined) continue;
    if (b === null || b === undefined) {
      out.push(`${k}: missing`);
      continue;
    }
    const d = [b.x - a.x, b.y - a.y, b.w - a.w, b.h - a.h];
    if (d.some((v) => Math.abs(v) > tol)) {
      out.push(`${k}: Δx=${d[0].toFixed(1)} Δy=${d[1].toFixed(1)} Δw=${d[2].toFixed(1)} Δh=${d[3].toFixed(1)}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ per-frame sampler

export interface FrameSample {
  t: number;
  counter: string | null;
  displayed: number | null;
  requested: number | null;
  barcode: number | null;
  playing: boolean;
}

declare global {
  interface Window {
    __ix?: {
      samples: FrameSample[];
      running: boolean;
      barcodes: boolean;
      longTasks: { start: number; duration: number }[];
      sentinel?: HTMLDivElement;
    };
    __ixMeasure?: () => Record<string, { x: number; y: number; w: number; h: number } | null>;
  }
}

/**
 * Installs (before any page script) a long-task observer and the sampler state. The sampler
 * reads its values from a ResizeObserver callback driven by a sentinel whose size changes every
 * animation frame: RO callbacks run after requestAnimationFrame callbacks, style and layout and
 * right before paint, so each sample is what the user sees in that frame.
 */
export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(`window.__ixMeasure = ${measureInPage.toString()};`);
  await page.addInitScript(() => {
    const ix = { samples: [], running: false, barcodes: true, longTasks: [] } as NonNullable<Window['__ix']>;
    window.__ix = ix;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) ix.longTasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* not supported */
    }
  });
}

export async function startSampler(page: Page, opts: { barcodes?: boolean } = {}): Promise<void> {
  await page.evaluate((barcodes) => {
    const ix = window.__ix;
    if (!ix) throw new Error('probes not installed');
    ix.samples = [];
    ix.running = true;
    ix.barcodes = barcodes;
    const input = (): HTMLInputElement | null =>
      document.querySelector<HTMLInputElement>('input[data-testid="frame-input"], [data-testid="frame-input"] input');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;opacity:0;';
    document.body.appendChild(el);
    ix.sentinel = el;
    let flip = false;
    const ro = new ResizeObserver(() => {
      if (!ix.running) return;
      const snap = window.__pa?.player()?.getSnapshot();
      ix.samples.push({
        t: performance.now(),
        counter: input()?.value ?? null,
        displayed: snap?.displayedFrame ?? null,
        requested: snap?.requestedFrame ?? null,
        barcode: ix.barcodes ? (window.__pa?.readBarcode() ?? null) : null,
        playing: snap?.playing ?? false,
      });
    });
    ro.observe(el);
    const tick = (): void => {
      if (!ix.running) {
        ro.disconnect();
        el.remove();
        return;
      }
      flip = !flip;
      el.style.width = flip ? '2px' : '1px';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, opts.barcodes ?? true);
}

export async function stopSampler(page: Page): Promise<FrameSample[]> {
  return page.evaluate(async () => {
    const ix = window.__ix;
    if (!ix) return [];
    // One more frame so the last sample is taken.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    ix.running = false;
    return ix.samples;
  });
}

export async function longTasksSince(page: Page, since: number): Promise<{ start: number; duration: number }[]> {
  return page.evaluate((since) => (window.__ix?.longTasks ?? []).filter((t) => t.start >= since), since);
}

export async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

// ------------------------------------------------------------------ misc

/** Last frame whose pts ≤ t (presentation order), like src/core/mp4 frameAtUs. */
export function frameAtUs(ptsUs: number[], t: number): number {
  if (t <= ptsUs[0]) return 0;
  let lo = 0;
  let hi = ptsUs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ptsUs[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Collects page errors / console errors for the whole test. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Loads the app with probes, builds an OPFS folder and starts opening it. */
export async function openApp(page: Page): Promise<void> {
  await installProbes(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__pa?.state().ready === true);
}

/** The editor state that shortcuts would change. */
export async function markState(page: Page): Promise<{
  displayed: number | null;
  requested: number | null;
  playing: boolean;
  pending: number | null;
  segments: [number, number, string][];
  selected: string | null;
}> {
  return page.evaluate(() => {
    const s = window.__pa!.state();
    const snap = window.__pa!.player()?.getSnapshot();
    return {
      displayed: snap?.displayedFrame ?? null,
      requested: snap?.requestedFrame ?? null,
      playing: snap?.playing ?? false,
      pending: s.editor.pendingStart,
      segments: s.editor.doc.segments.map((g) => [g.start, g.end, g.phaseId] as [number, number, string]),
      selected: s.selectedPhaseId,
    };
  });
}
