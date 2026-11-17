/**
 * REQUIREMENTS §5 — recovery: crash recovery (close without beforeunload, hard reload, renderer
 * crash), the full-hash window right after opening a large video, renamed copies, named
 * checkpoints, stale tabs, the unexported-changes warning on the last video, and offline use
 * (dev server and the production build served by server/serve.mjs).
 *
 * Every recovery claim is checked against the IndexedDB `drafts` / `checkpoints` stores, not only
 * against what the UI shows.
 */
import { test, expect, chromium, type Page, type BrowserContext, type Request } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  FIXTURES,
  buildFolder,
  collectErrors,
  draftFor,
  gotoApp,
  jumpTo,
  manifest,
  markSegment,
  openFolder,
  paddedSha256,
  pickChip,
  readCheckpoints,
  readDrafts,
  reopenFolder,
  segments,
  waitSaved,
  waitVideoReady,
  type SegView,
} from './helpers/recovery';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('../artifacts/recovery/', import.meta.url));
mkdirSync(ARTIFACTS, { recursive: true });

const CFR = manifest['cfr25_bframes.mp4'];
const VFR = manifest['vfr_mixed.mp4'];

/** Three segments on cfr25 (N = 250): adjacent pair via E, then one through the end via R. */
async function markThreeSegments(page: Page): Promise<SegView[]> {
  const p0 = await pickChip(page, 0);
  await jumpTo(page, 5);
  await page.keyboard.press('KeyQ');
  await jumpTo(page, 40);
  await page.keyboard.press('KeyE');
  await expect.poll(() => segments(page)).toEqual([{ phaseId: p0, start: 5, end: 40 }]);
  const p1 = await pickChip(page, 1);
  await jumpTo(page, 90);
  await page.keyboard.press('KeyW');
  const p2 = await pickChip(page, 2);
  await jumpTo(page, 200);
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyR');
  const expected = [
    { phaseId: p0, start: 5, end: 40 },
    { phaseId: p1, start: 40, end: 90 },
    { phaseId: p2, start: 200, end: 250 },
  ];
  await expect.poll(() => segments(page)).toEqual(expected);
  return expected;
}

/** A persistent (on-disk) profile: survives a browser restart and holds multi-GiB OPFS files. */
function launchProfile(dir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: !process.env.HEADED,
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
  });
}

async function newAppPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await gotoApp(page);
  return page;
}

// ============================================================================ crash recovery

