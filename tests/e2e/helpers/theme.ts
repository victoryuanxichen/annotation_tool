/**
 * Helpers for the light/dark theme spec: colour maths on computed styles and canvas pixels,
 * an init script that records the theme the document had before the first paint, and the
 * usual "open a folder from OPFS" setup.
 */
import { expect, type Page, type Locator } from '@playwright/test';
import type {} from '../../../src/state/testHook';

export type Rgb = readonly [number, number, number];

/** Parses `rgb(…)` / `rgba(…)` / `color(srgb …)` as returned by getComputedStyle. */
export function parseCssColor(css: string): { rgb: Rgb; alpha: number } {
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(css);
  if (srgb) {
    return {
      rgb: [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255],
      alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(css);
  if (!m) throw new Error(`unparseable colour: ${css}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Computed colour property of the first element matching `selector`, as luminance. */
export async function cssLuminance(page: Page, selector: string, prop: 'backgroundColor' | 'color'): Promise<number> {
  const css = await page.evaluate(
    ([sel, p]) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element ${sel}`);
      return getComputedStyle(el)[p as 'color'];
    },
    [selector, prop] as const,
  );
  const { rgb, alpha } = parseCssColor(css);
  if (alpha < 0.99) throw new Error(`${selector} ${prop} is translucent (${css}); sample an opaque surface`);
  return luminance(rgb);
}

/**
 * Median luminance of one row of timeline-canvas pixels in the middle of the segment lane
 * (CSS y = 46: lane is 32…60), across columns [x0, x1) in CSS px. The median ignores the
 * playhead / pending-start lines, so with no segment there it is the lane background.
 */
export async function timelineLaneLuminance(page: Page, x0Frac = 0.55, x1Frac = 0.95, cssY = 46): Promise<number> {
  const px = await page.evaluate(
    ([a, b, y]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.wb-timeline-canvas');
      if (!canvas || canvas.width === 0) throw new Error('timeline canvas not painted');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const row = Math.round(y * dpr);
      const xa = Math.round(canvas.width * a);
      const xb = Math.round(canvas.width * b);
      const data = ctx.getImageData(xa, row, xb - xa, 1).data;
      const out: number[][] = [];
      for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
      return out;
    },
    [x0Frac, x1Frac, cssY] as const,
  );
  const lums = px.filter((p) => p[3] > 250).map((p) => luminance([p[0], p[1], p[2]]));
  if (lums.length === 0) throw new Error('timeline lane pixels are transparent');
  lums.sort((x, y) => x - y);
  return lums[Math.floor(lums.length / 2)];
}

/**
 * Init script: records `<html data-theme>` (a) every time it changes, (b) when <body> is first
 * created — nothing can be painted before that — and (c) at DOMContentLoaded, together with
 * whether React had rendered anything into #root by then.
 */
export const RECORD_EARLY_THEME = `(() => {
  const rec = { changes: [], atBody: null, atDcl: null, rootChildrenAtDcl: null };
  window.__themeRec = rec;
  let watched = false;
  const push = () => rec.changes.push({ theme: document.documentElement.dataset.theme ?? null, body: !!document.body });
  const check = () => {
    const html = document.documentElement;
    if (html && !watched) {
      watched = true;
      push();
      new MutationObserver(push).observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    }
    if (document.body && rec.atBody === null) {
      rec.atBody = html.dataset.theme ?? null;
      return true;
    }
    return false;
  };
  if (!check()) {
    const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
  document.addEventListener('DOMContentLoaded', () => {
    rec.atDcl = document.documentElement.dataset.theme ?? null;
    const root = document.getElementById('root');
    rec.rootChildrenAtDcl = root ? root.childElementCount : -1;
  });
})();`;

export interface ThemeRecord {
  changes: { theme: string | null; body: boolean }[];
  atBody: string | null;
  atDcl: string | null;
  rootChildrenAtDcl: number | null;
}

export async function themeRecord(page: Page): Promise<ThemeRecord> {
  return page.evaluate(() => (window as unknown as { __themeRec: ThemeRecord }).__themeRec);
}

export function appearanceButton(page: Page, label = 'Appearance'): Locator {
  return page.getByRole('banner').getByRole('button', { name: label, exact: true });
}

/** Opens the Appearance menu with a real click and picks `item` with a real click. */
export async function chooseTheme(page: Page, item: string, label = 'Appearance'): Promise<void> {
  await appearanceButton(page, label).click();
  const menu = page.getByRole('menu', { name: label });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: item, exact: true }).click();
  await expect(menu).toBeHidden();
}

/** Opens the menu and returns the checked state of each item (label → checked), then closes it. */
export async function menuState(page: Page, label = 'Appearance'): Promise<Record<string, boolean>> {
  await appearanceButton(page, label).click();
  const menu = page.getByRole('menu', { name: label });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitemradio');
  const out: Record<string, boolean> = {};
  for (let i = 0; i < (await items.count()); i++) {
    const it = items.nth(i);
    out[(await it.innerText()).trim()] = (await it.getAttribute('aria-checked')) === 'true';
  }
  // Close it again with the trigger (a toggle). Esc is covered by its own test: see theme.spec.ts.
  await appearanceButton(page, label).click();
  await expect(menu).toBeHidden();
  return out;
}

export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__pa?.state().ready === true);
}

/** Copies one fixture into OPFS `batch/` and opens that folder; waits for frame 0. */
export async function openFixture(page: Page, fixture: string): Promise<void> {
  await page.evaluate(async (fixture) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('batch', { recursive: true }).catch(() => undefined);
    const batch = await root.getDirectoryHandle('batch', { create: true });
    const res = await fetch(`/tests/fixtures/videos/${fixture}`);
    if (!res.ok) throw new Error(`fetch ${fixture}: ${res.status}`);
    const fh = await batch.getFileHandle(fixture, { create: true });
    const w = await fh.createWritable();
    await w.write(await res.blob());
    await w.close();
    await window.__pa?.openDirectoryHandle(batch);
  }, fixture);
  await page.waitForFunction(
    (rel) => {
      const s = window.__pa?.state();
      return (
        s?.video.relPath === rel &&
        s.video.loadPhase === 'ready' &&
        s.video.hash.state === 'done' &&
        window.__pa?.player()?.getSnapshot().displayedFrame === 0
      );
    },
    fixture,
    { timeout: 30_000 },
  );
  await page.evaluate(() => window.__pa?.whenIdle());
}

/** Waits until the player shows `frame`, nothing is pending and the canvas barcode agrees. */
export async function expectSettledAt(page: Page, frame: number): Promise<void> {
  await page.waitForFunction(
    (f) => {
      const pa = window.__pa;
      const snap = pa?.player()?.getSnapshot();
      return snap?.displayedFrame === f && snap.requestedFrame === null && pa?.readBarcode() === f;
    },
    frame,
  );
}
