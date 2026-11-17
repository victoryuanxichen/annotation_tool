/**
 * Helpers for tests/e2e/recovery.spec.ts (REQUIREMENTS §5: crash recovery, checkpoints, stale tabs,
 * leave warnings, offline). Folders are built in OPFS from the synthetic fixtures; the app is
 * driven through window.__pa plus real keyboard/mouse input, and IndexedDB is read directly so the
 * assertions check what was actually committed, not what the UI believes.
 */
import { expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../../../src/state/testHook';

export interface ManifestEntry {
  frame_count: number;
  sha256: string;
  size: number;
  pts_us: number[];
}

export const FIXTURES = fileURLToPath(new URL('../../fixtures/videos/', import.meta.url));
export const manifest = JSON.parse(readFileSync(`${FIXTURES}manifest.json`, 'utf8')) as Record<string, ManifestEntry>;

/** A file in an OPFS test folder: a fixture copied as-is, optionally followed by an MP4 `free` box. */
export interface LayoutFile {
  path: string;
  fixture: string;
  /** Payload bytes of a trailing `free` box (zeros). The box adds 8 + padBytes bytes. */
  padBytes?: number;
}

export interface SegView {
  phaseId: string;
  start: number;
  end: number;
}

export interface DraftRow {
  key: string;
  sha256: string | null;
  fingerprint: string;
  fileName: string;
  revision: number;
  savedBy: string;
  segments: SegView[];
  exported: { contentHash: string } | null;
  contentHash: string;
}

export interface CheckpointRow {
  id: string;
  videoKey: string;
  name: string;
  kind: string;
  createdAt: number;
  segments: SegView[];
}

/** SHA-256 of a fixture followed by a zero-filled `free` box, computed the same way in node. */
export function paddedSha256(fixture: string, padBytes: number): string {
  const h = createHash('sha256');
  h.update(readFileSync(FIXTURES + fixture));
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + padBytes, 0);
  hdr.write('free', 4, 'latin1');
  h.update(hdr);
  const zeros = Buffer.alloc(16 << 20);
  for (let left = padBytes; left > 0; ) {
    const n = Math.min(left, zeros.length);
    h.update(n === zeros.length ? zeros : zeros.subarray(0, n));
    left -= n;
  }
  return h.digest('hex');
}

/** Loads the app and waits for settings/library to be loaded. */
export async function gotoApp(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => window.__pa?.state().ready === true);
}

/**
 * Builds `root/<folder>` in OPFS. Fixture bytes come from the dev server (`/tests/fixtures/...`)
 * unless `inline` supplies them (production server, which does not serve the fixtures).
 */
export async function buildFolder(page: Page, folder: string, layout: LayoutFile[], inline?: Record<string, string>): Promise<void> {
  await page.evaluate(
    async ({ folder, layout, inline }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
      const base = await root.getDirectoryHandle(folder, { create: true });
      for (const f of layout) {
        const parts = f.path.split('/');
        let dir = base;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        let blob: Blob;
        if (inline && inline[f.fixture]) {
          const bin = atob(inline[f.fixture]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          blob = new Blob([bytes]);
        } else {
          const res = await fetch(`/tests/fixtures/videos/${f.fixture}`);
          if (!res.ok) throw new Error(`fetch ${f.fixture}: ${res.status}`);
          blob = await res.blob();
        }
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        if (f.padBytes) {
          const hdr = new Uint8Array(8);
          new DataView(hdr.buffer).setUint32(0, 8 + f.padBytes);
          hdr.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
          await w.write(hdr);
          const chunk = new Uint8Array(16 << 20);
          for (let left = f.padBytes; left > 0; ) {
            const n = Math.min(left, chunk.length);
            await w.write(n === chunk.length ? chunk : chunk.subarray(0, n));
            left -= n;
          }
        }
        await w.close();
      }
    },
    { folder, layout, inline: inline ?? null },
  );
}

export async function removeFolder(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
  }, folder);
}

/** Opens `root/<folder>` like "Open folder"; resolves once the first video is ready or failed. */
export async function openFolder(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    await window.__pa?.openDirectoryHandle(await root.getDirectoryHandle(folder));
  }, folder);
}

/**
 * After a reload the app reconnects the remembered folder by itself (OPFS handles are always
 * granted). Waits for that; opens it explicitly only if the app did not.
 */
