/**
 * Helpers for tests/e2e/accuracy.spec.ts: fixture ground truth, OPFS folder building, UI driving
 * (keyboard, jump field, tabs) and an export parser that is independent of src/core/formats.
 */
import { expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../../../src/state/testHook';

export interface ManifestEntry {
  frame_count: number;
  sha256: string;
  pts_us: number[];
  time_base: string;
}

export const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/videos/manifest.json', import.meta.url)), 'utf8'),
) as Record<string, ManifestEntry>;

/**
 * Time of boundary N (end of the last presented frame) in integer µs, from the container:
 * edit-list segment duration == last presented pts + that sample's duration (ffprobe, time_base):
 *   cfr25_bframes 128000/12800, ntsc2997 300300/30000, vfr_mixed (1199429+1800)/90000,
 *   open_gop30 153600/15360, tiny3 3072/10240 — rounded half up to µs.
 */
export const DURATION_US: Readonly<Record<string, number>> = {
  'cfr25_bframes.mp4': 10_000_000,
  'ntsc2997.mp4': 10_010_000,
  'vfr_mixed.mp4': Math.round((1_201_229 * 1e6) / 90_000), // 13_346_989
  'open_gop30.mp4': 10_000_000,
  'tiny3.mp4': 300_000,
  'long720p_gop300.mp4': 120_000_000,
};

export function boundaryUs(name: string, b: number): number {
  const e = manifest[name];
  return b === e.frame_count ? DURATION_US[name] : e.pts_us[b];
}

/** HH:MM:SS.mmm with milliseconds truncated (the format the transport bar uses). */
export function timecode(us: number): string {
  const totalMs = Math.floor(us / 1000);
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  const ms = totalMs % 1000;
  const sec = Math.floor(totalMs / 1000);
  return `${p(Math.floor(sec / 3600), 2)}:${p(Math.floor(sec / 60) % 60, 2)}:${p(sec % 60, 2)}.${p(ms, 3)}`;
}

// ------------------------------------------------------------------------------------------- OPFS

export type FolderEntry = { path: string; fixture: string } | { path: string; text: string };

/** Creates OPFS `/<root>/` with fixture videos (fetched from the dev server) and text files. */
export async function buildFolder(page: Page, root: string, entries: FolderEntry[]): Promise<void> {
  await page.evaluate(
    async ({ root, entries }) => {
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry(root, { recursive: true }).catch(() => undefined);
      const base = await opfs.getDirectoryHandle(root, { create: true });
      for (const e of entries) {
        const parts = e.path.split('/');
        let dir = base;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        let data: Blob | string;
        if ('fixture' in e) {
          const res = await fetch(`/tests/fixtures/videos/${e.fixture}`);
          if (!res.ok) throw new Error(`fetch ${e.fixture}: ${res.status}`);
          data = await res.blob();
        } else data = e.text;
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
      }
    },
    { root, entries },
  );
}

export async function readOpfsText(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/');
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await (await fh.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }, path);
}

export async function listOpfs(page: Page, path: string): Promise<string[]> {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    for (const p of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(p);
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  }, path);
}

export async function openOpfsFolder(page: Page, root: string): Promise<void> {
  await page.evaluate(async (root) => {
    const opfs = await navigator.storage.getDirectory();
    await window.__pa?.openDirectoryHandle(await opfs.getDirectoryHandle(root));
  }, root);
}

/** Replaces showOpenFilePicker so the next "Import file…" click picks OPFS `path`. */
export async function stubOpenFilePicker(page: Page, path: string): Promise<void> {
  await page.evaluate((path) => {
    const w = window as unknown as { showOpenFilePicker: unknown; __pickerCalls: unknown[] };
    w.__pickerCalls = [];
    w.showOpenFilePicker = async (opts: unknown) => {
      w.__pickerCalls.push(opts);
      let dir = await navigator.storage.getDirectory();
      const parts = path.split('/');
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      return [await dir.getFileHandle(parts[parts.length - 1])];
    };
  }, path);
}

// ------------------------------------------------------------------------------------------- page

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__pa?.state().ready === true);
}

