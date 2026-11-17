/**
 * End-to-end smoke run of the workbench with real keyboard and mouse input.
 *
 * A batch folder is built in OPFS from the synthetic fixtures (two same-name videos in different
 * subfolders, a B-frame CFR video and a VFR video) and opened through the test hook. Everything
 * after that goes through the UI: clicking a phase chip, D/Q/E/R and digit keys, the jump-to-frame
 * field, the Next/Previous buttons and the language switch. At every mark the frame counter, the
 * controller's pending start / segment boundary and the barcode drawn on the canvas must agree.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../../src/state/testHook';

interface ManifestEntry {
  frame_count: number;
  sha256: string;
  pts_us: number[];
}
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/videos/manifest.json', import.meta.url)), 'utf8'),
) as Record<string, ManifestEntry>;

const SHOTS = fileURLToPath(new URL('../artifacts/smoke/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

/** OPFS layout: path inside the batch folder → fixture file. */
const LAYOUT: ReadonlyArray<readonly [string, string]> = [
  ['caseA/same_name.mp4', 'same_name_a.mp4'],
  ['caseB/same_name.mp4', 'same_name_b.mp4'],
  ['cfr25_bframes.mp4', 'cfr25_bframes.mp4'],
  ['vfr_mixed.mp4', 'vfr_mixed.mp4'],
];

const HEADER = 'format_version,video_sha256,frame_count,duration_us,phase_id,phase_name,start_frame,end_frame,start_us,end_us';

/** Boundary time in µs: pts of frame b, or the end of the last frame for b = N (CFR fixture). */
function boundaryUs(e: ManifestEntry, b: number): number {
  if (b < e.frame_count) return e.pts_us[b];
  const n = e.frame_count;
  return e.pts_us[n - 1] + (e.pts_us[n - 1] - e.pts_us[n - 2]);
}

async function buildBatch(page: Page): Promise<void> {
  await page.evaluate(async (layout) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('batch', { recursive: true }).catch(() => undefined);
    const batch = await root.getDirectoryHandle('batch', { create: true });
    for (const [rel, fixture] of layout) {
      const parts = rel.split('/');
      let dir = batch;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const res = await fetch(`/tests/fixtures/videos/${fixture}`);
      if (!res.ok) throw new Error(`fetch ${fixture}: ${res.status}`);
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(await res.blob());
      await w.close();
    }
  }, LAYOUT);
}

async function readOpfsText(page: Page, rel: string): Promise<string | null> {
  return page.evaluate(async (rel) => {
    let dir = await navigator.storage.getDirectory();
    const parts = ['batch', ...rel.split('/')];
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      const buf = await (await fh.getFile()).arrayBuffer();
      // Keep the BOM: decode without stripping it.
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
    } catch {
      return null;
    }
  }, rel);
}

async function listOpfs(page: Page, rel: string): Promise<string[]> {
  return page.evaluate(async (rel) => {
    let dir = await navigator.storage.getDirectory();
    for (const p of ['batch', ...rel.split('/').filter(Boolean)]) dir = await dir.getDirectoryHandle(p);
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  }, rel);
}

function frameInput(page: Page): Locator {
  return page.locator('input[data-testid="frame-input"], [data-testid="frame-input"] input').first();
}

/** Waits until counter, player and canvas barcode all show `frame`; returns the barcode. */
async function expectSettledAt(page: Page, frame: number): Promise<void> {
  await expect(frameInput(page)).toHaveValue(String(frame));
  await page.waitForFunction(
    (f) => {
      const pa = window.__pa;
      const snap = pa?.player()?.getSnapshot();
      return snap?.displayedFrame === f && snap.requestedFrame === null && pa?.readBarcode() === f;
    },
    frame,
  );
  const counter = await frameInput(page).inputValue();
  const barcode = await page.evaluate(() => window.__pa?.readBarcode() ?? null);
  expect(barcode, 'barcode on canvas equals the frame counter').toBe(Number(counter));
}

async function waitVideoReady(page: Page, relPath: string): Promise<void> {
  await page.waitForFunction(
    (rel) => {
      const s = window.__pa?.state();
      return (
        s?.video.relPath === rel &&
        s.video.loadPhase === 'ready' &&
        s.video.hash.state === 'done' &&
        s.video.identity === 'verified' &&
        window.__pa?.player()?.getSnapshot().displayedFrame === 0
      );
    },
    relPath,
    { timeout: 30_000 },
  );
  await page.evaluate(() => window.__pa?.whenIdle());
}

