/**
 * Interaction quality (REQUIREMENTS §2–3) with real mouse and keyboard input.
 *
 *  - Rapid scrubbing on the timeline ruler and key-repeat stepping, sampled every rendered frame:
 *    the frame counter text, player.displayedFrame and the barcode on the canvas must agree in
 *    every frame (samples are taken right before paint, see helpers/interaction.ts).
 *  - Control stability: bounding boxes of the frequently used controls across workspace states.
 *  - Shortcut suppression while typing, Space on a focused button, Esc, 1–5 / Shift+1–5, undo/redo.
 *  - Background work (foreground hashing of a ~600 MB padded video, background verification of
 *    another one) must not interrupt playback or marking; long tasks are measured.
 *
 * Screenshots of every state go to tests/artifacts/interaction/.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOpfsFolder,
  collectErrors,
  displayed,
  expectSettledAt,
  frameAtUs,
  frameInputSel,
  geometryDiff,
  longTasksSince,
  manifest,
  markState,
  measureControls,
  now,
  openApp,
  shot,
  SHOTS,
  startOpenFolder,
  startSampler,
  stopSampler,
  waitVideoReady,
  type FrameSample,
  type Geometry,
} from './helpers/interaction';

const LONG = 'long720p_gop300.mp4';
const CFR = 'cfr25_bframes.mp4';
const MiB = 1024 * 1024;

/** Samples in which the counter, the player and the canvas disagree. */
function disagreements(samples: FrameSample[], withBarcode: boolean): FrameSample[] {
  return samples.filter((s) => {
    if (s.displayed === null) return false;
    if (s.counter !== String(s.displayed)) return true;
    return withBarcode && s.barcode !== s.displayed;
  });
}

async function openSingle(page: Page, folder: string, fixture: string): Promise<void> {
  await openApp(page);
  await buildOpfsFolder(page, folder, [{ path: fixture, fixture }]);
  await startOpenFolder(page, folder);
  await waitVideoReady(page, fixture);
}

async function jumpTo(page: Page, frame: number): Promise<void> {
  const input = page.locator(frameInputSel()).first();
  await input.click();
  await page.keyboard.type(String(frame));
  await page.keyboard.press('Enter');
  await expectSettledAt(page, frame);
}

/** Lets async effects of a key press run (seeks, marks) before the state is compared. */
async function quiet(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  await page.evaluate(async () => {
    await window.__pa?.player()?.settled(3000);
  });
}

// ====================================================================== scrubbing & stepping

test('rapid ruler scrubbing: counter, displayedFrame and barcode agree in every frame; release lands under the pointer', async ({ page }) => {
  const errors = collectErrors(page);
  await openSingle(page, 'ix-scrub', LONG);
  const pts = manifest[LONG].pts_us;
  const box = await page.locator('.wb-timeline').boundingBox();
  if (!box) throw new Error('timeline not visible');
  const geo = await page.evaluate(() => ({
    width: Math.floor((document.querySelector('.wb-timeline') as HTMLElement).clientWidth),
    durationUs: window.__pa!.index()!.durationUs,
  }));
  const y = box.y + 12; // ruler band (0…28 px)

  // Three sweeps with small steps and no waits: forward, back, forward.
  const xs: number[] = [];
  for (let x = 40; x <= 900; x += 4) xs.push(x);
  for (let x = 900; x >= 300; x -= 3) xs.push(x);
  for (let x = 300; x <= 713.5; x += 2.5) xs.push(x);
  const finalX = xs[xs.length - 1];
  const expected = frameAtUs(pts, (Math.min(Math.max(0, finalX), box.width) / Math.max(1, geo.width)) * geo.durationUs);

  await startSampler(page, { barcodes: true });
  await page.mouse.move(box.x + xs[0], y);
  await page.mouse.down();
  const t0 = Date.now();
  for (const x of xs) await page.mouse.move(box.x + x, y);
  const moveMs = Date.now() - t0;
  // The hover preview follows the pointer while dragging.
  await expect(page.locator('.wb-preview')).toContainText(String(expected));
  await shot(page, '01-scrub-dragging');
  await page.mouse.up();
  await expectSettledAt(page, expected);
  const samples = await stopSampler(page);

  const bad = disagreements(samples, true);
  const shown = new Set(samples.map((s) => s.displayed));
  test.info().annotations.push({
    type: 'scrub',
    description: `${xs.length} moves in ${moveMs} ms; ${samples.length} frames sampled; ${shown.size} distinct frames shown; ${bad.length} disagreeing frames`,
  });
  expect(samples.length).toBeGreaterThan(20);
  expect(shown.size, 'scrubbing shows intermediate frames, not only the last one').toBeGreaterThan(5);
  expect(bad.slice(0, 10), `${bad.length} of ${samples.length} frames disagree (counter / displayed / barcode)`).toEqual([]);
  expect(await displayed(page)).toBe(expected);
  await shot(page, '02-scrub-released');

  // Burst: 150 moves sent without waiting for each other (faster than any real mouse), then
  // release. The latest position must win and every frame must still agree.
  const burst: number[] = [];
  for (let i = 0; i < 150; i++) burst.push(60 + ((i * 37) % 900));
  burst.push(222.5);
  const burstExpected = frameAtUs(pts, (222.5 / Math.max(1, geo.width)) * geo.durationUs);
  await startSampler(page, { barcodes: true });
  await page.mouse.move(box.x + 500, y);
  await page.mouse.down();
  await Promise.all(burst.map((x) => page.mouse.move(box.x + x, y)));
  await page.mouse.up();
  await expectSettledAt(page, burstExpected);
  const burstSamples = await stopSampler(page);
  const burstBad = disagreements(burstSamples, true);
  test.info().annotations.push({
    type: 'scrub-burst',
    description: `${burst.length} moves; ${burstSamples.length} frames sampled; ${burstBad.length} disagreeing`,
  });
  expect(burstBad.slice(0, 10), `${burstBad.length} of ${burstSamples.length} frames disagree after a burst`).toEqual([]);
  expect(errors).toEqual([]);
});

