/**
 * Frame accuracy through the real workbench UI (REQUIREMENTS §4 and §6).
 *
 * For each synthetic fixture (CFR with B-frames, NTSC 30000/1001, VFR, open GOP, a 3-frame clip) the
 * video is opened from an OPFS folder through the test hook; everything else goes through the UI:
 * Z/X, the jump-to-frame field, Q/E/R and digit keys, the Export tab (format radio + "Export now"),
 * and "Import file…". Frame identity is always checked three ways: the counter, the player's
 * displayedFrame and the barcode actually drawn on the canvas; the timecode must be the manifest pts.
 *
 * Exports are parsed with an independent CSV/JSON reader and compared with the ffprobe manifest
 * (pts_us, sha256, frame_count) and the container duration for boundary N. Round trip: a fresh
 * browser context (empty IndexedDB and OPFS) opens the same folder with the sidecars → annotations
 * load automatically and every segment's first and last frame is shown via the UI and read back
 * from the barcode. Manual import goes through the "Import file…" button with showOpenFilePicker
 * stubbed to return an OPFS file handle.
 *
 * The last block marks while a seek is still in flight (jump/X/Z/D immediately followed by a
 * marking key) and requires the committed boundary to be the settled frame.
 */
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
  boundaryUs,
  buildFolder,
  clickTab,
  collectErrors,
  DURATION_US,
  expectExportMatches,
  expectSettledAt,
  frameInput,
  gotoApp,
  jumpTo,
  listOpfs,
  manifest,
  openOpfsFolder,
  parseCsvExport,
  parseJsonExport,
  readOpfsText,
  segmentRows,
  stateSegments,
  stubOpenFilePicker,
  waitVideoReady,
  type SimpleSeg,
} from './helpers/accuracy';

interface Case {
  name: string;
  /** [start, b1, b2]: Q at start, E at b1, E at b2, then R → segments [start,b1) [b1,b2) [b2,N). */
  marks: [number, number, number];
}

const CASES: Case[] = [
  { name: 'cfr25_bframes.mp4', marks: [0, 100, 249] },
  { name: 'ntsc2997.mp4', marks: [1, 150, 250] },
  { name: 'vfr_mixed.mp4', marks: [0, 119, 239] },
  { name: 'open_gop30.mp4', marks: [28, 60, 250] },
  { name: 'tiny3.mp4', marks: [0, 1, 2] },
];

const ROOT = 'acc';

const stem = (name: string): string => name.replace(/\.mp4$/, '');