export async function waitVideoReady(page: Page, relPath: string): Promise<void> {
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

export function frameInput(page: Page): Locator {
  return page.locator('input[data-testid="frame-input"], [data-testid="frame-input"] input').first();
}

export interface FrameView {
  counter: string;
  displayed: number | null;
  requested: number | null;
  barcode: number | null;
  timecode: string;
  total: string;
}

export async function frameView(page: Page): Promise<FrameView> {
  const [counter, timecodeText, total] = await Promise.all([
    frameInput(page).inputValue(),
    page.locator('[data-testid="timecode"]').innerText(),
    page.locator('[data-testid="frame-total"]').innerText(),
  ]);
  const p = await page.evaluate(() => {
    const snap = window.__pa?.player()?.getSnapshot();
    return { displayed: snap?.displayedFrame ?? null, requested: snap?.requestedFrame ?? null, barcode: window.__pa?.readBarcode() ?? null };
  });
  return { counter, timecode: timecodeText.trim(), total: total.replace(/[^0-9]/g, ''), ...p };
}

/**
 * Waits until the counter, the player and the canvas barcode all show `frame`, then checks the
 * timecode against the manifest pts.
 */
export async function expectSettledAt(page: Page, name: string, frame: number): Promise<void> {
  await expect(frameInput(page)).toHaveValue(String(frame));
  await page.waitForFunction(
    (f) => {
      const pa = window.__pa;
      const snap = pa?.player()?.getSnapshot();
      return snap?.displayedFrame === f && snap.requestedFrame === null && pa?.readBarcode() === f;
    },
    frame,
    { timeout: 15_000 },
  );
  const v = await frameView(page);
  expect(v, `frame ${frame} of ${name}`).toEqual({
    counter: String(frame),
    displayed: frame,
    requested: null,
    barcode: frame,
    timecode: timecode(manifest[name].pts_us[frame]),
    total: String(manifest[name].frame_count),
  });
}

/**
 * Clicks the jump field (which selects its text), types a frame number with the real keyboard and
 * commits with Enter (focus then returns to the page so shortcuts work again).
 */
export async function jumpTo(page: Page, frame: number): Promise<void> {
  const input = frameInput(page);
  // Typing the number already shown is a no-op that leaves focus in the field (bug, covered by
  // the dedicated "same frame" test); skip it here so the accuracy flows are not derailed.
  if ((await input.inputValue()) === String(frame) && (await page.evaluate(() => document.activeElement?.tagName)) !== 'INPUT') return;
  await input.click();
  await page.keyboard.type(String(frame));
  await page.keyboard.press('Enter');
}

export async function clickTab(page: Page, name: 'Segments' | 'Checkpoints' | 'Export'): Promise<void> {
  // The accessible name includes the count badge ("Segments3").
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}

export interface Row {
  start: string;
  end: string;
  last: string;
}

export async function segmentRows(page: Page): Promise<Row[]> {
  const rows = page.locator('[data-testid="segments-table"] tbody tr');
  const out: Row[] = [];
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

export interface SimpleSeg {
  phaseId: string;
  start: number;
  end: number;
}

export async function stateSegments(page: Page): Promise<SimpleSeg[]> {
  return page.evaluate(
    () => window.__pa?.state().editor.doc.segments.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })) ?? [],
  );
}

// ------------------------------------------------------------------------------------- formats

export const CSV_HEADER = [
  'format_version',
  'video_sha256',
  'frame_count',
  'duration_us',
  'phase_id',
  'phase_name',
  'start_frame',
  'end_frame',
  'start_us',
  'end_us',
];

/** RFC 4180 parser (quoted fields, doubled quotes, CR/LF inside quotes). Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
      i++;
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface ExportRecord {
  phase_id: string;
  phase_name: string;
  start_frame: number;
  end_frame: number;
  start_us: number;
  end_us: number;
}

export interface ParsedExport {
  format_version: number;
  sha256: string;
  frame_count: number;
  duration_us: number;
  records: ExportRecord[];
}

const unprotect = (s: string): string => (s.startsWith("'") ? s.slice(1) : s);

export function parseCsvExport(text: string): ParsedExport {
  expect(text.charCodeAt(0), 'CSV starts with a UTF-8 BOM').toBe(0xfeff);
  expect(text.endsWith('\r\n'), 'CSV ends with CRLF').toBe(true);
  const rows = parseCsv(text.slice(1));
  expect(rows[0]).toEqual(CSV_HEADER);
  const body = rows.slice(1);
  expect(body.length).toBeGreaterThan(0);
  for (const r of body) expect(r.length).toBe(CSV_HEADER.length);
  const first = body[0];
  for (const r of body) expect(r.slice(0, 4), 'video columns repeat on every row').toEqual(first.slice(0, 4));
  const records = body
    .filter((r) => r[6] !== '')
    .map((r) => ({
      phase_id: unprotect(r[4]),
      phase_name: unprotect(r[5]),
      start_frame: Number(r[6]),
      end_frame: Number(r[7]),
      start_us: Number(r[8]),
      end_us: Number(r[9]),
    }));
  return { format_version: Number(first[0]), sha256: first[1], frame_count: Number(first[2]), duration_us: Number(first[3]), records };
}

export function parseJsonExport(text: string): ParsedExport {
  expect(text.charCodeAt(0), 'JSON has no BOM').not.toBe(0xfeff);
  const j = JSON.parse(text) as {
    format: string;
    format_version: number;
    video: { sha256: string; frame_count: number; duration_us: number; file_name: string };
    segments: ExportRecord[];
  };
  expect(j.format).toBe('phase-annotations');
  return {
    format_version: j.format_version,
    sha256: j.video.sha256,
    frame_count: j.video.frame_count,
    duration_us: j.video.duration_us,
    records: j.segments,
  };
}

/** Asserts an export against the manifest and the expected segments (frames and phase ids). */
export function expectExportMatches(
  parsed: ParsedExport,
  name: string,
  expected: SimpleSeg[],
  phaseNames: Record<string, string>,
): void {
  const e = manifest[name];
  expect(parsed.format_version).toBe(1);
  expect(parsed.sha256).toBe(e.sha256);
  expect(parsed.frame_count).toBe(e.frame_count);
  expect(parsed.duration_us, 'duration_us = end of the last frame').toBe(DURATION_US[name]);
  expect(parsed.records).toEqual(
    expected.map((s) => ({
      phase_id: s.phaseId,
      phase_name: phaseNames[s.phaseId],
      start_frame: s.start,
      end_frame: s.end,
      start_us: boundaryUs(name, s.start),
      end_us: boundaryUs(name, s.end),
    })),
  );
  for (const r of parsed.records) {
    expect(Number.isInteger(r.start_us) && Number.isInteger(r.end_us)).toBe(true);
  }
}