test('holding D (key repeat) steps monotonically and the counter tracks the image', async ({ page }) => {
  const errors = collectErrors(page);
  await openSingle(page, 'ix-holdd', LONG);
  const start = 280; // crosses the keyframe at 300
  await jumpTo(page, start);
  // Focus back on the page (the jump field releases focus on Enter).
  await startSampler(page, { barcodes: true });
  const repeats = 45;
  for (let i = 0; i < repeats; i++) {
    await page.keyboard.down('KeyD'); // later downs carry repeat=true
    await page.waitForTimeout(33); // ~30 Hz key repeat
  }
  await page.keyboard.up('KeyD');
  await expectSettledAt(page, start + repeats);
  const samples = await stopSampler(page);

  const seq = samples.map((s) => s.displayed).filter((d): d is number => d !== null);
  const backwards = seq.filter((d, i) => i > 0 && d < seq[i - 1]);
  const bad = disagreements(samples, true);
  const shown = new Set(seq);
  test.info().annotations.push({
    type: 'hold-D',
    description: `${samples.length} frames sampled, ${shown.size} distinct frames shown for ${repeats} repeats, ${bad.length} disagreeing`,
  });
  expect(backwards, 'displayed frame never goes backwards while D is held').toEqual([]);
  expect(bad.slice(0, 10), `${bad.length} of ${samples.length} frames disagree`).toEqual([]);
  expect(shown.size, 'the image follows the held key, not only the final frame').toBeGreaterThan(repeats / 3);
  await shot(page, '03-hold-d-done');
  expect(errors).toEqual([]);
});

// ====================================================================== control stability

const LONG_PATH =
  'zz_archive/2026/site-03/very/long/nested/folder/structure/for/review/z_case_with_a_really_long_file_name_for_layout_stability_0001.mp4';