async function newAppPage(browser: Browser, info: TestInfo): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> {
  const use = info.project.use;
  const ctx = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport ?? { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await gotoApp(page);
  return { page, errors, close: () => ctx.close() };
}

async function selectedPhase(page: Page): Promise<string> {
  const id = await page.evaluate(() => window.__pa?.state().selectedPhaseId ?? null);
  expect(id).not.toBeNull();
  return id as string;
}

async function exportVia(page: Page, format: 'CSV' | 'JSON' | 'Both', ext: 'csv' | 'json'): Promise<void> {
  await clickTab(page, 'Export');
  const group = page.getByRole('radiogroup', { name: 'Format' });
  await group.getByRole('radio', { name: format, exact: true }).click();
  await expect(group.getByRole('radio', { name: format, exact: true })).toHaveAttribute('aria-checked', 'true');
  const before = await page.evaluate(() => {
    const s = window.__pa?.state().exportStatus;
    return s?.kind === 'exported' ? s.at : 0;
  });
  await page.getByRole('button', { name: 'Export now' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        ({ before, ext }) => {
          const s = window.__pa?.state().exportStatus;
          if (s?.kind === 'error') return `error: ${JSON.stringify(s.msg)}`;
          return s?.kind === 'exported' && s.at >= before && s.targets.some((t) => t.endsWith(`.${ext}`)) ? 'ok' : s?.kind;
        },
        { before, ext },
      ),
    )
    .toBe('ok');
}

for (const c of CASES) {
  const e = manifest[c.name];
  const N = e.frame_count;
  const [m0, m1, m2] = c.marks;

  test(`${stem(c.name)}: frames, adjacent segments, CSV/JSON export, round trip`, async ({ page, browser }, info) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await buildFolder(page, ROOT, [{ path: c.name, fixture: c.name }]);
    await openOpfsFolder(page, ROOT);
    await waitVideoReady(page, c.name);
    const video = await page.evaluate(() => window.__pa?.state().video);
    expect(video?.frameCount).toBe(N);
    expect(video?.hash.sha256).toBe(e.sha256);
    expect(video?.durationUs).toBe(DURATION_US[c.name]);

    // --------------------------------------------------------------- first / middle / last frame
    await test.step('first, middle and last frame via Z/X and the jump field', async () => {
      await expectSettledAt(page, c.name, 0);
      await page.keyboard.press('KeyX');
      await expectSettledAt(page, c.name, N - 1);
      await page.keyboard.press('KeyZ');
      await expectSettledAt(page, c.name, 0);
      const mid = Math.floor(N / 2);
      // Never jump to the frame already shown here: see the dedicated "same frame" test below.
      const targets = [mid, N - 1, 0, mid, 1, N - 2].filter((f, i, a) => f >= 0 && f < N && (i === 0 ? f !== N - 1 : f !== a[i - 1]));
      for (const f of targets) {
        await jumpTo(page, f);
        await expectSettledAt(page, c.name, f);
      }
      // After a field commit, the shortcuts act on the video again.
      await page.keyboard.press('KeyX');
      await expectSettledAt(page, c.name, N - 1);
    });

    // --------------------------------------------------------------- adjacent segments with E, then R
    const expected: SimpleSeg[] = [];
    await test.step('Q / E / E / R build adjacent segments', async () => {
      const chips = page.locator('[data-testid="recent-chips"] button');
      expect(await chips.count()).toBeGreaterThanOrEqual(3);
      await chips.nth(0).click();
      const p1 = await selectedPhase(page);

      await jumpTo(page, m0);
      await expectSettledAt(page, c.name, m0);
      await page.keyboard.press('KeyQ');
      await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(m0);
      await expect(page.locator('[data-testid="pending-start"]')).toContainText(String(m0));

      await jumpTo(page, m1);
      await expectSettledAt(page, c.name, m1);
      await page.keyboard.press('KeyE');
      await expect.poll(() => stateSegments(page)).toEqual([{ phaseId: p1, start: m0, end: m1 }]);
      expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(m1);
      expected.push({ phaseId: p1, start: m0, end: m1 });

      await page.keyboard.press('Digit2');
      const p2 = await selectedPhase(page);
      expect(p2).not.toBe(p1);
      await jumpTo(page, m2);
      await expectSettledAt(page, c.name, m2);
      await page.keyboard.press('KeyE');
      expected.push({ phaseId: p2, start: m1, end: m2 });
      await expect.poll(() => stateSegments(page)).toEqual(expected);
      expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(m2);

      await page.keyboard.press('Digit3');
      const p3 = await selectedPhase(page);
      expect(p3).not.toBe(p2);
      await page.keyboard.press('KeyR');
      expected.push({ phaseId: p3, start: m2, end: N });
      await expect.poll(() => stateSegments(page)).toEqual(expected);
      expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBeNull();
      expect(await page.evaluate(() => window.__pa?.state().editor.issues)).toEqual([]);

      await clickTab(page, 'Segments');
      expect(await segmentRows(page)).toEqual(
        expected.map((s) => ({ start: String(s.start), end: String(s.end), last: String(s.end - 1) })),
      );
      // Adjacent: each end is the next start; the last segment ends at N.
      expect(expected[0].end).toBe(expected[1].start);
      expect(expected[1].end).toBe(expected[2].start);
      expect(expected[2].end).toBe(N);
    });

    const phaseNames = await page.evaluate(
      (ids) => Object.fromEntries(ids.map((id) => [id, window.__pa?.state().library.phases[id]?.name ?? '?'])),
      expected.map((s) => s.phaseId),
    );

    // --------------------------------------------------------------- export CSV, then JSON
    let csvText = '';
    let jsonText = '';
    await test.step('export CSV and JSON beside the video and parse the written files', async () => {
      await exportVia(page, 'CSV', 'csv');
      csvText = (await readOpfsText(page, `${ROOT}/${stem(c.name)}.phases.csv`)) ?? '';
      expect(csvText, 'CSV written beside the video').not.toBe('');
      expectExportMatches(parseCsvExport(csvText), c.name, expected, phaseNames);

      await exportVia(page, 'JSON', 'json');
      expect(await page.evaluate(() => window.__pa?.state().settings.exportFormat)).toBe('json');
      jsonText = (await readOpfsText(page, `${ROOT}/${stem(c.name)}.phases.json`)) ?? '';
      expect(jsonText, 'JSON written beside the video').not.toBe('');
      const parsedJson = parseJsonExport(jsonText);
      expectExportMatches(parsedJson, c.name, expected, phaseNames);
      expect(JSON.parse(jsonText).video.file_name).toBe(c.name);
      expect(await listOpfs(page, ROOT)).toEqual([c.name, `${stem(c.name)}.phases.csv`, `${stem(c.name)}.phases.json`].sort());
      expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
    });
    expect(errors, 'no console errors in the annotating session').toEqual([]);

    // --------------------------------------------------------------- round trip: fresh context + sidecars
    await test.step('fresh browser context: sidecars auto-load, boundaries show the exact frames', async () => {
      const fresh = await newAppPage(browser, info);
      try {
        const p = fresh.page;
        expect(await p.evaluate(() => indexedDB.databases().then((d) => d.length))).toBeLessThanOrEqual(1);
        await buildFolder(p, ROOT, [
          { path: c.name, fixture: c.name },
          { path: `${stem(c.name)}.phases.csv`, text: csvText },
          { path: `${stem(c.name)}.phases.json`, text: jsonText },
        ]);
        await openOpfsFolder(p, ROOT);
        await waitVideoReady(p, c.name);
        await expect.poll(() => stateSegments(p)).toEqual(expected);
        expect(
          await p.evaluate(() => window.__pa?.state().video.sidecars.map((s) => [s.name, s.state]).sort()),
        ).toEqual([
          [`${stem(c.name)}.phases.csv`, 'match'],
          [`${stem(c.name)}.phases.json`, 'match'],
        ]);
        expect(await p.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
        expect(await p.evaluate(() => window.__pa?.state().batch.items[0]?.status)).toBe('annotated');
        await clickTab(p, 'Segments');
        expect(await segmentRows(p)).toEqual(
          expected.map((s) => ({ start: String(s.start), end: String(s.end), last: String(s.end - 1) })),
        );
        for (const s of expected) {
          await jumpTo(p, s.start);
          await expectSettledAt(p, c.name, s.start);
          await jumpTo(p, s.end - 1);
          await expectSettledAt(p, c.name, s.end - 1);
          // Recover the exact boundary times from the video for the exported record.
          expect(boundaryUs(c.name, s.start)).toBe(await p.evaluate((f) => window.__pa?.index()?.ptsUs[f], s.start));
        }
        // Clicking a row seeks to that segment's start.
        await p.locator('[data-testid="segments-table"] tbody tr').nth(expected.length - 1).locator('td').nth(3).click();
        await expectSettledAt(p, c.name, expected[expected.length - 1].start);
        expect(fresh.errors).toEqual([]);
      } finally {
        await fresh.close();
      }
    });

    // --------------------------------------------------------------- manual import (JSON, then CSV)
    for (const [fmt, text] of [
      ['json', jsonText],
      ['csv', csvText],
    ] as const) {
      await test.step(`fresh browser context: manual "Import file…" of the ${fmt.toUpperCase()}`, async () => {
        const fresh = await newAppPage(browser, info);
        try {
          const p = fresh.page;
          await buildFolder(p, ROOT, [{ path: c.name, fixture: c.name }]);
          // Outside the batch folder, so it is not discovered as a sidecar.
          await buildFolder(p, 'imports', [{ path: `exported.${fmt}`, text }]);
          await openOpfsFolder(p, ROOT);
          await waitVideoReady(p, c.name);
          expect(await stateSegments(p)).toEqual([]);
          expect(await p.evaluate(() => window.__pa?.state().video.sidecars.length)).toBe(0);
          await stubOpenFilePicker(p, `imports/exported.${fmt}`);
          await clickTab(p, 'Export');
          await p.getByRole('button', { name: 'Import file…' }).click();
          await expect.poll(() => stateSegments(p)).toEqual(expected);
          expect(await p.evaluate(() => (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls.length)).toBe(1);
          for (const s of expected) {
            await jumpTo(p, s.start);
            await expectSettledAt(p, c.name, s.start);
            await jumpTo(p, s.end - 1);
            await expectSettledAt(p, c.name, s.end - 1);
          }
          expect(fresh.errors).toEqual([]);
        } finally {
          await fresh.close();
        }
      });
    }
  });
}

// ------------------------------------------------------------------------------- marking mid-seek

interface InFlightCase {
  name: string;
  /** Frame to park on before Z+Q. */
  park: number;
  /** jump target, then +3 with D D D, then W. */
  jumpA: number;
  /** jump target followed immediately by E. */
  jumpB: number;
}

const IN_FLIGHT: InFlightCase[] = [
  { name: 'long720p_gop300.mp4', park: 1500, jumpA: 1199, jumpB: 2099 },
  { name: 'open_gop30.mp4', park: 150, jumpA: 119, jumpB: 239 },
  { name: 'vfr_mixed.mp4', park: 120, jumpA: 99, jumpB: 199 },
];

/** Logs the player snapshot at every marking keydown (capture phase, before the app handles it). */
async function installKeyLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keyLog: { code: string; requested: number | null; displayed: number | null }[] };
    w.__keyLog = [];
    window.addEventListener(
      'keydown',
      (e) => {
        if (!['KeyQ', 'KeyW', 'KeyE', 'KeyR'].includes(e.code)) return;
        const s = window.__pa?.player()?.getSnapshot();
        w.__keyLog.push({ code: e.code, requested: s?.requestedFrame ?? null, displayed: s?.displayedFrame ?? null });
      },
      true,
    );
  });
}