test.describe('crash recovery', () => {
  const FOLDER = 'crash';
  const LAYOUT = [
    { path: 'case_cfr.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'case_vfr.mp4', fixture: 'vfr_mixed.mp4' },
  ];

  /** Marks, waits for "Saved", kills the page with `kill`, reopens → identical draft. */
  async function crashAndRecover(context: BrowserContext, page: Page, kill: (p: Page) => Promise<Page>): Promise<void> {
    await buildFolder(page, FOLDER, LAYOUT);
    await openFolder(page, FOLDER);
    await waitVideoReady(page, 'case_cfr.mp4');
    const expected = await markThreeSegments(page);
    await waitSaved(page);
    const before = await draftFor(page, CFR.sha256);
    expect(before, 'draft committed under the full SHA-256').toBeDefined();
    expect(before?.segments).toEqual(expected);
    expect(await page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(1);

    const next = await kill(page);
    expect(await reopenFolder(next, FOLDER), 'the remembered folder reconnects by itself').toBe('auto');
    await waitVideoReady(next, 'case_cfr.mp4');
    expect(await segments(next), 'segments restored after the kill').toEqual(expected);
    const after = await draftFor(next, CFR.sha256);
    expect(after?.revision, 'reopening does not rewrite the draft').toBe(before?.revision);
    expect(after?.segments).toEqual(expected);
    const s = await next.evaluate(() => {
      const st = window.__pa!.state();
      return { touched: st.editor.touched, dirty: st.editor.dirty, exp: st.exportStatus.kind, unexported: st.unexportedCount, identity: st.video.identity };
    });
    expect(s).toEqual({ touched: true, dirty: true, exp: 'dirty', unexported: 1, identity: 'verified' });
    await expect(next.locator('[data-testid="export-state"]')).toContainText('Unexported changes');
    const rows = next.locator('[data-testid="segments-table"] tbody tr');
    await expect(rows).toHaveCount(3);
  }

  test('close without beforeunload → reopen restores the draft', async ({ context, page }) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await crashAndRecover(context, page, async (p) => {
      await p.close({ runBeforeUnload: false });
      return newAppPage(context);
    });
    expect(errors).toEqual([]);
  });

  test('hard reload → draft restored', async ({ context, page }) => {
    await gotoApp(page);
    await crashAndRecover(context, page, async (p) => {
      // The unexported-changes warning would otherwise cancel the reload.
      p.on('dialog', (d) => void d.accept());
      await p.reload({ waitUntil: 'load' });
      await p.waitForFunction(() => window.__pa?.state().ready === true);
      return p;
    });
  });

  test('reload and tab close right after an edit (inside the autosave debounce) keep the edit', async ({ context, page }) => {
    await gotoApp(page);
    await buildFolder(page, FOLDER, LAYOUT);
    await openFolder(page, FOLDER);
    await waitVideoReady(page, 'case_cfr.mp4');
    const s1 = await markSegment(page, 0, 7, 70);
    await waitSaved(page);
    // Edit and leave at once: SPEC §7.8 flushes the pending save on pagehide / visibilitychange.
    await jumpTo(page, 120);
    await page.keyboard.press('KeyQ');
    await jumpTo(page, 130);
    await page.keyboard.press('KeyW');
    await expect.poll(() => segments(page)).toHaveLength(2);
    const s2 = (await segments(page))[1];
    page.on('dialog', (d) => void d.accept());
    await page.reload();
    await page.waitForFunction(() => window.__pa?.state().ready === true);
    await reopenFolder(page, FOLDER);
    await waitVideoReady(page, 'case_cfr.mp4');
    expect(await segments(page), 'edit made just before the reload').toEqual([s1, s2]);

    await pickChip(page, 1);
    await jumpTo(page, 140);
    await page.keyboard.press('KeyQ');
    await jumpTo(page, 150);
    await page.keyboard.press('KeyW');
    await expect.poll(() => segments(page)).toHaveLength(3);
    const all = await segments(page);
    await page.close({ runBeforeUnload: false });
    const next = await newAppPage(context);
    await reopenFolder(next, FOLDER);
    await waitVideoReady(next, 'case_cfr.mp4');
    expect(await segments(next), 'edit made just before the tab was closed').toEqual(all);
  });

  test('renderer crash, then browser restart (no unload handlers at all) → draft restored', async () => {
    const dir = `${ARTIFACTS}profile-crash`;
    rmSync(dir, { recursive: true, force: true });
    let ctx = await launchProfile(dir);
    try {
      const page = await newAppPage(ctx);
      await crashAndRecover(ctx, page, async (p) => {
        const cdp = await ctx.newCDPSession(p);
        const crashed = p.waitForEvent('crash', { timeout: 10_000 });
        // The command never answers: the renderer is gone.
        void cdp.send('Page.crash').catch(() => undefined);
        await crashed;
        await ctx.close().catch(() => undefined);
        ctx = await launchProfile(dir);
        return newAppPage(ctx);
      });
    } finally {
      await ctx.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a renamed copy of the video finds its draft by hash', async ({ page }) => {
    await gotoApp(page);
    await buildFolder(page, 'orig', [{ path: 'case.mp4', fixture: 'cfr25_bframes.mp4' }]);
    await openFolder(page, 'orig');
    await waitVideoReady(page, 'case.mp4');
    const expected = [await markSegment(page, 0, 12, 34), await markSegment(page, 1, 34, 120)];
    await waitSaved(page);
    expect((await draftFor(page, CFR.sha256))?.segments).toEqual(expected);

    // Leave without exporting (Close folder → Leave anyway): the draft stays unexported.
    await page.getByRole('banner').getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Close folder' }).click();
    await page.locator('[data-testid="confirm-close-dialog"]').getByRole('button', { name: 'Leave anyway' }).click();
    await expect.poll(() => page.evaluate(() => window.__pa?.state().batch.mode)).toBe('none');

    // A different folder, a different name, the same bytes: no hash-cache entry, no sidecar.
    await buildFolder(page, 'copy', [{ path: 'nested/renamed_case_copy.mp4', fixture: 'cfr25_bframes.mp4' }]);
    await openFolder(page, 'copy');
    await waitVideoReady(page, 'nested/renamed_case_copy.mp4');
    expect(await page.evaluate(() => window.__pa?.state().video.hash.sha256)).toBe(CFR.sha256);
    expect(await segments(page), 'draft found for the renamed copy').toEqual(expected);
    const st = await page.evaluate(() => {
      const s = window.__pa!.state();
      return { identity: s.video.identity, sidecars: s.video.sidecars.length, dirty: s.editor.dirty, status: s.batch.items[0].status };
    });
    expect(st).toEqual({ identity: 'verified', sidecars: 0, dirty: true, status: 'draft' });
    const drafts = await readDrafts(page);
    expect(drafts.map((d) => d.key), 'one draft per video, keyed by SHA-256').toEqual([CFR.sha256]);
    await expect(page.locator('[data-testid="export-state"]')).toContainText('Unexported changes');
  });
});

// ============================================================================ hash window

/**
 * A ~2 GiB copy of a fixture (an MP4 `free` box appended) makes the full SHA-256 take seconds.
 * In-memory (incognito) OPFS cannot hold it, so these tests use a persistent profile on disk.
 */
test.describe('edits while the full SHA-256 is still running', () => {
  const PAD = 2048 * 1024 * 1024 - 64 * 1024; // keeps the box size below 2^32
  let SHA = '';

  test.beforeAll(() => {
    SHA = paddedSha256('cfr25_bframes.mp4', PAD);
  });

  async function launch(name: string): Promise<{ ctx: BrowserContext; dir: string }> {
    const dir = `${ARTIFACTS}profile-${name}`;
    rmSync(dir, { recursive: true, force: true });
    return { ctx: await launchProfile(dir), dir };
  }

  async function cleanup(ctx: BrowserContext, dir: string): Promise<void> {
    const p = ctx.pages()[0] ?? (await ctx.newPage().catch(() => null));
    if (p) {
      await p.goto('/').catch(() => undefined);
      await p
        .evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry('big', { recursive: true }).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    await ctx.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }

  test('first open: mark during hashing, kill before the hash finishes → edit survives', async () => {
    test.setTimeout(240_000);
    const { ctx, dir } = await launch('first');
    try {
      const page = await newAppPage(ctx);
      await buildFolder(page, 'big', [{ path: 'big_case.mp4', fixture: 'cfr25_bframes.mp4', padBytes: PAD }]);
      await openFolder(page, 'big');
      await waitVideoReady(page, 'big_case.mp4', { hash: 'any' });
      // The padded file still indexes: same frames, exact barcodes.
      const v = await page.evaluate(() => window.__pa!.state().video);
      expect(v.frameCount).toBe(CFR.frame_count);
      expect(v.hash.state, 'hash still running when marking starts').toBe('hashing');

      const seg = await markSegment(page, 0, 10, 20);
      await waitSaved(page);
      const hashing = await page.evaluate(() => window.__pa!.state().video.hash);
      expect(hashing.state, `hash must still be running at the kill (progress ${hashing.progress})`).toBe('hashing');
      const pending = (await readDrafts(page)).filter((d) => d.key.startsWith('pending:'));
      expect(pending.map((d) => d.segments), 'edit committed under the provisional key').toEqual([[seg]]);
      await page.evaluate(() => window.__pa?.actions.createCheckpoint('during hash'));
      expect((await readCheckpoints(page)).map((c) => [c.name, c.videoKey])).toEqual([['during hash', pending[0].key]]);
      await page.close({ runBeforeUnload: false });

      const page2 = await newAppPage(ctx);
      await reopenFolder(page2, 'big');
      await waitVideoReady(page2, 'big_case.mp4', { timeout: 90_000 });
      expect(await page2.evaluate(() => window.__pa!.state().video.hash.sha256)).toBe(SHA);
      expect(await segments(page2), 'edit made during hashing survives the kill').toEqual([seg]);
      const drafts = await readDrafts(page2);
      expect(drafts.map((d) => [d.key, d.segments])).toEqual([[SHA, [seg]]]);
      // The checkpoint made under the provisional key moved with the draft.
      expect((await readCheckpoints(page2)).map((c) => [c.name, c.videoKey, c.segments])).toEqual([['during hash', SHA, [seg]]]);
      expect(await page2.evaluate(() => window.__pa!.state().checkpoints.map((c) => c.name))).toEqual(['during hash']);
      await jumpTo(page2, CFR.frame_count - 1);
    } finally {
      await cleanup(ctx, dir);
    }
  });

  test('renamed file with an existing draft: mark during hashing, kill → edit survives', async () => {
    test.setTimeout(240_000);
    const { ctx, dir } = await launch('renamed');
    try {
      const page = await newAppPage(ctx);
      await buildFolder(page, 'big', [{ path: 'big_case.mp4', fixture: 'cfr25_bframes.mp4', padBytes: PAD }]);
      await openFolder(page, 'big');
      await waitVideoReady(page, 'big_case.mp4', { timeout: 90_000 });
      expect(await page.evaluate(() => window.__pa!.state().video.hash.sha256)).toBe(SHA);
      const first = await markSegment(page, 0, 10, 20);
      await waitSaved(page);
      expect((await draftFor(page, SHA))?.segments).toEqual([first]);

      // Rename in place: the hash cache (keyed by name) misses, so the full hash runs again.
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('big');
        const fh = (await dir.getFileHandle('big_case.mp4')) as FileSystemFileHandle & { move(name: string): Promise<void> };
        await fh.move('renamed_case.mp4');
      });
      page.on('dialog', (d) => void d.accept());
      await openFolder(page, 'big');
      await waitVideoReady(page, 'renamed_case.mp4', { hash: 'any' });
      expect(await segments(page), 'provisional draft shown by fingerprint').toEqual([first]);
      expect(await page.evaluate(() => window.__pa!.state().video.hash.state)).toBe('hashing');

      const second = await markSegment(page, 1, 30, 40);
      // Debounce 300 ms / max wait 1 s: give the autosave well over its window.
      await page.waitForTimeout(1500);
      const atKill = await page.evaluate(() => {
        const s = window.__pa!.state();
        return { hash: s.video.hash.state, progress: s.video.hash.progress, save: s.save.kind, identity: s.video.identity };
      });
      test.info().annotations.push({ type: 'state at kill', description: JSON.stringify(atKill) });
      expect(atKill.hash, `hash must still be running at the kill (${JSON.stringify(atKill)})`).toBe('hashing');
      const stored = await draftFor(page, SHA);
      test.info().annotations.push({ type: 'stored before kill', description: JSON.stringify(stored?.segments) });
      console.log('[renamed/hash window] at kill:', JSON.stringify(atKill), 'stored segments:', JSON.stringify(stored?.segments));
      await page.close({ runBeforeUnload: false });

      const page2 = await newAppPage(ctx);
      await reopenFolder(page2, 'big');
      await waitVideoReady(page2, 'renamed_case.mp4', { timeout: 90_000 });
      expect(await segments(page2), 'edit made during hashing survives the kill').toEqual([first, second]);
    } finally {
      await cleanup(ctx, dir);
    }
  });
});

// ============================================================================ checkpoints

test('named checkpoints: create, edit, restore — pre-restore checkpoint holds the edited state', async ({ page }) => {
  const errors = collectErrors(page);
  await gotoApp(page);
  await buildFolder(page, 'cp', [{ path: 'case.mp4', fixture: 'cfr25_bframes.mp4' }]);
  await openFolder(page, 'cp');
  await waitVideoReady(page, 'case.mp4');
  const s1 = await markSegment(page, 0, 10, 60);
  const s2 = await markSegment(page, 1, 60, 100);
  await waitSaved(page);

  await page.getByRole('tab', { name: /Checkpoints/ }).click();
  await page.getByRole('textbox', { name: 'Checkpoint name' }).fill('baseline v1');
  await page.getByRole('button', { name: 'Create checkpoint' }).click();
  const table = page.locator('[data-testid="checkpoints-table"]');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table).toContainText('baseline v1');

  // Edit: one more segment and a relabel through the controller-backed segment table.
  const s3 = await markSegment(page, 2, 150, 200);
  const edited = [s1, s2, s3];
  expect(await segments(page)).toEqual(edited);
  await waitSaved(page);

  await page.getByRole('tab', { name: /Checkpoints/ }).click();
  await table.locator('tbody tr', { hasText: 'baseline v1' }).getByRole('button', { name: 'Restore' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Restore checkpoint?');
  await dlg.getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => segments(page)).toEqual([s1, s2]);
  await expect(table.locator('tbody tr')).toHaveCount(2);

  const cps = await readCheckpoints(page);
  expect(cps.map((c) => [c.kind, c.name, c.videoKey])).toEqual([
    ['manual', 'baseline v1', CFR.sha256],
    ['auto-before-restore', 'Before restoring “baseline v1”', CFR.sha256],
  ]);
  expect(cps[0].segments).toEqual([s1, s2]);
  expect(cps[1].segments, 'automatic checkpoint holds the edited state').toEqual(edited);

  // The restore is a normal edit: autosaved, and undoable.
  await waitSaved(page);
  expect((await draftFor(page, CFR.sha256))?.segments).toEqual([s1, s2]);
  await page.keyboard.press('Control+KeyZ');
  await expect.poll(() => segments(page)).toEqual(edited);
  await page.keyboard.press('Control+Shift+KeyZ');
  await expect.poll(() => segments(page)).toEqual([s1, s2]);

  // Restoring the automatic checkpoint brings the edited state back (and checkpoints again).
  await table.locator('tbody tr', { hasText: 'Before restoring' }).getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => segments(page)).toEqual(edited);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await waitSaved(page);

  // Checkpoints persist across a reload.
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await page.waitForFunction(() => window.__pa?.state().ready === true);
  await reopenFolder(page, 'cp');
  await waitVideoReady(page, 'case.mp4');
  expect(await segments(page)).toEqual(edited);
  expect(await page.evaluate(() => window.__pa!.state().checkpoints.length)).toBe(3);
  expect(errors).toEqual([]);
});