test('controls keep their exact positions across workspace states', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openApp(page);
  // The first video is padded so its full hash takes a while: the "hashing" state can be observed.
  await buildOpfsFolder(page, 'ix-stable', [
    { path: LONG, fixture: LONG, padBytes: 256 * MiB },
    { path: LONG_PATH, fixture: CFR },
  ]);

  // Record geometry in-page every frame while the first video loads (transient states).
  await page.evaluate(() => {
    const rec: Record<string, Geometry> = {};
    (window as unknown as { __ixLoad: typeof rec }).__ixLoad = rec;
    const loop = (): void => {
      const s = window.__pa?.state();
      if (s && s.video.relPath !== null) {
        const key =
          s.video.loadPhase === 'ready'
            ? s.video.hash.state === 'hashing'
              ? 'loading-hashing'
              : null
            : `loading-${s.video.loadPhase}`;
        if (key && !rec[key]) rec[key] = window.__ixMeasure!();
        if (s.video.loadPhase === 'ready' && s.video.hash.state === 'done') return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await startOpenFolder(page, 'ix-stable');
  await waitVideoReady(page, LONG, { hashed: false });
  if ((await page.evaluate(() => window.__pa!.state().video.hash.state)) === 'hashing') {
    await shot(page, '10-state-loading-hashing');
  }
  await waitVideoReady(page, LONG);
  const loadGeo = await page.evaluate(() => (window as unknown as { __ixLoad: Record<string, Geometry> }).__ixLoad);

  const states: Record<string, Geometry> = {};
  for (const [k, g] of Object.entries(loadGeo)) states[k] = g;

  // Reference: ready, Export tab active (so the export button is measured too).
  await page.getByRole('tab', { name: /Export/ }).click();
  await page.mouse.move(700, 300); // pointer over the video, away from tooltips
  await page.waitForTimeout(250);
  const ref = await measureControls(page);
  await shot(page, '11-state-ready');

  // Playing.
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__pa!.player()!.getSnapshot().playing)).toBe(true);
  await page.waitForTimeout(400);
  states.playing = await measureControls(page);
  await shot(page, '12-state-playing');
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__pa!.player()!.getSnapshot().playing)).toBe(false);
  await quiet(page);

  // Seeking: a far seek into another GOP; measured while the "→ target" ghost is shown.
  const seekShot = page.evaluate(async () => {
    const p = window.__pa!.player()!;
    void p.seek(3500);
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const ghost = document.querySelector('.wb-ghost')?.textContent ?? '';
      if (p.getSnapshot().requestedFrame !== null && ghost.trim() !== '') return window.__ixMeasure!();
    }
    return null;
  });
  const seeking = await seekShot;
  if (seeking) states.seeking = seeking;
  else test.info().annotations.push({ type: 'seeking', description: 'seek finished before the pending state was rendered' });
  await expectSettledAt(page, 3500);

  // Pending start set (mouse on a chip, Q on the keyboard).
  await page.locator('[data-testid="recent-chips"] button').nth(0).click();
  await jumpTo(page, 1000);
  await page.keyboard.press('KeyQ');
  await expect(page.locator('[data-testid="pending-start"]')).toContainText('1000');
  await page.mouse.move(700, 300);
  await page.waitForTimeout(250);
  states.pendingStart = await measureControls(page);
  await shot(page, '13-state-pending-start');

  // A segment, then selected by clicking it in the timeline lane.
  await jumpTo(page, 1600);
  await page.keyboard.press('KeyW');
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.doc.segments.length)).toBe(1);
  const tl = (await page.locator('.wb-timeline').boundingBox())!;
  const tlWidth = await page.evaluate(() => Math.floor((document.querySelector('.wb-timeline') as HTMLElement).clientWidth));
  const dur = await page.evaluate(() => window.__pa!.index()!.durationUs);
  const midX = (manifest[LONG].pts_us[1300] / dur) * tlWidth;
  await page.mouse.click(tl.x + midX, tl.y + 32 + 14);
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.selectedSegmentId)).not.toBeNull();
  await expectSettledAt(page, 1000);
  await page.mouse.move(700, 300);
  await page.waitForTimeout(250);
  states.segmentSelected = await measureControls(page);
  await shot(page, '14-state-segment-selected');

  // Each bottom tab.
  for (const tab of ['Segments', 'Checkpoints', 'Export'] as const) {
    await page.getByRole('tab', { name: new RegExp(tab) }).click();
    await page.mouse.move(700, 300);
    await page.waitForTimeout(200);
    states[`tab-${tab}`] = await measureControls(page);
    await shot(page, `15-state-tab-${tab.toLowerCase()}`);
  }

  // Toast visible (checkpoint created through the Checkpoints tab), measured on the Export tab.
  await page.getByRole('tab', { name: /Checkpoints/ }).click();
  await page.getByRole('textbox', { name: 'Checkpoint name' }).or(page.locator('.wb-checkpoints input')).first().click();
  await page.keyboard.type('before review');
  await page.keyboard.press('Enter');
  const toast = page.locator('.ui-toast, [role="status"].ui-toast, [data-toast]').first();
  await expect(page.getByText(/before review/).last()).toBeVisible();
  await page.getByRole('tab', { name: /Export/ }).click();
  await page.mouse.move(700, 300);
  await page.waitForTimeout(200);
  states.toast = await measureControls(page);
  await shot(page, '16-state-toast');
  test.info().annotations.push({ type: 'toast', description: `toast element visible: ${await toast.isVisible().catch(() => false)}` });

  // Switch to the video with a very long path (export gate writes the CSV beside the source).
  await page.locator('[data-testid="batch-row"]').nth(1).click();
  await waitVideoReady(page, LONG_PATH);
  await page.mouse.move(700, 300);
  await page.waitForTimeout(250);
  states.longPath = await measureControls(page);
  await shot(page, '17-state-long-path');

  const report: Record<string, string[]> = {};
  for (const [name, g] of Object.entries(states)) {
    const keys = Object.keys(ref).filter((k) => k !== 'exportButton' || g.exportButton !== null);
    const diff = geometryDiff(ref, g, 0.5, keys);
    if (diff.length) report[name] = diff;
  }
  test.info().annotations.push({ type: 'states', description: Object.keys(states).join(', ') });
  writeFileSync(`${SHOTS}geometry.json`, JSON.stringify({ ref, states, report }, null, 1));
  expect(report, 'controls moved (state → control: delta)').toEqual({});
  expect(errors).toEqual([]);
});