async function keyLog(page: Page): Promise<{ code: string; requested: number | null; displayed: number | null }[]> {
  return page.evaluate(() => (window as unknown as { __keyLog: { code: string; requested: number | null; displayed: number | null }[] }).__keyLog);
}

async function feedbackKind(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const f = window.__pa?.state().markFeedback;
    return f ? `${f.kind}:${f.msg.key}` : null;
  });
}

for (const c of IN_FLIGHT) {
  const N = manifest[c.name].frame_count;
  test(`${stem(c.name)}: marking while a seek is in flight commits the settled frame`, async ({ page }) => {
    const errors = collectErrors(page);
    await gotoApp(page);
    await buildFolder(page, ROOT, [{ path: c.name, fixture: c.name }]);
    await openOpfsFolder(page, ROOT);
    await waitVideoReady(page, c.name);
    await page.locator('[data-testid="recent-chips"] button').nth(0).click();
    const phase = await selectedPhase(page);
    await installKeyLog(page);

    // 1) Z then Q immediately → pending start 0, not the parked frame.
    await jumpTo(page, c.park);
    await expectSettledAt(page, c.name, c.park);
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('KeyQ');
    await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.pendingStart), { message: 'Z+Q pending start' }).toBe(0);
    await expectSettledAt(page, c.name, 0);

    // 2) jump field + D D D + W while decoding → [0, jumpA+3).
    await frameInput(page).click();
    await page.keyboard.type(String(c.jumpA));
    await page.keyboard.press('Enter');
    await page.keyboard.press('KeyD');
    await page.keyboard.press('KeyD');
    await page.keyboard.press('KeyD');
    await page.keyboard.press('KeyW');
    const a = c.jumpA + 3;
    await expect.poll(() => stateSegments(page), { message: 'jump+DDD+W' }).toEqual([{ phaseId: phase, start: 0, end: a }]);
    await expectSettledAt(page, c.name, a);

    // 3) Q (settled), then jump + E immediately → [a, jumpB), pending jumpB.
    await page.keyboard.press('KeyQ');
    await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(a);
    await frameInput(page).click();
    await page.keyboard.type(String(c.jumpB));
    await page.keyboard.press('Enter');
    await page.keyboard.press('KeyE');
    await expect
      .poll(() => stateSegments(page), { message: 'jump+E' })
      .toEqual([
        { phaseId: phase, start: 0, end: a },
        { phaseId: phase, start: a, end: c.jumpB },
      ]);
    expect(await page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(c.jumpB);
    await expectSettledAt(page, c.name, c.jumpB);

    // 4) X then W immediately → [jumpB, N-1).
    await page.keyboard.press('KeyX');
    await page.keyboard.press('KeyW');
    await expect
      .poll(() => stateSegments(page), { message: 'X+W' })
      .toEqual([
        { phaseId: phase, start: 0, end: a },
        { phaseId: phase, start: a, end: c.jumpB },
        { phaseId: phase, start: c.jumpB, end: N - 1 },
      ]);
    await expectSettledAt(page, c.name, N - 1);
    expect(await feedbackKind(page)).toMatch(/^ok:/);

    const log = await keyLog(page);
    // Record whether each marking key really arrived mid-seek (requested frame not yet displayed).
    const inFlight = log.map((l) => `${l.code}:${l.requested !== null && l.requested !== l.displayed ? 'in-flight' : 'settled'}`);
    test.info().annotations.push({ type: 'key-log', description: JSON.stringify(log) });
    // The W after the jump + steps and the E after the jump must have been pressed mid-seek on the
    // long GOP video; otherwise this test proves nothing there.
    if (c.name === 'long720p_gop300.mp4') {
      expect(inFlight[1], 'W pressed while the jump/step seek was in flight').toBe('KeyW:in-flight');
      expect(inFlight[3], 'E pressed while the jump seek was in flight').toBe('KeyE:in-flight');
    }
    expect(errors).toEqual([]);
  });
}