// ============================================================================ stale tab

test('stale tab: B never silently overwrites A; Load newer / Keep mine checkpoint first', async ({ context }) => {
  const a = await newAppPage(context);
  await buildFolder(a, 'stale', [{ path: 'case.mp4', fixture: 'cfr25_bframes.mp4' }]);
  await openFolder(a, 'stale');
  await waitVideoReady(a, 'case.mp4');
  const b = await newAppPage(context);
  await reopenFolder(b, 'stale');
  await waitVideoReady(b, 'case.mp4');
  const banner = (p: Page) => p.getByText('This video was changed in another tab.');

  // A edits and saves revision 1.
  await a.bringToFront();
  const segA = await markSegment(a, 0, 10, 20);
  await waitSaved(a);
  const r1 = await draftFor(a, CFR.sha256);
  expect(r1?.segments).toEqual([segA]);
  expect(r1?.revision).toBe(1);

  // B (opened before A's save) edits: its save must conflict, not overwrite.
  await b.bringToFront();
  const segB = await markSegment(b, 1, 100, 120);
  await expect(banner(b)).toBeVisible();
  await b.evaluate(() => window.__pa?.flushAutosave());
  await b.waitForTimeout(1200);
  const stored = await draftFor(b, CFR.sha256);
  expect(stored?.revision, 'A’s revision is still the stored one').toBe(1);
  expect(stored?.segments, 'B did not overwrite A').toEqual([segA]);
  expect(await b.evaluate(() => window.__pa!.state().save.kind)).toBe('conflict');
  await expect(b.locator('[data-testid="save-state"]')).not.toContainText(/Saved/);

  // B: "Load newer version" → B shows A's segments; B's own state was checkpointed first.
  await b.getByRole('button', { name: 'Load newer version' }).click();
  await expect.poll(() => segments(b)).toEqual([segA]);
  await expect(banner(b)).toBeHidden();
  let cps = await readCheckpoints(b);
  expect(cps.map((c) => [c.kind, c.segments])).toEqual([['auto-before-conflict', [segB]]]);
  expect((await draftFor(b, CFR.sha256))?.revision).toBe(1);

  // B edits again on top of revision 1 → saves revision 2 → A is now stale.
  const segB2 = await markSegment(b, 2, 150, 160);
  await waitSaved(b);
  const r2 = await draftFor(b, CFR.sha256);
  expect(r2?.revision).toBe(2);
  expect(r2?.segments).toEqual([segA, segB2]);
  await expect(banner(a)).toBeVisible();

  // A: "Keep mine" → the newer stored version is checkpointed, then A's state overwrites it.
  await a.bringToFront();
  await a.getByRole('button', { name: 'Keep mine' }).click();
  await expect(banner(a)).toBeHidden();
  await waitSaved(a);
  const r3 = await draftFor(a, CFR.sha256);
  expect(r3?.revision).toBe(3);
  expect(r3?.segments).toEqual([segA]);
  cps = await readCheckpoints(a);
  expect(cps.map((c) => [c.kind, c.segments])).toEqual([
    ['auto-before-conflict', [segB]],
    ['auto-before-conflict', [segA, segB2]],
  ]);
  expect(cps[1].name).toContain('revision 2');
  // …and B is told in turn.
  await expect(banner(b)).toBeVisible();
});