// ====================================================================== keyboard behaviour

/** Opens cfr25, selects chip 1, pending start at 10, displayed 15. */
async function markingSetup(page: Page, folder: string): Promise<void> {
  await openSingle(page, folder, CFR);
  await page.locator('[data-testid="recent-chips"] button').nth(0).click();
  for (let i = 0; i < 10; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 10);
  await page.keyboard.press('KeyQ');
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.pendingStart)).toBe(10);
  for (let i = 0; i < 5; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 15);
}

test('typing in fields and selects never triggers shortcuts (q w e r a d z x, Space, Esc)', async ({ page }) => {
  const errors = collectErrors(page);
  await markingSetup(page, 'ix-typing');
  const base = await markState(page);
  expect(base).toMatchObject({ displayed: 15, pending: 10, playing: false, segments: [] });
  const TEXT = 'qwer adzx';
  const problems: string[] = [];
  const check = async (where: string): Promise<void> => {
    await quiet(page);
    const st = await markState(page);
    if (JSON.stringify(st) !== JSON.stringify(base)) problems.push(`${where}: ${JSON.stringify(st)}`);
  };

  // 1. Jump-to-frame field.
  await page.locator(frameInputSel()).first().click();
  await page.keyboard.type(TEXT);
  await page.keyboard.press('Space');
  await check('jump field');
  await shot(page, '20-typing-jump-field');
  await page.keyboard.press('Escape'); // reverts the field; must not cancel the pending start
  await check('jump field + Esc');

  // 2. Custom phase name field (popover).
  await page.getByRole('button', { name: 'Custom phase' }).click();
  const nameField = page.locator('input[data-custom-name]');
  await expect(nameField).toBeFocused();
  await page.keyboard.type(TEXT);
  await page.keyboard.press('Space');
  await check('custom phase name');
  await expect(nameField).toHaveValue(`${TEXT} `);
  await shot(page, '21-typing-custom-phase');
  await page.keyboard.press('Escape'); // closes the popover only
  await expect(nameField).toBeHidden();
  await check('custom phase name + Esc');

  // 3. Checkpoint name field.
  await page.getByRole('tab', { name: /Checkpoints/ }).click();
  const cpField = page.locator('.wb-checkpoints input').first();
  await cpField.click();
  await page.keyboard.type(TEXT);
  await page.keyboard.press('Space');
  await check('checkpoint name');
  await expect(cpField).toHaveValue(`${TEXT} `);
  await shot(page, '22-typing-checkpoint-name');
  await page.keyboard.press('Escape');
  await check('checkpoint name + Esc');

  // 4. A native select (playback rate), focused with the keyboard.
  const rate = page.getByRole('combobox', { name: 'Playback rate' });
  await rate.focus();
  await page.keyboard.type(TEXT);
  await check('rate select');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await check('rate select + Space/Esc');
  await expect(rate).toHaveValue('1');

  expect(problems).toEqual([]);

  // Shortcuts work again once focus leaves the fields.
  await page.mouse.click(700, 300);
  await page.keyboard.press('KeyD');
  await expectSettledAt(page, 16);
  expect(errors).toEqual([]);
});

test('Space with a focused button toggles play once and never activates the button', async ({ page }) => {
  const errors = collectErrors(page);
  await openSingle(page, 'ix-space', CFR);
  const playing = (): Promise<boolean> => page.evaluate(() => window.__pa!.player()!.getSnapshot().playing);
  const problems: string[] = [];

  // Keyboard focus on the "Start" (Q) marking button: Space plays, no start is set.
  await page.locator('[data-testid="recent-chips"] button').nth(0).click();
  const startBtn = page.locator('.wb-markgrid button').nth(0);
  await startBtn.focus();
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(true);
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(false);
  await quiet(page);
  const afterStart = await markState(page);
  if (afterStart.pending !== null) problems.push(`Start button activated by Space: pending=${afterStart.pending}`);

  // Mouse click on Play, then Space (focus stays on the Play button): exactly one toggle each.
  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(playing).toBe(true);
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  if (await playing()) problems.push('Space after clicking Play did not pause (toggled twice?)');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  if (!(await playing())) problems.push('second Space with Play/Pause focused did not resume');
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(false);

  // Keyboard focus on "Next frame": Space plays instead of stepping.
  await quiet(page);
  const before = await displayed(page);
  const nextBtn = page.locator('.wb-transport button').nth(3);
  await nextBtn.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  if (!(await playing())) problems.push(`Space with "Next frame" focused did not play (displayed ${before} → ${await displayed(page)})`);
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(false);

  // Keyboard focus on a phase chip: Space plays, the selection does not change.
  await page.locator('[data-testid="recent-chips"] button').nth(2).focus();
  const sel = (await markState(page)).selected;
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  if (!(await playing())) problems.push('Space with a chip focused did not play');
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(false);
  if ((await markState(page)).selected !== sel) problems.push('Space activated the focused chip');

  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
});