// ------------------------------- navigation pressed right after a marking key, before the seek settles

/**
 * The user jumps to a frame, presses a marking key while the seek is still decoding (the counter shows
 * "→ target"), then immediately keeps navigating. The boundary must be the frame that was being
 * sought when the key was pressed (or the mark refused with an explanation) — never a frame the
 * user navigated to afterwards.
 */
test('long720p_gop300: navigation right after W/Q does not move the boundary being confirmed', async ({ page }) => {
  const name = 'long720p_gop300.mp4';
  const N = manifest[name].frame_count;
  const errors = collectErrors(page);
  await gotoApp(page);
  await buildFolder(page, ROOT, [{ path: name, fixture: name }]);
  await openOpfsFolder(page, ROOT);
  await waitVideoReady(page, name);
  await page.locator('[data-testid="recent-chips"] button').nth(0).click();
  const phase = await selectedPhase(page);
  await installKeyLog(page);

  await jumpTo(page, 10);
  await expectSettledAt(page, name, 10);
  await page.keyboard.press('KeyQ');
  await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.pendingStart)).toBe(10);

  // W while seeking to 2099, then one more step forward.
  await frameInput(page).click();
  await page.keyboard.type('2099');
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyW');
  await page.keyboard.press('KeyD');
  await expectSettledAt(page, name, 2100);
  await expect.poll(() => page.evaluate(() => window.__pa?.state().markFeedback?.kind)).not.toBe('waiting');
  const log = await keyLog(page);
  expect(log[1], 'W was pressed mid-seek').toEqual({ code: 'KeyW', requested: 2099, displayed: 10 });
  const segs = await stateSegments(page);
  if (segs.length > 0) expect.soft(segs, 'boundary = frame sought when W was pressed').toEqual([{ phaseId: phase, start: 10, end: 2099 }]);
  else expect.soft(await page.evaluate(() => window.__pa?.state().markFeedback?.kind)).toBe('error');

  // Q while seeking to 2999, then X (last frame) right away.
  await page.keyboard.press('Escape');
  await frameInput(page).click();
  await page.keyboard.type('2999');
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyX');
  await expectSettledAt(page, name, N - 1);
  await expect.poll(() => page.evaluate(() => window.__pa?.state().markFeedback?.kind)).not.toBe('waiting');
  expect((await keyLog(page))[2], 'Q was pressed mid-seek').toMatchObject({ code: 'KeyQ', requested: 2999 });
  const pending = await page.evaluate(() => window.__pa?.state().editor.pendingStart);
  expect.soft([2999, null], `pending start after Q mid-seek to 2999 then X (got ${pending})`).toContain(pending);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------- jump field focus

for (const how of ['retype the shown number', 'Enter without typing'] as const) {
  test(`jump field: ${how} + Enter hands the keyboard back to the shortcuts`, async ({ page }) => {
    const name = 'cfr25_bframes.mp4';
    await gotoApp(page);
    await buildFolder(page, ROOT, [{ path: name, fixture: name }]);
    await openOpfsFolder(page, ROOT);
    await waitVideoReady(page, name);
    await jumpTo(page, 4);
    await expectSettledAt(page, name, 4);
    const input = frameInput(page);
    await input.click(); // focus selects the text, as for any jump
    if (how === 'retype the shown number') await page.keyboard.type('4');
    await page.keyboard.press('Enter');
    await page.keyboard.press('KeyD');
    await expect(input, 'D must step the video, not be typed into the field').toHaveValue('5');
    await expectSettledAt(page, name, 5);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  });
}
