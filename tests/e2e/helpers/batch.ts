/**
 * Helpers for tests/e2e/batch.spec.ts: OPFS batch folders built from the synthetic fixtures,
 * independent CSV/JSON sidecar writers (SPEC §2.1, written from the spec, not from src/core),
 * IndexedDB draft reads, a batch-status recorder and a write-permission denial switch.
 */
import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../../../src/state/testHook';

export interface ManifestEntry {
  frame_count: number;
  sha256: string;
  size: number;
  pts_us: number[];
}

export const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/videos/manifest.json', import.meta.url)), 'utf8'),
) as Record<string, ManifestEntry>;

export const HEADER = 'format_version,video_sha256,frame_count,duration_us,phase_id,phase_name,start_frame,end_frame,start_us,end_us';

/**
 * End of the last presented frame, [ticks, timescale], from ffprobe (last packet pts + duration):
 *   ffprobe -select_streams v:0 -show_entries packet=pts,duration -of csv=p=0 <file> | sort -n | tail -1
 * The manifest has no per-frame durations, and for VFR / 24000-tick fixtures "last pts + last
 * pts delta" is not the container's end time.
 */
const END_TICKS: Record<string, [number, number]> = {
  'baseline24_nob.mp4': [60928 + 512, 12288],
  'cfr25_bframes.mp4': [127488 + 512, 12800],
  'long720p_gop300.mp4': [1842688 + 512, 15360],
  'ntsc2997.mp4': [299299 + 1001, 30000],
  'open_gop30.mp4': [153088 + 512, 15360],
  'same_name_a.mp4': [76288 + 512, 12800],
  'same_name_b.mp4': [76288 + 512, 12800],
  'tiny3.mp4': [2048 + 1024, 10240],
  'vfr_mixed.mp4': [1199429 + 1800, 90000],
};

function fixtureOf(e: ManifestEntry): string {
  const name = Object.keys(manifest).find((k) => manifest[k] === e);
  if (!name) throw new Error('unknown manifest entry');
  return name;
}

/** Boundary time in µs: pts of frame b, or the end of the last frame for b = N. */
export function boundaryUs(e: ManifestEntry, b: number): number {
  if (b < e.frame_count) return e.pts_us[b];
  const [ticks, ts] = END_TICKS[fixtureOf(e)];
  return Math.round((ticks * 1_000_000) / ts);
}