test('Esc cancels the pending start; undo restores it', async ({ page }) => {
  const errors = collectErrors(page);
  await markingSetup(page, 'ix-esc');
  await shot(page, '30-pending-start');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.pendingStart)).toBeNull();
  await expect(page.locator('[data-testid="pending-start"]')).not.toContainText('10');
  await shot(page, '31-pending-cancelled');
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.pendingStart)).toBe(10);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.pendingStart)).toBeNull();
  // Esc with nothing pending does nothing harmful.
  await page.keyboard.press('Escape');
  expect(await markState(page)).toMatchObject({ displayed: 15, pending: null, segments: [] });
  expect(errors).toEqual([]);
});

test('1–5 and Shift+1–5 select recent chips in place', async ({ page }) => {
  const errors = collectErrors(page);
  await openSingle(page, 'ix-digits', CFR);
  const visible = await page.evaluate(() => window.__pa!.state().visibleRecent);
  expect(visible.length).toBeGreaterThanOrEqual(6);
  const chips = page.locator('[data-testid="recent-chips"] button');
  const before = await measureControls(page);
  const keys: [string, number][] = [
    ['Digit1', 0],
    ['Digit2', 1],
    ['Digit3', 2],
    ['Digit4', 3],
    ['Digit5', 4],
    ['Shift+Digit1', 5],
    ['Shift+Digit2', 6],
    ['Shift+Digit3', 7],
    ['Shift+Digit4', 8],
    ['Shift+Digit5', 9],
  ];
  const wrong: string[] = [];
  for (const [key, slot] of keys) {
    const prev = await page.evaluate(() => window.__pa!.state().selectedPhaseId);
    await page.keyboard.press(key);
    await page.waitForTimeout(80);
    const sel = await page.evaluate(() => window.__pa!.state().selectedPhaseId);
    const want = slot < visible.length ? visible[slot] : prev; // no chip in that slot: unchanged
    if (sel !== want) wrong.push(`${key}: selected ${sel}, expected ${want}`);
    if (slot < visible.length && (await chips.nth(slot).getAttribute('aria-pressed')) !== 'true') {
      wrong.push(`${key}: chip ${slot + 1} not shown as selected`);
    }
  }
  await shot(page, '32-digit-selection');
  expect(wrong).toEqual([]);
  expect(await page.evaluate(() => window.__pa!.state().visibleRecent)).toEqual(visible);
  expect(geometryDiff(before, await measureControls(page))).toEqual([]);
  expect(errors).toEqual([]);
});

test('undo / redo with Ctrl/⌘+Z and Ctrl/⌘+Shift+Z over consecutive marks', async ({ page }) => {
  const errors = collectErrors(page);
  await openSingle(page, 'ix-undo', CFR);
  const visible = await page.evaluate(() => window.__pa!.state().visibleRecent);
  await page.keyboard.press('Digit1');
  await page.keyboard.press('KeyQ');
  await expect.poll(() => page.evaluate(() => window.__pa!.state().editor.pendingStart)).toBe(0);
  for (let i = 0; i < 10; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 10);
  await page.keyboard.press('KeyE');
  await page.keyboard.press('Digit2');
  for (let i = 0; i < 5; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 15);
  await page.keyboard.press('KeyW');
  const full = [
    [0, 10, visible[0]],
    [10, 15, visible[1]],
  ];
  await expect.poll(async () => (await markState(page)).segments).toEqual(full);
  expect((await markState(page)).pending).toBeNull();
  await expect(page.locator('[data-testid="segments-table"] tbody tr')).toHaveCount(2);
  await shot(page, '33-undo-before');

  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await markState(page)).segments).toEqual([full[0]]);
  expect((await markState(page)).pending).toBe(10);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await markState(page)).segments).toEqual([]);
  expect((await markState(page)).pending).toBe(0);
  await expect(page.locator('[data-testid="segments-table"] tbody tr')).toHaveCount(0);
  await shot(page, '34-undo-twice');

  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => (await markState(page)).segments).toEqual(full);
  expect((await markState(page)).pending).toBeNull();
  await expect(page.locator('[data-testid="segments-table"] tbody tr')).toHaveCount(2);
  // Undo/redo never moves the video.
  expect(await displayed(page)).toBe(15);
  expect(errors).toEqual([]);
});