async function segmentRows(page: Page): Promise<{ start: string; end: string; last: string }[]> {
  const rows = page.locator('[data-testid="segments-table"] tbody tr');
  const out: { start: string; end: string; last: string }[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const inputs = rows.nth(i).locator('input');
    out.push({
      start: await inputs.nth(0).inputValue(),
      end: await inputs.nth(1).inputValue(),
      last: (await rows.nth(i).locator('td').nth(3).innerText()).trim(),
    });
  }
  return out;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}${name}.png` });
}

test('annotate, export on Next, reload — keyboard and mouse, EN and 繁中', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__pa?.state().ready === true);
  await expect(page.locator('.wb-top')).toBeVisible();
  await shot(page, '00-empty-en');
  expect(errors, 'no console errors on load').toEqual([]);

  // ------------------------------------------------------------- open the OPFS batch
  await buildBatch(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await window.__pa?.openDirectoryHandle(await root.getDirectoryHandle('batch'));
  });
  const A = 'caseA/same_name.mp4';
  const B = 'caseB/same_name.mp4';
  await waitVideoReady(page, A);
  const items = await page.evaluate(() => window.__pa?.state().batch.items.map((i) => i.relPath));
  expect(items).toEqual([A, B, 'cfr25_bframes.mp4', 'vfr_mixed.mp4']);
  await expect(page.locator('[data-testid="batch-row"]')).toHaveCount(4);
  await expect(page.locator('[data-testid="frame-total"]')).toContainText('150');
  const a = manifest['same_name_a.mp4'];
  expect(await page.evaluate(() => window.__pa?.state().video.hash.sha256)).toBe(a.sha256);
  await expectSettledAt(page, 0);
  await shot(page, '01-opened-en');

  // ------------------------------------------------------------- mark with the keyboard
  const chips = page.locator('[data-testid="recent-chips"] button');
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
  const chip1 = (await chips.nth(0).getAttribute('title'))?.split(' · ') ?? [];
  const chip2 = (await chips.nth(1).getAttribute('title'))?.split(' · ') ?? [];
  await chips.nth(0).click();
  await expect(page.locator('[data-testid="selected-phase"]')).toContainText(chip1[0]);
  expect(await page.evaluate(() => window.__pa?.state().selectedPhaseId)).toBe(chip1[1]);

  // Shortcuts must work right after the mouse click on the chip.
  await page.keyboard.press('KeyD');
  await expectSettledAt(page, 1);
  await page.keyboard.press('KeyQ');
  await expect(page.locator('[data-testid="pending-start"]')).toContainText('1');
  expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(1);

  for (let i = 0; i < 10; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 11);
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.doc.segments.length)).toBe(1);
  expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(11);
  await expect(page.locator('[data-testid="pending-start"]')).toContainText('11');

  await page.keyboard.press('Digit2');
  await expect(page.locator('[data-testid="selected-phase"]')).toContainText(chip2[0]);

  // Jump with the frame field, then back to the shortcuts.
  await frameInput(page).click();
  await page.keyboard.type('140');
  await page.keyboard.press('Enter');
  await expectSettledAt(page, 140);
  await page.keyboard.press('KeyR');
  await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.doc.segments.length)).toBe(2);
  expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBeNull();

  const expected = [
    { phaseId: chip1[1], start: 1, end: 11 },
    { phaseId: chip2[1], start: 11, end: 150 },
  ];
  const segs = await page.evaluate(() => window.__pa?.state().editor.doc.segments.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
  expect(segs).toEqual(expected);
  expect(await segmentRows(page)).toEqual([
    { start: '1', end: '11', last: '10' },
    { start: '11', end: '150', last: '149' },
  ]);
  expect(await page.evaluate(() => window.__pa?.state().editor.issues)).toEqual([]);
  await page.evaluate(() => window.__pa?.flushAutosave());
  await expect(page.locator('[data-testid="save-state"]')).toContainText(/Saved/);
  await expect(page.locator('[data-testid="export-state"]')).toContainText('Unexported changes');
  await page.waitForTimeout(300); // let button transitions finish before the screenshot
  await shot(page, '02-marked-en');

  // ------------------------------------------------------------- Next: export gate
  await page.getByRole('button', { name: 'Next video' }).click();
  await waitVideoReady(page, B);
  const csv = await readOpfsText(page, 'caseA/same_name.phases.csv');
  expect(csv, 'CSV written beside caseA/same_name.mp4').not.toBeNull();
  expect(await listOpfs(page, 'caseB')).toEqual(['same_name.mp4']);
  const text = csv ?? '';
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).split('\r\n');
  expect(lines[lines.length - 1]).toBe('');
  const row = (phaseId: string, name: string, s: number, e: number): string =>
    ['1', a.sha256, a.frame_count, boundaryUs(a, a.frame_count), phaseId, name, s, e, boundaryUs(a, s), boundaryUs(a, e)].join(',');
  expect(lines.slice(0, -1)).toEqual([HEADER, row(chip1[1], chip1[0], 1, 11), row(chip2[1], chip2[0], 11, 150)]);

  const statusOf = (rel: string): Promise<string | undefined> =>
    page.evaluate((rel) => window.__pa?.state().batch.items.find((i) => i.relPath === rel)?.status, rel);
  await expect.poll(() => statusOf(A)).toBe('annotated');
  await expect(page.locator('[data-testid="batch-row"]').nth(0)).toContainText('Annotated');
  expect(await page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(0);
  // Same name, different video: its own (empty) state, nothing imported.
  expect(await page.evaluate(() => window.__pa?.state().editor.doc.segments.length)).toBe(0);
  expect(await page.evaluate(() => window.__pa?.state().video.hash.sha256)).toBe(manifest['same_name_b.mp4'].sha256);
  await shot(page, '03-next-en');

  // ------------------------------------------------------------- back: annotations reload
  await page.getByRole('button', { name: 'Previous video' }).click();
  await waitVideoReady(page, A);
  expect(await page.evaluate(() => window.__pa?.state().editor.doc.segments.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })))).toEqual(expected);
  expect(await segmentRows(page)).toEqual([
    { start: '1', end: '11', last: '10' },
    { start: '11', end: '150', last: '149' },
  ]);
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
  expect(await page.evaluate(() => window.__pa?.state().video.sidecars.map((s) => [s.name, s.state]))).toEqual([['same_name.phases.csv', 'match']]);

  // Clicking a segment row seeks to its start.
  await page.locator('[data-testid="segments-table"] tbody tr').nth(1).locator('td').nth(3).click();
  await expectSettledAt(page, 11);
  await shot(page, '04-reloaded-en');

  // ------------------------------------------------------------- 繁中
  await page.getByRole('radio', { name: '繁中' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', /zh/);
  await expect(page.getByRole('button', { name: '下一部影片' }).or(page.locator('.wb-filebar button').last())).toBeVisible();
  await shot(page, '05-reloaded-zh');
  await page.locator('[data-testid="batch-row"]').nth(2).click();
  await waitVideoReady(page, 'cfr25_bframes.mp4');
  await page.keyboard.press('KeyX');
  await expectSettledAt(page, manifest['cfr25_bframes.mp4'].frame_count - 1);
  await shot(page, '06-cfr-last-zh');

  // Back to English for the remaining checks.
  await page.getByRole('radio', { name: 'EN' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Narrow layout: still usable at 1100×760, no horizontal page overflow.
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, '07-narrow-en');
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.getByRole('radio', { name: '繁中' }).click();
  await page.waitForTimeout(200);
  await shot(page, '08-1280x760-zh');
  await page.getByRole('radio', { name: 'EN' }).click();

  // ------------------------------------------------------------- last video: leave warnings
  // Unexported edit on cfr25 (frame 249 is displayed): [249, 250) through the end.
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyR');
  await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.doc.segments.map((s) => [s.start, s.end]))).toEqual([[249, 250]]);
  await expect.poll(() => page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(1);
  await page.getByRole('banner').getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Close folder' }).click();
  const confirm = page.locator('[data-testid="confirm-close-dialog"]');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('1');
  await page.waitForTimeout(300); // dialog fade-in
  await shot(page, '09-confirm-close-en');
  await confirm.getByRole('button', { name: 'Leave anyway' }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__pa?.state().batch.mode)).toBe('none');
  // Leaving anyway does not export; the draft stays and the native warning still guards the tab.
  expect(await readOpfsText(page, 'cfr25_bframes.phases.csv')).toBeNull();
  expect(await page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(1);

  expect(errors, 'no console errors during the session').toEqual([]);

  const beforeUnload = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.type());
      void d.dismiss();
    });
  });
  await page.close({ runBeforeUnload: true });
  expect(await beforeUnload).toBe('beforeunload');
});