export interface Seg {
  phaseId: string;
  phaseName: string;
  start: number;
  end: number;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function protect(text: string): string {
  return /^[=+\-@\t\r\n']/.test(text) ? `'${text}` : text;
}

export interface VideoMeta {
  sha256: string;
  frameCount: number;
  durationUs: number;
}

export function metaOf(fixture: string): VideoMeta {
  const e = manifest[fixture];
  return { sha256: e.sha256, frameCount: e.frame_count, durationUs: boundaryUs(e, e.frame_count) };
}

/** CSV export per SPEC §2.1 (BOM, CRLF, one row per segment; one metadata-only row when empty). */
export function buildCsv(fixture: string, segs: readonly Seg[], override: Partial<VideoMeta> = {}): string {
  const e = manifest[fixture];
  const m = { ...metaOf(fixture), ...override };
  const video = ['1', m.sha256, m.frameCount, m.durationUs];
  const rows = segs.length
    ? segs.map((s) => [...video, protect(s.phaseId), protect(s.phaseName), s.start, s.end, boundaryUs(e, Math.min(s.start, e.frame_count)), boundaryUs(e, Math.min(s.end, e.frame_count))])
    : [[...video, '', '', '', '', '', '']];
  return '﻿' + [HEADER, ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

export function jsonDoc(fixture: string, fileName: string, segs: readonly Seg[]): unknown {
  const e = manifest[fixture];
  const m = metaOf(fixture);
  return {
    format: 'phase-annotations',
    format_version: 1,
    video: { sha256: m.sha256, frame_count: m.frameCount, duration_us: m.durationUs, file_name: fileName },
    segments: segs.map((s) => ({
      phase_id: s.phaseId,
      phase_name: s.phaseName,
      start_frame: s.start,
      end_frame: s.end,
      start_us: boundaryUs(e, s.start),
      end_us: boundaryUs(e, s.end),
    })),
  };
}

export function buildJson(fixture: string, fileName: string, segs: readonly Seg[]): string {
  return JSON.stringify(jsonDoc(fixture, fileName, segs), null, 2) + '\n';
}

/** One OPFS entry: a fixture video copied from the dev server, or literal text. */
export type LayoutEntry = { path: string; fixture: string } | { path: string; text: string };

/**
 * (Re)creates OPFS folder `root` with the given entries, written in array order. `gapMs` waits
 * between files so their modification times are strictly increasing in that order.
 */
export async function buildFolder(page: Page, root: string, layout: readonly LayoutEntry[], gapMs = 0): Promise<void> {
  await page.evaluate(
    async ({ root, layout, gapMs }) => {
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry(root, { recursive: true }).catch(() => undefined);
      const base = await opfs.getDirectoryHandle(root, { create: true });
      for (const entry of layout) {
        const parts = entry.path.split('/');
        let dir = base;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        let body: Blob | string;
        if ('fixture' in entry) {
          const res = await fetch(`/tests/fixtures/videos/${entry.fixture}`);
          if (!res.ok) throw new Error(`fetch ${entry.fixture}: ${res.status}`);
          body = await res.blob();
        } else body = entry.text;
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(body);
        await w.close();
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      }
    },
    { root, layout: layout as LayoutEntry[], gapMs },
  );
}

export async function writeOpfsText(page: Page, rel: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ rel, text }) => {
      let dir = await navigator.storage.getDirectory();
      const parts = rel.split('/');
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
    { rel, text },
  );
}

/** Reads an OPFS file (path from the OPFS root) keeping any BOM; null when missing. */
export async function readOpfsText(page: Page, rel: string): Promise<string | null> {
  return page.evaluate(async (rel) => {
    let dir = await navigator.storage.getDirectory();
    const parts = rel.split('/');
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await (await fh.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }, rel);
}

export async function listOpfs(page: Page, rel: string): Promise<string[]> {
  return page.evaluate(async (rel) => {
    let dir = await navigator.storage.getDirectory();
    for (const p of rel.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(p);
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  }, rel);
}

export async function openFolder(page: Page, root: string): Promise<void> {
  await page.evaluate(async (root) => {
    const opfs = await navigator.storage.getDirectory();
    await window.__pa?.openDirectoryHandle(await opfs.getDirectoryHandle(root));
  }, root);
}

export async function gotoApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  // Accept beforeunload prompts (reloads with unexported changes).
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await page.waitForFunction(() => window.__pa?.state().ready === true);
  return errors;
}

/** Waits until `relPath` (file name for single files, which have no relPath) is open, indexed, hashed, identity-verified and frame 0 is displayed. */
export async function waitVideoReady(page: Page, relPath: string): Promise<void> {
  await page.waitForFunction(
    (rel) => {
      const s = window.__pa?.state();
      return (
        (s?.video.relPath ?? s?.video.fileName) === rel &&
        s?.video.relPath !== undefined &&
        s.video.loadPhase === 'ready' &&
        s.video.hash.state === 'done' &&
        s.video.identity === 'verified' &&
        window.__pa?.player()?.getSnapshot().displayedFrame === 0
      );
    },
    relPath,
    { timeout: 30_000 },
  );
  await idle(page);
}

export async function idle(page: Page): Promise<void> {
  await page.evaluate(() => window.__pa?.whenIdle());
}

export interface ItemView {
  relPath: string;
  status: string;
  detail: string | null;
  segmentCount: number | null;
  size: number;
  lastModified: number;
}

export async function items(page: Page): Promise<ItemView[]> {
  return page.evaluate(
    () =>
      window.__pa?.state().batch.items.map((i) => ({
        relPath: i.relPath,
        status: i.status,
        detail: i.statusDetail?.key ?? null,
        segmentCount: i.segmentCount,
        size: i.size,
        lastModified: i.lastModified,
      })) ?? [],
  );
}

export async function itemOf(page: Page, relPath: string): Promise<ItemView | undefined> {
  return (await items(page)).find((i) => i.relPath === relPath);
}

export async function segsOf(page: Page): Promise<{ phaseId: string; start: number; end: number }[]> {
  return page.evaluate(() => window.__pa?.state().editor.doc.segments.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })) ?? []);
}

export async function sidecarsOf(page: Page): Promise<{ name: string; state: string; problems: string[]; segmentCount: number | null }[]> {
  return page.evaluate(
    () =>
      window.__pa?.state().video.sidecars.map((s) => ({ name: s.name, state: s.state, problems: s.problems.map((p) => p.key), segmentCount: s.segmentCount })) ?? [],
  );
}

/** Two phases from the library (first visible chips) with their names. */
export async function twoPhases(page: Page): Promise<[{ id: string; name: string }, { id: string; name: string }]> {
  return page.evaluate(() => {
    const s = window.__pa?.state();
    if (!s) throw new Error('no app');
    const ids = s.visibleRecent.length >= 2 ? s.visibleRecent : Object.keys(s.library.phases);
    const pick = (id: string): { id: string; name: string } => ({ id, name: s.library.phases[id].name });
    return [pick(ids[0]), pick(ids[1])];
  });
}

/**
 * Adds segments through the controller actions (select phase, seek, Q, seek, W / R). Every
 * boundary is committed only after the player confirms the displayed frame (controller rule).
 */
export async function addSegments(page: Page, segs: readonly { phaseId: string; start: number; end: number }[]): Promise<void> {
  for (const seg of segs) {
    await page.evaluate(async ({ phaseId, start, end }) => {
      const pa = window.__pa;
      const player = pa?.player();
      if (!pa || !player) throw new Error('no player');
      pa.actions.selectPhase(phaseId);
      await player.seek(start);
      await pa.actions.markStart();
      if (end === pa.state().video.frameCount) await pa.actions.markThroughEnd();
      else {
        await player.seek(end);
        await pa.actions.markFinish();
      }
    }, seg);
  }
  const expected = segs.length;
  await expect.poll(async () => (await segsOf(page)).length).toBeGreaterThanOrEqual(expected);
}

/** Reads a draft record straight from IndexedDB (`phase-annotator` / `drafts`). */
export async function readDraft(page: Page, key: string): Promise<{ key: string; segments: { start: number; end: number; phaseId: string }[]; exported: unknown; touched?: boolean } | null> {
  return page.evaluate(
    (key) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('phase-annotator');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const get = db.transaction('drafts', 'readonly').objectStore('drafts').get(key);
          get.onsuccess = () => {
            resolve(get.result ?? null);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    key,
  );
}

/** Records every batch status each item passes through (polled every few ms). */
export async function startStatusRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: Record<string, string[]> = {};
    (window as unknown as { __statusLog: Record<string, string[]> }).__statusLog = log;
    const tick = (): void => {
      for (const it of window.__pa?.state().batch.items ?? []) {
        const seen = (log[it.relPath] ??= []);
        if (seen[seen.length - 1] !== it.status) seen.push(it.status);
      }
    };
    tick();
    setInterval(tick, 1);
  });
}

export async function statusLog(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => (window as unknown as { __statusLog: Record<string, string[]> }).__statusLog);
}

/**
 * Simulates the user denying the write-permission prompt (Chrome's File System Access permission
 * model) for every handle inside OPFS folder `root` (the root included):
 * `queryPermission({mode:'readwrite'})` reports 'prompt' and `requestPermission` resolves
 * 'denied'. Read access and handles elsewhere are unaffected. This patches the browser API from
 * the test; OPFS itself never denies writes and the app has no hook for it.
 */
export async function denyWritePermission(page: Page, root: string): Promise<void> {
  await page.evaluate(async (root) => {
    type PermHandle = FileSystemHandle & {
      queryPermission?(d: { mode: string }): Promise<PermissionState>;
      requestPermission?(d: { mode: string }): Promise<PermissionState>;
    };
    const denied = await (await navigator.storage.getDirectory()).getDirectoryHandle(root);
    const inside = async (h: FileSystemHandle): Promise<boolean> => (await denied.resolve(h)) !== null;
    const proto = FileSystemHandle.prototype as unknown as PermHandle;
    const origQuery = proto.queryPermission;
    const origRequest = proto.requestPermission;
    const log: string[] = [];
    (window as unknown as { __permLog: string[] }).__permLog = log;
    proto.queryPermission = async function (this: PermHandle, d) {
      const deny = d?.mode === 'readwrite' && (await inside(this));
      log.push(`query:${this.name}:${d?.mode}:${deny ? 'prompt' : 'pass'}`);
      if (deny) return 'prompt';
      return origQuery ? origQuery.call(this, d) : 'granted';
    };
    proto.requestPermission = async function (this: PermHandle, d) {
      const deny = d?.mode === 'readwrite' && (await inside(this));
      log.push(`request:${this.name}:${d?.mode}:${deny ? 'denied' : 'pass'}`);
      if (deny) return 'denied';
      return origRequest ? origRequest.call(this, d) : 'granted';
    };
  }, root);
}

export async function permLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __permLog?: string[] }).__permLog ?? []);
}

/** Makes showDirectoryPicker() resolve to OPFS folder `name` (as if the user picked it). */
export async function stubDirectoryPicker(page: Page, name: string): Promise<void> {
  await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
  }, name);
}