test('stale tab: after leaving a conflicted video, autosave still works for the next video', async ({ context }) => {
  const a = await newAppPage(context);
  await buildFolder(a, 'stale2', [
    { path: 'a.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'b.mp4', fixture: 'vfr_mixed.mp4' },
  ]);
  await openFolder(a, 'stale2');
  await waitVideoReady(a, 'a.mp4');
  const b = await newAppPage(context);
  await reopenFolder(b, 'stale2');
  await waitVideoReady(b, 'a.mp4');

  await a.bringToFront();
  const segA = await markSegment(a, 0, 10, 20);
  await waitSaved(a);
  await b.bringToFront();
  await markSegment(b, 1, 100, 120);
  await expect.poll(() => b.evaluate(() => window.__pa!.state().save.kind)).toBe('conflict');
  expect((await draftFor(b, CFR.sha256))?.segments).toEqual([segA]);

  // B moves on without resolving the banner. While the conflict is active the switch gate must not
  // overwrite the export beside the video (spec: no writes while stale/conflicted), so the
  // switch-failed dialog appears and B switches without exporting.
  await b.getByRole('button', { name: 'Next video' }).click();
  const dlg = b.locator('[data-testid="switch-failed-dialog"]');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Switch without exporting' }).click();
  await waitVideoReady(b, 'b.mp4');
  const segOnB = await markSegment(b, 0, 30, 60);
  await b.evaluate(() => window.__pa?.flushAutosave());
  await b.waitForTimeout(1500);
  const saveKind = await b.evaluate(() => window.__pa!.state().save.kind);
  const stored = await draftFor(b, VFR.sha256);
  test.info().annotations.push({ type: 'observed', description: JSON.stringify({ saveKind, stored: stored?.segments ?? null }) });
  console.log('[stale/leave conflicted] observed:', saveKind, JSON.stringify(stored?.segments ?? null), await b.locator('[data-testid="save-state"]').innerText());
  expect(stored?.segments, 'the edit on the next video is autosaved').toEqual([segOnB]);
  expect(saveKind).toBe('saved');
  await expect(b.locator('[data-testid="save-state"]')).toContainText(/Saved/);
});

// ============================================================================ leave warning

test('unexported-changes warning on the LAST video; none once everything is exported', async ({ context }) => {
  const page = await newAppPage(context);
  await buildFolder(page, 'leave', [
    { path: 'a_first.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'b_last.mp4', fixture: 'vfr_mixed.mp4' },
  ]);
  await openFolder(page, 'leave');
  await waitVideoReady(page, 'a_first.mp4');
  await markSegment(page, 0, 3, 30);
  await page.getByRole('button', { name: 'Next video' }).click();
  await waitVideoReady(page, 'b_last.mp4');
  expect(await page.evaluate(() => window.__pa!.state().unexportedCount)).toBe(0);
  await expect(page.getByRole('button', { name: 'Next video' })).toBeDisabled();

  await markSegment(page, 0, 10, 50);
  await expect.poll(() => page.evaluate(() => window.__pa!.state().unexportedCount)).toBe(1);
  await waitSaved(page);

  // Native close warning on the last video.
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.dismiss(); // stay on the page
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);

  // Export the last video → no warning, the tab closes.
  await page.getByRole('tab', { name: /Export/ }).click();
  await page.getByRole('button', { name: 'Export now' }).click();
  await expect.poll(() => page.evaluate(() => window.__pa!.state().exportStatus.kind)).toBe('exported');
  expect(await page.evaluate(() => window.__pa!.state().unexportedCount)).toBe(0);
  await waitSaved(page);
  const closed = page.waitForEvent('close', { timeout: 10_000 });
  await page.close({ runBeforeUnload: true });
  await closed;
  expect(dialogs, 'no beforeunload dialog once everything is exported').toEqual(['beforeunload']);
});

// ============================================================================ offline

const LOCAL = /^(?:https?:\/\/127\.0\.0\.1(?::\d+)?\/|data:|blob:)/;

function recordRequests(context: BrowserContext): { all: string[]; failed: string[] } {
  const rec = { all: [] as string[], failed: [] as string[] };
  context.on('request', (r: Request) => rec.all.push(r.url()));
  context.on('requestfailed', (r: Request) => rec.failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  return rec;
}

/** Every @font-face source is same-origin and the UI font actually loaded from it. */
async function expectLocalFonts(page: Page, origin: string): Promise<void> {
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const srcs: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        srcs.push(`unreadable sheet ${sheet.href}`);
        continue;
      }
      for (const r of Array.from(rules)) if (r instanceof CSSFontFaceRule) srcs.push(r.style.getPropertyValue('src'));
    }
    const loaded = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.woff2?(\?|$)/.test(n));
    return { srcs, loaded, sans: document.fonts.check('13px "IBM Plex Sans"'), mono: document.fonts.check('13px "IBM Plex Mono"'), body: getComputedStyle(document.body).fontFamily };
  });
  expect(fonts.srcs.length, 'bundled @font-face rules').toBeGreaterThan(0);
  for (const s of fonts.srcs) {
    for (const m of s.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const u = new URL(m[1], origin);
      expect(u.origin, `font source ${m[1]}`).toBe(origin);
    }
  }
  expect(fonts.loaded.length, 'at least one font file was loaded').toBeGreaterThan(0);
  for (const u of fonts.loaded) expect(new URL(u).origin).toBe(origin);
  expect(fonts.sans && fonts.mono).toBe(true);
  expect(fonts.body).toContain('IBM Plex Sans');
}