export async function reopenFolder(page: Page, folder: string): Promise<'auto' | 'manual'> {
  const auto = await page
    .waitForFunction(() => window.__pa?.state().batch.mode === 'folder', undefined, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (auto) return 'auto';
  await openFolder(page, folder);
  return 'manual';
}

/** Waits until `relPath` is open and displayed; `hash: 'done'` also waits for the full SHA-256. */
export async function waitVideoReady(page: Page, relPath: string, opts: { hash?: 'done' | 'any'; timeout?: number } = {}): Promise<void> {
  const hash = opts.hash ?? 'done';
  await page.waitForFunction(
    ({ rel, hash }) => {
      const s = window.__pa?.state();
      if (!s || s.video.relPath !== rel || s.video.loadPhase !== 'ready') return false;
      if (window.__pa?.player()?.getSnapshot().displayedFrame === null) return false;
      return hash === 'any' || (s.video.hash.state === 'done' && s.video.identity === 'verified');
    },
    { rel: relPath, hash },
    { timeout: opts.timeout ?? 30_000 },
  );
  if (hash === 'done') await page.evaluate(() => window.__pa?.whenIdle());
}

export function frameInput(page: Page): Locator {
  return page.locator('input[data-testid="frame-input"], [data-testid="frame-input"] input').first();
}

/** Seeks with the jump-to-frame field and waits until counter, player and barcode agree. */
export async function jumpTo(page: Page, frame: number): Promise<void> {
  const input = frameInput(page);
  await input.click();
  await input.selectText();
  // Typed like a user (fill() would not register as an edit when the value is unchanged).
  await page.keyboard.type(String(frame));
  await page.keyboard.press('Enter');
  await expect(input, 'Enter releases the field so shortcuts reach the video').not.toBeFocused();
  await expect(input).toHaveValue(String(frame));
  await page.waitForFunction(
    (f) => {
      const pa = window.__pa;
      const snap = pa?.player()?.getSnapshot();
      return snap?.displayedFrame === f && snap.requestedFrame === null && pa?.readBarcode() === f;
    },
    frame,
  );
}

/** Clicks recent-phase chip `slot` (0-based) and returns its phase id. */
export async function pickChip(page: Page, slot: number): Promise<string> {
  const chip = page.locator('[data-testid="recent-chips"] button').nth(slot);
  const id = ((await chip.getAttribute('title')) ?? '').split(' · ')[1];
  await chip.click();
  await expect.poll(() => page.evaluate(() => window.__pa?.state().selectedPhaseId)).toBe(id);
  return id;
}

export async function segments(page: Page): Promise<SegView[]> {
  return page.evaluate(() => (window.__pa?.state().editor.doc.segments ?? []).map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
}

/** Marks [start, end) with phase chip `slot` using Q/W from the keyboard. */
export async function markSegment(page: Page, slot: number, start: number, end: number): Promise<SegView> {
  const phaseId = await pickChip(page, slot);
  const before = (await segments(page)).length;
  await jumpTo(page, start);
  await page.keyboard.press('KeyQ');
  await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(start);
  await jumpTo(page, end);
  await page.keyboard.press('KeyW');
  await expect.poll(async () => (await segments(page)).length).toBe(before + 1);
  return { phaseId, start, end };
}

/** Waits for the top bar to report "Saved" (the debounced autosave has committed). */
export async function waitSaved(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__pa?.state().save.kind), { timeout: 10_000 }).toBe('saved');
  await expect(page.locator('[data-testid="save-state"]')).toContainText(/Saved/);
}

/** Raw rows of the IndexedDB `drafts` store (reads the app database directly). */
export async function readDrafts(page: Page): Promise<DraftRow[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('phase-annotator');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      if (!db.objectStoreNames.contains('drafts')) return [];
      const rows = await new Promise<unknown[]>((res, rej) => {
        const r = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
        r.onsuccess = () => res(r.result as unknown[]);
        r.onerror = () => rej(r.error);
      });
      return (rows as Array<Record<string, unknown> & { segments: Array<{ phaseId: string; start: number; end: number }> }>).map((d) => ({
        key: d.key as string,
        sha256: d.sha256 as string | null,
        fingerprint: d.fingerprint as string,
        fileName: d.fileName as string,
        revision: d.revision as number,
        savedBy: d.savedBy as string,
        contentHash: d.contentHash as string,
        exported: (d.exported as { contentHash: string } | null) ?? null,
        segments: d.segments.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })),
      }));
    } finally {
      db.close();
    }
  });
}

export async function readCheckpoints(page: Page): Promise<CheckpointRow[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('phase-annotator');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      if (!db.objectStoreNames.contains('checkpoints')) return [];
      const rows = await new Promise<unknown[]>((res, rej) => {
        const r = db.transaction('checkpoints', 'readonly').objectStore('checkpoints').getAll();
        r.onsuccess = () => res(r.result as unknown[]);
        r.onerror = () => rej(r.error);
      });
      return (rows as Array<Record<string, unknown> & { segments: Array<{ phaseId: string; start: number; end: number }> }>)
        .map((c) => ({
          id: c.id as string,
          videoKey: c.videoKey as string,
          name: c.name as string,
          kind: c.kind as string,
          createdAt: c.createdAt as number,
          segments: c.segments.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })),
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
    } finally {
      db.close();
    }
  });
}

export async function draftFor(page: Page, key: string): Promise<DraftRow | undefined> {
  return (await readDrafts(page)).find((d) => d.key === key);
}

/** Collects page errors and console errors so each test can assert a clean session. */
export function collectErrors(page: Page, ignore: RegExp[] = []): string[] {
  const errors: string[] = [];
  const keep = (s: string): void => {
    if (!ignore.some((r) => r.test(s))) errors.push(s);
  };
  page.on('pageerror', (e) => keep(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') keep(`console: ${m.text()}`);
  });
  return errors;
}