test('recent chips are all visible directly (no clipped chip) at 1440×900', async ({ page }) => {
  await openSingle(page, 'ix-chipsvis', CFR);
  const res = await page.evaluate(() => {
    const list = document.querySelector('.wb-recent-list') as HTMLElement;
    const lr = list.getBoundingClientRect();
    return Array.from(list.querySelectorAll('[data-testid="recent-chips"] button')).map((b, i) => {
      const r = b.getBoundingClientRect();
      return { chip: i + 1, label: b.textContent, fullyVisible: r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5, top: r.top, bottom: r.bottom, listBottom: lr.bottom };
    });
  });
  await shot(page, '35-recent-chips');
  const hidden = res.filter((c) => !c.fullyVisible);
  expect(hidden, 'recent chips cut off by the scrolling chip list').toEqual([]);
});

test('only the selected chip carries the accent ring after mouse + keyboard use', async ({ page }) => {
  await openSingle(page, 'ix-focusring', CFR);
  const chips = page.locator('[data-testid="recent-chips"] button');
  await chips.nth(0).click(); // pick a phase with the mouse …
  await page.keyboard.press('KeyD'); // … then work with the shortcuts
  await page.keyboard.press('Digit2');
  await expectSettledAt(page, 1);
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(700, 300);
  await page.waitForTimeout(250);
  const rings = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--c-accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return Array.from(document.querySelectorAll('[data-testid="recent-chips"] button')).map((b, i) => {
      const cs = getComputedStyle(b);
      return {
        chip: i + 1,
        pressed: b.getAttribute('aria-pressed'),
        focused: document.activeElement === b,
        accentOutline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && cs.outlineColor === accent,
        accentBorder: cs.borderTopColor === accent,
      };
    });
  });
  await shot(page, '36-chip-rings');
  const ringed = rings.filter((r) => r.accentOutline || r.accentBorder);
  expect(ringed, 'chips drawn with an accent ring (only the selected one should be)').toEqual([
    expect.objectContaining({ chip: 2, pressed: 'true' }),
  ]);
});

// ====================================================================== playback & background work

/** Plays for `ms` with the real Space key and returns the frame samples taken meanwhile. */
async function playFor(page: Page, ms: number, barcodes: boolean, during?: () => Promise<void>): Promise<FrameSample[]> {
  await startSampler(page, { barcodes });
  await page.keyboard.press('Space');
  const t0 = Date.now();
  if (during) await during();
  const left = ms - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__pa!.player()!.getSnapshot().playing)).toBe(false);
  return stopSampler(page);
}

/** Presented frames per second over the playing part of the samples. */
function presentedFps(samples: FrameSample[]): { fps: number; changes: number; seconds: number; backwards: number } {
  const playing = samples.filter((s) => s.playing && s.displayed !== null);
  if (playing.length < 2) return { fps: 0, changes: 0, seconds: 0, backwards: 0 };
  let changes = 0;
  let backwards = 0;
  for (let i = 1; i < playing.length; i++) {
    if (playing[i].displayed !== playing[i - 1].displayed) changes++;
    if ((playing[i].displayed as number) < (playing[i - 1].displayed as number)) backwards++;
  }
  const seconds = (playing[playing.length - 1].t - playing[0].t) / 1000;
  return { fps: changes / seconds, changes, seconds, backwards };
}

test('playback at 1x: the frame counter shows the frame on the canvas in every rendered frame', async ({ page }) => {
  const errors = collectErrors(page);
  await openSingle(page, 'ix-play', LONG);
  const samples = await playFor(page, 2000, true);
  const bad = disagreements(samples, true);
  const lagging = bad.filter((s) => s.barcode === s.displayed && Number(s.counter) === (s.displayed as number) - 1).length;
  const r = presentedFps(samples);
  test.info().annotations.push({
    type: 'playback',
    description: `${samples.length} frames sampled, ${r.fps.toFixed(1)} fps presented, ${bad.length} disagreeing (${lagging} with the counter exactly one frame behind the image)`,
  });
  writeFileSync(`${SHOTS}playback-samples.json`, JSON.stringify(samples.slice(0, 80), null, 0));
  expect(r.fps).toBeGreaterThan(27);
  expect(bad.slice(0, 6), `${bad.length} of ${samples.length} rendered frames show a counter that differs from the image`).toEqual([]);
  expect(errors).toEqual([]);
});