/** Annotate, export, switch videos (and back) with the network off. */
async function offlineSession(page: Page, folder: string, goOffline: () => Promise<void>): Promise<void> {
  await openFolder(page, folder);
  await waitVideoReady(page, 'a.mp4');
  // "After initial load": the app and its workers are loaded; from here on the network is off.
  await goOffline();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await markSegment(page, 0, 3, 30);
  await markSegment(page, 1, 30, 80);
  await waitSaved(page);
  await page.getByRole('tab', { name: /Export/ }).click();
  await page.getByRole('button', { name: 'Export now' }).click();
  await expect.poll(() => page.evaluate(() => window.__pa!.state().exportStatus.kind)).toBe('exported');
  await page.getByRole('button', { name: 'Next video' }).click();
  await waitVideoReady(page, 'b.mp4');
  await jumpTo(page, 100);
  await markSegment(page, 0, 120, 200);
  await page.getByRole('button', { name: 'Previous video' }).click();
  await waitVideoReady(page, 'a.mp4');
  expect((await segments(page)).length).toBe(2);
  const csv = await page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(folder);
    return Promise.all(['a.phases.csv', 'b.phases.csv'].map(async (n) => (await (await dir.getFileHandle(n)).getFile()).size));
  }, folder);
  expect(csv.every((n) => n > 0)).toBe(true);
  await page.getByRole('radio', { name: '繁中' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', /zh/);
  await page.getByRole('radio', { name: 'EN' }).click();
}

test('offline: annotate, export and switch videos with the network off; nothing leaves 127.0.0.1', async ({ context }) => {
  const rec = recordRequests(context);
  const page = await newAppPage(context);
  const errors = collectErrors(page);
  await buildFolder(page, 'offline', [
    { path: 'a.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'b.mp4', fixture: 'vfr_mixed.mp4' },
  ]);
  await expectLocalFonts(page, 'http://127.0.0.1:5173');
  await offlineSession(page, 'offline', () => context.setOffline(true));
  await context.setOffline(false);
  const external = rec.all.filter((u) => !LOCAL.test(u));
  expect(external, 'requests that left 127.0.0.1').toEqual([]);
  expect(rec.failed, 'requests that failed while offline').toEqual([]);
  expect(errors).toEqual([]);
});

test('offline right after page load (before any video was opened): opening a video still works', async ({ context }) => {
  const rec = recordRequests(context);
  const page = await newAppPage(context);
  await buildFolder(page, 'offline-cold', [{ path: 'a.mp4', fixture: 'cfr25_bframes.mp4' }]);
  await context.setOffline(true);
  await openFolder(page, 'offline-cold');
  const v = await page.evaluate(() => {
    const s = window.__pa!.state();
    return { loadPhase: s.video.loadPhase, error: s.video.error?.key ?? null, params: s.video.error?.params ?? null };
  });
  await context.setOffline(false);
  test.info().annotations.push({ type: 'observed', description: JSON.stringify({ v, failed: rec.failed }) });
  console.log('[offline cold] observed:', JSON.stringify(v), JSON.stringify(rec.failed));
  expect(rec.all.filter((u) => !LOCAL.test(u))).toEqual([]);
  expect(v.loadPhase, `video opens with the network off (${JSON.stringify(v)}; failed: ${rec.failed.join(' | ')})`).toBe('ready');
});

// ============================================================================ production build

async function freePort(preferred: number): Promise<number> {
  const tryPort = (p: number): Promise<boolean> =>
    new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
  for (let p = preferred; p < preferred + 20; p++) if (await tryPort(p)) return p;
  throw new Error('no free port');
}

test.describe('production build', () => {
  let server: ChildProcess | null = null;
  let origin = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 240_000 });
    const port = await freePort(4173);
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['server/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('serve.mjs did not start')), 15_000);
      server?.stdout?.on('data', (d: Buffer) => {
        if (d.toString().includes('running at')) {
          clearTimeout(t);
          resolve();
        }
      });
      server?.once('exit', (code) => reject(new Error(`serve.mjs exited ${code}`)));
    });
  });

  test.afterAll(() => {
    server?.kill();
    server = null;
  });

  test('dist served by server/serve.mjs loads and works offline with zero external requests', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: origin });
    const rec = recordRequests(context);
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.goto(`${origin}/?e2e=1`);
    await page.waitForFunction(() => window.__pa?.state().ready === true);
    await expect(page.locator('.wb-top')).toBeVisible();
    await expectLocalFonts(page, origin);
    const inline = {
      'cfr25_bframes.mp4': readFileSync(`${FIXTURES}cfr25_bframes.mp4`).toString('base64'),
      'vfr_mixed.mp4': readFileSync(`${FIXTURES}vfr_mixed.mp4`).toString('base64'),
    };
    await buildFolder(
      page,
      'prod',
      [
        { path: 'a.mp4', fixture: 'cfr25_bframes.mp4' },
        { path: 'b.mp4', fixture: 'vfr_mixed.mp4' },
      ],
      inline,
    );
    await offlineSession(page, 'prod', () => context.setOffline(true));
    expect(await page.evaluate(() => window.__pa!.state().video.hash.sha256)).toBe(CFR.sha256);
    await context.setOffline(false);
    const external = rec.all.filter((u) => !u.startsWith(`${origin}/`) && !/^(data|blob):/.test(u));
    expect(external, 'requests that left the local server').toEqual([]);
    expect(rec.failed).toEqual([]);
    expect(errors).toEqual([]);
    expect(rec.all.some((u) => /\.woff2?$/.test(u))).toBe(true);
    await context.close();
  });
});