test('hashing a ~2 GB video and background verification do not interrupt playback or marking', async ({ playwright }, testInfo) => {
  test.setTimeout(300_000);
  // Incognito contexts cap OPFS at about 1 GB; a persistent profile has the normal disk quota.
  const profile = mkdtempSync(join(tmpdir(), 'pa-ix-'));
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: !process.env.HEADED,
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 1440, height: 900 },
  });
  test.info().annotations.push({ type: 'profile', description: profile });
  try {
    await runBackgroundScenario(await context.newPage());
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

async function runBackgroundScenario(page: Page): Promise<void> {
  const errors = collectErrors(page);
  await openApp(page);
  const sizes = await buildOpfsFolder(page, 'ix-bg', [
    { path: 'a_big.mp4', fixture: LONG, padBytes: 2000 * MiB },
    { path: 'b_verify.mp4', fixture: LONG, padBytes: 1200 * MiB },
    // A sidecar beside b_verify makes it a background-verification candidate.
    {
      path: 'b_verify.phases.csv',
      text: '﻿format_version,video_sha256,frame_count,duration_us,phase_id,phase_name,start_frame,end_frame,start_us,end_us\r\n',
    },
  ]);
  test.info().annotations.push({ type: 'sizes', description: JSON.stringify(sizes) });

  // Record what is displayed (and drawn) at the moment each marking key reaches the page.
  await page.evaluate(() => {
    const rec: { code: string; displayed: number | null; barcode: number | null; playing: boolean; hash: string }[] = [];
    (window as unknown as { __ixKeys: typeof rec }).__ixKeys = rec;
    window.addEventListener(
      'keydown',
      (e) => {
        if (!['KeyQ', 'KeyW', 'KeyE'].includes(e.code)) return;
        const snap = window.__pa!.player()!.getSnapshot();
        rec.push({ code: e.code, displayed: snap.displayedFrame, barcode: window.__pa!.readBarcode(), playing: snap.playing, hash: window.__pa!.state().video.hash.state });
      },
      true,
    );
  });

  const tOpen = await now(page);
  await startOpenFolder(page, 'ix-bg');
  await waitVideoReady(page, 'a_big.mp4', { hashed: false });
  const tReady = await now(page);
  expect(await page.evaluate(() => window.__pa!.state().video.hash.state), 'still hashing when the video is ready').toBe('hashing');
  await page.locator('[data-testid="recent-chips"] button').nth(0).click();
  await shot(page, '40-bg-hashing-ready');

  // 1. Play at 1x for 2 s while the foreground hash runs; Q and W during playback.
  const playSamples = await playFor(page, 2000, false, async () => {
    await page.waitForTimeout(600);
    await page.keyboard.press('KeyQ');
    await page.waitForTimeout(800);
    await page.keyboard.press('KeyW');
  });
  const hashAfterPlay = await page.evaluate(() => window.__pa!.state().video.hash);
  await shot(page, '41-bg-after-play');
  const play1 = presentedFps(playSamples);
  const keys = await page.evaluate(() => (window as unknown as { __ixKeys: { code: string; displayed: number | null; barcode: number | null; playing: boolean; hash: string }[] }).__ixKeys);
  const segs1 = (await markState(page)).segments;

  // 2. Paused marking while hashing continues: step, Q, step, E, step, W.
  await page.keyboard.press('Digit2');
  for (let i = 0; i < 3; i++) await page.keyboard.press('KeyD');
  const f1 = (await displayed(page)) as number;
  await expectSettledAt(page, f1);
  await page.keyboard.press('KeyQ');
  for (let i = 0; i < 7; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, f1 + 7);
  await page.keyboard.press('KeyE');
  for (let i = 0; i < 4; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, f1 + 11);
  await page.keyboard.press('KeyW');
  await expect.poll(async () => (await markState(page)).segments.length).toBe(3);
  const hashAfterMarks = await page.evaluate(() => window.__pa!.state().video.hash.state);

  await page.waitForFunction(() => window.__pa!.state().video.hash.state === 'done', undefined, { timeout: 180_000 });
  const tHashed = await now(page);
  const hashLong = await longTasksSince(page, tOpen);
  const hashWindow = hashLong.filter((t) => t.start <= tHashed);

  // 3. Background verification of b_verify (hashed at background priority) while playing again.
  await page
    .waitForFunction(() => window.__pa!.state().batch.verifying !== null, undefined, { timeout: 30_000 })
    .catch(() => undefined);
  const verifyingSeen = await page.evaluate(() => window.__pa!.state().batch.verifying);
  const tVerify = await now(page);
  const geoVerifying = verifyingSeen ? await measureControls(page) : null;
  if (verifyingSeen) await shot(page, '42-bg-verifying');
  const playSamples2 = await playFor(page, 2000, false);
  const play2 = presentedFps(playSamples2);
  const stillVerifying = await page.evaluate(() => window.__pa!.state().batch.verifying);
  await page.waitForFunction(() => window.__pa!.state().batch.verifying === null, undefined, { timeout: 180_000 });
  const tVerified = await now(page);
  await page.evaluate(() => window.__pa?.whenIdle());
  const verifyLong = (await longTasksSince(page, tVerify)).filter((t) => t.start <= tVerified);
  await page.mouse.move(700, 300);
  await page.waitForTimeout(250);
  const geoVerified = await measureControls(page);
  await shot(page, '43-bg-verified');

  const max = (l: { duration: number }[]): number => Math.max(0, ...l.map((t) => t.duration));
  const summary = {
    readyAfterMs: Math.round(tReady - tOpen),
    hashMs: Math.round(tHashed - tOpen),
    hashProgressAfterPlay: hashAfterPlay,
    hashAfterMarks,
    play1,
    play2,
    verifyingSeen,
    stillVerifyingAfterPlay2: stillVerifying,
    verifyMs: Math.round(tVerified - tVerify),
    longTasksDuringHash: { count: hashWindow.length, maxMs: Math.round(max(hashWindow)), all: hashWindow.map((t) => Math.round(t.duration)) },
    longTasksDuringVerify: { count: verifyLong.length, maxMs: Math.round(max(verifyLong)), all: verifyLong.map((t) => Math.round(t.duration)) },
    keys,
    segs1,
    framesDropped: await page.evaluate(() => window.__pa!.player()!.getStats().framesDropped),
  };
  test.info().annotations.push({ type: 'background', description: JSON.stringify(summary) });
  writeFileSync(`${SHOTS}background.json`, JSON.stringify(summary, null, 1));

  // The scenario really ran while hashing.
  expect(hashAfterPlay.state, 'the hash was still running after 2 s of playback').toBe('hashing');
  // Playback near 30 fps, forward only.
  expect(play1.backwards).toBe(0);
  expect(play1.fps, 'presented fps while hashing').toBeGreaterThan(27);
  expect(play2.fps, 'presented fps during background verification').toBeGreaterThan(27);
  // Marks during playback use exactly the frame that was displayed (and drawn) at the key press.
  const q = keys.find((k) => k.code === 'KeyQ');
  const w = keys.find((k) => k.code === 'KeyW');
  expect(q?.playing && w?.playing, 'Q and W were pressed during playback').toBe(true);
  expect(q?.barcode).toBe(q?.displayed);
  expect(w?.barcode).toBe(w?.displayed);
  expect(segs1.map((s) => [s[0], s[1]])).toEqual([[q?.displayed, w?.displayed]]);
  // Paused marks: exact, adjacent boundaries.
  const all = (await markState(page)).segments.map((s) => [s[0], s[1]]);
  expect(all.slice(1)).toEqual([
    [f1, f1 + 7],
    [f1 + 7, f1 + 11],
  ]);
  // The batch list does not shift while background verification runs.
  if (geoVerifying) {
    expect
      .soft(geometryDiff(geoVerified, geoVerifying, 0.5, ['batchList', 'firstBatchRow', 'prev', 'next', 'play', 'timeline']), 'controls moved during background verification')
      .toEqual([]);
  }
  // The long-task probe works: a deliberate 120 ms busy loop is observed.
  const tProbe = await now(page);
  // (Run it from a page task: work done inside a DevTools evaluate is not reported as a long task.)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const t = performance.now();
          while (performance.now() - t < 120);
          resolve();
        }, 0),
      ),
  );
  await expect.poll(async () => Math.max(0, ...(await longTasksSince(page, tProbe - 1)).map((t) => t.duration))).toBeGreaterThan(100);
  // Main thread stays responsive (no long task above 100 ms).
  expect(summary.longTasksDuringHash.maxMs, 'longest main-thread task while hashing (ms)').toBeLessThan(100);
  expect(summary.longTasksDuringVerify.maxMs, 'longest main-thread task during background verification (ms)').toBeLessThan(100);
  expect(errors).toEqual([]);
}
