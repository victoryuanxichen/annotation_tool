/**
 * Batch annotation and sidecars (REQUIREMENTS §5, SPEC §7.6–7.7) end to end in installed Chrome.
 *
 * Every test builds its own folder in OPFS (fresh browser context = fresh OPFS and IndexedDB) from
 * the synthetic fixtures, opens it through window.__pa.openDirectoryHandle (the "Open folder"
 * path with a real FileSystemDirectoryHandle) and then drives the UI with the mouse where the
 * product exposes a control: batch rows, sort select/direction, Prev/Next, Export tab radios,
 * dialog buttons, segment delete buttons. Sidecar files are written by the helpers straight from
 * SPEC §2.1 so the app's own serializer is not used to produce its test input.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HEADER,
  addSegments,
  boundaryUs,
  buildCsv,
  buildFolder,
  buildJson,
  denyWritePermission,
  gotoApp,
  idle,
  itemOf,
  items,
  jsonDoc,
  listOpfs,
  manifest,
  metaOf,
  openFolder,
  permLog,
  readDraft,
  readOpfsText,
  segsOf,
  sidecarsOf,
  startStatusRecorder,
  statusLog,
  stubDirectoryPicker,
  twoPhases,
  waitVideoReady,
  writeOpfsText,
  type Seg,
} from './helpers/batch';
import { paddedSha256, writePaddedFixture } from './helpers/batchPad';

const SHOTS = fileURLToPath(new URL('../artifacts/batch/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const rows = (page: Page) => page.locator('[data-testid="batch-row"]');
const nextBtn = (page: Page) => page.getByRole('button', { name: 'Next video' });
const prevBtn = (page: Page) => page.getByRole('button', { name: 'Previous video' });

/** Relative path per row: the full path (tooltip) and the visible text must both be the path. */
async function rowPaths(page: Page): Promise<string[]> {
  const titles = await rows(page).locator('.wb-batch-path .ui-mid').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  const shown = await rows(page).locator('.wb-batch-path .ui-mid > span:nth-child(2)').allInnerTexts();
  expect(shown, 'visible paths are not truncated at this width').toEqual(titles);
  return titles;
}

async function openTab(page: Page, name: 'Segments' | 'Checkpoints' | 'Export'): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}

async function currentRel(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__pa?.state().video.relPath ?? null);
}

/** Phase segments for a fixture, with names, as they appear in the export. */
function segsWith(phases: { id: string; name: string }[], bounds: [number, number, number][]): Seg[] {
  return bounds.map(([p, start, end]) => ({ phaseId: phases[p].id, phaseName: phases[p].name, start, end }));
}

// ============================================================================ listing & sorting

test('recursive listing shows relative paths and skips hidden folders, node_modules and non-videos', async ({ page }) => {
  const errors = await gotoApp(page);
  await buildFolder(page, 'rec', [
    { path: 'top.mp4', fixture: 'same_name_a.mp4' },
    { path: 'A/B/C/deep.mp4', fixture: 'same_name_b.mp4' },
    { path: 'A/upper.MP4', fixture: 'cfr25_bframes.mp4' },
    { path: 'A/clip.m4v', fixture: 'baseline24_nob.mp4' },
    { path: '.hidden/secret.mp4', fixture: 'tiny3.mp4' },
    { path: 'node_modules/pkg/vid.mp4', fixture: 'tiny3.mp4' },
    { path: 'A/.dot.mp4', fixture: 'tiny3.mp4' },
    { path: 'A/notes.txt', text: 'not a video' },
    { path: 'A/B/readme.md', text: '# not a video' },
    { path: 'A/B/C/deep.mp4.bak', text: 'not a video' },
    { path: 'n/case10.mp4', fixture: 'tiny3.mp4' },
    { path: 'n/case2.mp4', fixture: 'tiny3.mp4' },
  ]);
  await openFolder(page, 'rec');
  // Natural order within folders: case2 before case10.
  const expected = ['A/B/C/deep.mp4', 'A/clip.m4v', 'A/upper.MP4', 'n/case2.mp4', 'n/case10.mp4', 'top.mp4'];
  await waitVideoReady(page, expected[0]);
  expect((await items(page)).map((i) => i.relPath)).toEqual(expected);
  expect(await page.evaluate(() => window.__pa?.state().batch.rootName)).toBe('rec');
  await expect(rows(page)).toHaveCount(6);
  expect(await rowPaths(page)).toEqual(expected);
  // The file bar shows the open video's relative path.
  await expect(page.locator('.wb-filebar')).toContainText('deep.mp4');
  // Sizes come from the files.
  const sizes = Object.fromEntries((await items(page)).map((i) => [i.relPath, i.size]));
  expect(sizes).toEqual({
    'A/B/C/deep.mp4': manifest['same_name_b.mp4'].size,
    'A/clip.m4v': manifest['baseline24_nob.mp4'].size,
    'A/upper.MP4': manifest['cfr25_bframes.mp4'].size,
    'n/case2.mp4': manifest['tiny3.mp4'].size,
    'n/case10.mp4': manifest['tiny3.mp4'].size,
    'top.mp4': manifest['same_name_a.mp4'].size,
  });
  // No sidecars anywhere: everything is "Not annotated".
  await idle(page);
  expect((await items(page)).map((i) => i.status)).toEqual(expected.map(() => 'unannotated'));
  await expect(rows(page).nth(1)).toContainText('Not annotated');
  await page.screenshot({ path: `${SHOTS}01-recursive.png` });
  expect(errors).toEqual([]);
});

test('sort by name / modified / size (asc + desc); list click and Prev/Next follow the sorted order', async ({ page }) => {
  const errors = await gotoApp(page);
  // Write order (= modification order) differs from name order and from size order.
  await buildFolder(
    page,
    'sort',
    [
      { path: 'b_case.mp4', fixture: 'same_name_b.mp4' }, // 102066 B, oldest
      { path: 'sub/c_case.mp4', fixture: 'baseline24_nob.mp4' }, // 183867 B
      { path: 'a_case.mp4', fixture: 'cfr25_bframes.mp4' }, // 171242 B
      { path: 'd_case.mp4', fixture: 'same_name_a.mp4' }, // 104226 B, newest
    ],
    60,
  );
  await openFolder(page, 'sort');
  await waitVideoReady(page, 'a_case.mp4');
  const list = await items(page);
  const mtime = Object.fromEntries(list.map((i) => [i.relPath, i.lastModified]));
  // Sanity: OPFS gave strictly increasing modification times in write order.
  expect(mtime['b_case.mp4']).toBeLessThan(mtime['sub/c_case.mp4']);
  expect(mtime['sub/c_case.mp4']).toBeLessThan(mtime['a_case.mp4']);
  expect(mtime['a_case.mp4']).toBeLessThan(mtime['d_case.mp4']);

  const orders: Record<string, string[]> = {
    'name-asc': ['a_case.mp4', 'b_case.mp4', 'd_case.mp4', 'sub/c_case.mp4'],
    'mtime-asc': ['b_case.mp4', 'sub/c_case.mp4', 'a_case.mp4', 'd_case.mp4'],
    'size-asc': ['b_case.mp4', 'd_case.mp4', 'a_case.mp4', 'sub/c_case.mp4'],
  };
  for (const k of Object.keys(orders)) orders[k.replace('asc', 'desc')] = [...orders[k]].reverse();

  const sortSelect = page.getByRole('combobox', { name: 'Sort', exact: true });
  const dirAsc = page.getByRole('radio', { name: 'Ascending' });
  const dirDesc = page.getByRole('radio', { name: 'Descending' });
  const check = async (key: string, dir: string): Promise<void> => {
    const want = orders[`${key}-${dir}`];
    await expect.poll(async () => (await items(page)).map((i) => i.relPath), { message: `${key} ${dir}` }).toEqual(want);
    expect(await rowPaths(page), `rows ${key} ${dir}`).toEqual(want);
    expect(await page.evaluate(() => window.__pa?.state().settings.sort)).toEqual({ key, dir });
  };

  await check('name', 'asc');
  for (const [key, value] of [
    ['name', 'name'],
    ['mtime', 'mtime'],
    ['size', 'size'],
  ] as const) {
    await sortSelect.selectOption(value);
    await dirAsc.click();
    await check(key, 'asc');
    await dirDesc.click();
    await check(key, 'desc');
  }

  // Size, descending: walk the whole list with Next, then back with Previous.
  const order = orders['size-desc'];
  await rows(page).nth(0).click(); // switch from the list
  await waitVideoReady(page, order[0]);
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(prevBtn(page)).toBeDisabled();
  for (let i = 1; i < order.length; i++) {
    await nextBtn(page).click();
    await waitVideoReady(page, order[i]);
    await expect(rows(page).nth(i)).toHaveAttribute('aria-selected', 'true');
  }
  await expect(nextBtn(page)).toBeDisabled();
  for (let i = order.length - 2; i >= 0; i--) {
    await prevBtn(page).click();
    await waitVideoReady(page, order[i]);
  }

  // Re-sorting while a video is open keeps it open; Next follows the new order from its new place.
  await sortSelect.selectOption('mtime');
  await dirAsc.click();
  await check('mtime', 'asc');
  expect(await currentRel(page)).toBe(order[0]); // sub/c_case.mp4, now 2nd by mtime
  await nextBtn(page).click();
  await waitVideoReady(page, 'a_case.mp4');
  await prevBtn(page).click();
  await waitVideoReady(page, 'sub/c_case.mp4');
  await prevBtn(page).click();
  await waitVideoReady(page, 'b_case.mp4');

  // Switching from the list by clicking any row.
  await rows(page).nth(3).click();
  await waitVideoReady(page, 'd_case.mp4');
  await page.screenshot({ path: `${SHOTS}02-sorted-mtime.png` });

  // The sort order persists across a reload (settings in IndexedDB).
  await page.reload();
  await page.waitForFunction(() => window.__pa?.state().ready === true);
  expect(await page.evaluate(() => window.__pa?.state().settings.sort)).toEqual({ key: 'mtime', dir: 'asc' });
  expect(errors).toEqual([]);
});

// ============================================================================ sidecars

test('sidecar discovery: stem.csv, stem.phases.json, stem_annotations.csv, Stem-x.JSON go unverified → annotated', async ({ page }) => {
  const errors = await gotoApp(page);
  const ph = [
    { id: 'prep', name: 'Preparation' },
    { id: 'dissect', name: 'Dissection, step "2"' }, // needs CSV quoting
    { id: 'close', name: '=Closure' }, // needs formula protection
  ];
  const alpha = segsWith(ph, [
    [0, 0, 100],
    [1, 100, 250],
  ]);
  const beta = segsWith(ph, [[2, 30, 60]]);
  const delta = segsWith(ph, [[0, 0, 120]]);
  const gamma = segsWith(ph, [
    [0, 0, 10],
    [1, 10, 20],
    [2, 140, 150],
  ]);
  await buildFolder(page, 'side', [
    { path: 'a_plain.mp4', fixture: 'vfr_mixed.mp4' },
    { path: 'a_plain2.csv', text: 'not for a_plain (stem must be followed by . _ - or space)' },
    { path: 'v/alpha.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'v/alpha.csv', text: buildCsv('cfr25_bframes.mp4', alpha) },
    { path: 'v/beta.mp4', fixture: 'same_name_a.mp4' },
    { path: 'v/beta.phases.json', text: buildJson('same_name_a.mp4', 'beta.mp4', beta) },
    { path: 'v/deep/gamma.mp4', fixture: 'same_name_b.mp4' },
    { path: 'v/deep/gamma_annotations.csv', text: buildCsv('same_name_b.mp4', gamma) },
    // Case-insensitive stem and extension, '-' separator.
    { path: 'v/Delta.mp4', fixture: 'baseline24_nob.mp4' },
    { path: 'v/delta-annotations.JSON', text: buildJson('baseline24_nob.mp4', 'Delta.mp4', delta) },
  ]);
  await startStatusRecorder(page);
  await openFolder(page, 'side');
  await waitVideoReady(page, 'a_plain.mp4');
  expect(await sidecarsOf(page), 'a_plain2.csv is not a sidecar of a_plain.mp4').toEqual([]);
  await idle(page);

  const log = await statusLog(page);
  for (const rel of ['v/alpha.mp4', 'v/beta.mp4', 'v/deep/gamma.mp4', 'v/Delta.mp4']) {
    expect(log[rel]?.[0], `${rel} starts as not verified`).toBe('unverified');
    expect(log[rel]?.[log[rel].length - 1], `${rel} ends annotated`).toBe('annotated');
  }
  expect(await itemOf(page, 'v/alpha.mp4')).toMatchObject({ status: 'annotated', segmentCount: 2 });
  expect(await itemOf(page, 'v/beta.mp4')).toMatchObject({ status: 'annotated', segmentCount: 1 });
  expect(await itemOf(page, 'v/deep/gamma.mp4')).toMatchObject({ status: 'annotated', segmentCount: 3 });
  expect(await itemOf(page, 'v/Delta.mp4')).toMatchObject({ status: 'annotated', segmentCount: 1 });
  expect(await itemOf(page, 'a_plain.mp4')).toMatchObject({ status: 'unannotated' });
  await expect(rows(page).nth(1)).toContainText('Annotated');
  expect(await page.evaluate(() => window.__pa?.state().batch.verifying)).toBeNull();

  // Opening each one loads the verified file automatically, with no dialog.
  const cases: [string, string, Seg[]][] = [
    ['v/beta.mp4', 'beta.phases.json', beta],
    ['v/deep/gamma.mp4', 'gamma_annotations.csv', gamma],
    ['v/Delta.mp4', 'delta-annotations.JSON', delta],
    ['v/alpha.mp4', 'alpha.csv', alpha],
  ];
  for (const [rel, sidecar, segs] of cases) {
    const i = (await items(page)).findIndex((x) => x.relPath === rel);
    await rows(page).nth(i).click();
    await waitVideoReady(page, rel);
    expect(await sidecarsOf(page)).toEqual([{ name: sidecar, state: 'match', problems: [], segmentCount: segs.length }]);
    expect(await segsOf(page)).toEqual(segs.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
    expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
    expect(await page.evaluate(() => window.__pa?.state().dialog)).toBeNull();
    await expect(page.getByText(`Loaded annotations from ${sidecar}`)).toBeVisible();
  }
  // Phase names survive quoting and formula protection.
  const names = await page.evaluate(() => Object.values(window.__pa?.state().editor.doc.phases ?? {}).map((p) => p.name).sort());
  expect(names).toEqual(['Dissection, step "2"', 'Preparation']);
  await openTab(page, 'Export');
  await expect(page.locator('[data-testid="sidecars"]')).toContainText('alpha.csv');
  await expect(page.locator('[data-testid="sidecars"]')).toContainText('Matches');
  await page.screenshot({ path: `${SHOTS}03-sidecar-variants.png` });
  // Opening these untouched videos never wrote anything.
  expect(await listOpfs(page, 'side/v')).toEqual(['Delta.mp4', 'alpha.csv', 'alpha.mp4', 'beta.mp4', 'beta.phases.json', 'deep', 'delta-annotations.JSON']);
  expect(errors).toEqual([]);
});

test('same-name mismatch: caseA export copied next to caseB/same_name.mp4 → mismatch (SHA-256), never loaded', async ({ page }) => {
  const errors = await gotoApp(page);
  const A = 'caseA/same_name.mp4';
  const B = 'caseB/same_name.mp4';
  await buildFolder(page, 'same', [
    { path: A, fixture: 'same_name_a.mp4' },
    { path: B, fixture: 'same_name_b.mp4' },
  ]);
  await openFolder(page, 'same');
  await waitVideoReady(page, A);
  const ph = await twoPhases(page);
  await addSegments(page, [
    { phaseId: ph[0].id, start: 1, end: 11 },
    { phaseId: ph[1].id, start: 11, end: 150 },
  ]);
  await nextBtn(page).click();
  await waitVideoReady(page, B);
  const exportedA = await readOpfsText(page, 'same/caseA/same_name.phases.csv');
  expect(exportedA).toBe(buildCsv('same_name_a.mp4', segsWith(ph, [[0, 1, 11], [1, 11, 150]])));
  expect(await itemOf(page, A)).toMatchObject({ status: 'annotated', segmentCount: 2 });

  // Copy caseA's export next to caseB's video under caseB's (identical) sidecar name.
  await writeOpfsText(page, 'same/caseB/same_name.phases.csv', exportedA ?? '');
  await prevBtn(page).click();
  await waitVideoReady(page, A);
  await nextBtn(page).click();
  await waitVideoReady(page, B);

  expect(await sidecarsOf(page)).toEqual([{ name: 'same_name.phases.csv', state: 'mismatch', problems: ['ctl.verify.sha256_mismatch'], segmentCount: 2 }]);
  expect(await segsOf(page), 'nothing loaded into caseB').toEqual([]);
  expect(await page.evaluate(() => window.__pa?.state().dialog)).toBeNull();
  expect(await page.evaluate(() => window.__pa?.state().editor.touched)).toBe(false);
  expect(await itemOf(page, B)).toMatchObject({ status: 'mismatch', detail: 'ctl.verify.sha256_mismatch' });
  await expect(rows(page).nth(1)).toContainText('Mismatch');
  await openTab(page, 'Export');
  const sc = page.locator('[data-testid="sidecars"]');
  await expect(sc).toContainText('same_name.phases.csv');
  await expect(sc).toContainText('Different video');
  await expect(sc).toContainText('It belongs to a different video (SHA-256 differs).');
  await expect(sc.getByRole('button', { name: 'Load' })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}04-same-name-mismatch.png` });
  // Explicit "Load" via the action is refused too.
  await page.evaluate(() => window.__pa?.actions.importSidecar('caseB/same_name.phases.csv'));
  await expect(page.getByText('“same_name.phases.csv” was not loaded: problems found: 1.')).toBeVisible();
  expect(await segsOf(page)).toEqual([]);
  expect(await readDraft(page, manifest['same_name_b.mp4'].sha256)).toBeNull();

  // Annotating caseB and switching must not overwrite caseA's file sitting under caseB's name.
  const bSegs = segsWith(ph, [[1, 0, 30]]);
  await addSegments(page, bSegs);
  await prevBtn(page).click();
  const dlg = page.locator('[data-testid="switch-failed-dialog"]');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('“same_name.phases.csv” already exists and belongs to a different video. It was not overwritten.');
  expect(await readOpfsText(page, 'same/caseB/same_name.phases.csv')).toBe(exportedA);
  expect(await currentRel(page)).toBe(B);
  const download = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Download instead' }).click();
  expect(readFileSync(await (await download).path(), 'utf8')).toBe(buildCsv('same_name_b.mp4', bSegs));
  await waitVideoReady(page, A);
  expect(await readOpfsText(page, 'same/caseB/same_name.phases.csv')).toBe(exportedA);

  // Re-opening the folder: background verification flags caseB without opening it.
  await openFolder(page, 'same');
  await waitVideoReady(page, A);
  // caseB's own draft was exported (downloaded), so it counts as annotated; the foreign file is
  // still reported when caseB is opened.
  expect(await itemOf(page, B)).toMatchObject({ status: 'annotated', segmentCount: 1 });
  expect(await itemOf(page, A)).toMatchObject({ status: 'annotated' });
  await nextBtn(page).click();
  await waitVideoReady(page, B);
  expect(await sidecarsOf(page)).toEqual([{ name: 'same_name.phases.csv', state: 'mismatch', problems: ['ctl.verify.sha256_mismatch'], segmentCount: 2 }]);
  expect(await segsOf(page)).toEqual(bSegs.map((x) => ({ phaseId: x.phaseId, start: x.start, end: x.end })));
  expect(errors).toEqual([]);
});

test('corrupted sidecars (wrong frame count, bad boundaries, unparseable) are never loaded and explain why', async ({ page }) => {
  const errors = await gotoApp(page);
  const ph = [{ id: 'prep', name: 'Preparation' }, { id: 'dissect', name: 'Dissection' }];
  const good = segsWith(ph, [[0, 0, 100], [1, 100, 250]]);
  const cfr = metaOf('cfr25_bframes.mp4');
  // Same SHA-256, but the frame count / duration claim another encoding.
  const badCount = buildCsv('cfr25_bframes.mp4', good, { frameCount: 251, durationUs: cfr.durationUs + 40000 });
  // Correct video columns; two in-range rows overlap on 60–79 and a third ends past N.
  const a = manifest['same_name_a.mp4'];
  const am = metaOf('same_name_a.mp4');
  const row = (pid: string, name: string, s: number, e: number, su: number, eu: number): string =>
    ['1', am.sha256, am.frameCount, am.durationUs, pid, name, s, e, su, eu].join(',');
  const badBounds =
    '﻿' +
    [
      HEADER,
      row('prep', 'Preparation', 0, 80, 0, boundaryUs(a, 80)),
      row('dissect', 'Dissection', 60, 120, boundaryUs(a, 60), boundaryUs(a, 120)),
      row('dissect', 'Dissection', 120, 151, boundaryUs(a, 120), am.durationUs + 40000),
    ].join('\r\n') +
    '\r\n';
  // Wrong time for a correct frame boundary.
  const badTime = buildJson('same_name_b.mp4', 'bad_time.mp4', segsWith(ph, [[0, 10, 20]])).replace(`"start_us": ${boundaryUs(manifest['same_name_b.mp4'], 10)}`, '"start_us": 123');
  await buildFolder(page, 'bad', [
    { path: 'aa_ok.mp4', fixture: 'vfr_mixed.mp4' },
    { path: 'bad_count.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'bad_count.phases.csv', text: badCount },
    { path: 'bad_bounds.mp4', fixture: 'same_name_a.mp4' },
    { path: 'bad_bounds.csv', text: badBounds },
    { path: 'bad_parse.mp4', fixture: 'tiny3.mp4' },
    { path: 'bad_parse.phases.json', text: '{"format": "phase-annotations", "format_version": 1, "video": ' },
    { path: 'bad_time.mp4', fixture: 'same_name_b.mp4' },
    { path: 'bad_time.phases.json', text: badTime },
  ]);
  expect(badTime).toContain('"start_us": 123');
  await openFolder(page, 'bad');
  await waitVideoReady(page, 'aa_ok.mp4');
  await idle(page);
  expect(await itemOf(page, 'bad_count.mp4')).toMatchObject({ status: 'mismatch', detail: 'ctl.verify.frame_count_mismatch' });
  for (const rel of ['bad_bounds.mp4', 'bad_parse.mp4', 'bad_time.mp4']) {
    const it = await itemOf(page, rel);
    expect(it?.status, `${rel}: a broken file is not "annotated"`).toBe('mismatch');
    expect(it?.detail, `${rel}: status explains the problem`).not.toBeNull();
  }

  const expectations: [string, string, string, string[], RegExp][] = [
    ['bad_count.mp4', 'bad_count.phases.csv', 'mismatch', ['ctl.verify.frame_count_mismatch', 'ctl.verify.duration_mismatch'], /Frame count 251 differs from this video \(250\)/],
    ['bad_bounds.mp4', 'bad_bounds.csv', 'invalid', [], /0–150|overlap/],
    ['bad_parse.mp4', 'bad_parse.phases.json', 'invalid', [], /./],
    ['bad_time.mp4', 'bad_time.phases.json', 'invalid', ['ctl.verify.time_mismatch'], /start_us is 123 µs but the video frame is at 400000 µs/],
  ];
  for (const [rel, name, state, problemKeys, text] of expectations) {
    const i = (await items(page)).findIndex((x) => x.relPath === rel);
    await rows(page).nth(i).click();
    await waitVideoReady(page, rel);
    const sc = await sidecarsOf(page);
    expect(sc.map((s) => [s.name, s.state]), rel).toEqual([[name, state]]);
    expect(sc[0].problems.length, `${rel} lists its problems`).toBeGreaterThan(0);
    for (const k of problemKeys) expect(sc[0].problems, rel).toContain(k);
    expect(await segsOf(page), `${rel}: nothing loaded`).toEqual([]);
    expect(await page.evaluate(() => window.__pa?.state().dialog), rel).toBeNull();
    await openTab(page, 'Export');
    const panel = page.locator('[data-testid="sidecars"]');
    await expect(panel.locator('.wb-sidecar-problems li').first()).toBeVisible();
    await expect(panel.locator('.wb-sidecar-problems')).toContainText(text);
    await expect(panel.getByRole('button', { name: 'Load' })).toBeDisabled();
  }
  // bad_bounds: both the out-of-range end and the overlap are reported (all problems, not the first).
  await rows(page).nth((await items(page)).findIndex((x) => x.relPath === 'bad_bounds.mp4')).click();
  await waitVideoReady(page, 'bad_bounds.mp4');
  const keys = (await sidecarsOf(page))[0].problems;
  expect(keys.some((k) => /out_of_range/.test(k)), `out_of_range in ${keys}`).toBe(true);
  expect(keys.some((k) => /overlap/.test(k)), `overlap in ${keys}`).toBe(true);
  await page.screenshot({ path: `${SHOTS}05-corrupted.png` });
  expect(errors).toEqual([]);
});

test('large video: "Not verified" and progress while it hashes in the background; switching stays immediate', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await gotoApp(page);
  const PAD = 320 * 1024 * 1024;
  const bigSha = paddedSha256('cfr25_bframes.mp4', PAD);
  const segs = segsWith([{ id: 'prep', name: 'Preparation' }, { id: 'dissect', name: 'Dissection' }], [[0, 0, 120], [1, 120, 250]]);
  await buildFolder(page, 'big', [
    { path: 'a_small.mp4', fixture: 'same_name_a.mp4' },
    { path: 'b_big.phases.csv', text: buildCsv('cfr25_bframes.mp4', segs, { sha256: bigSha }) },
    { path: 'c_small.mp4', fixture: 'same_name_b.mp4' },
  ]);
  await writePaddedFixture(page, 'big/b_big.mp4', 'cfr25_bframes.mp4', PAD);
  await startStatusRecorder(page);
  await openFolder(page, 'big');
  const t0 = Date.now();
  // (waitVideoReady would also wait for background verification.)
  await page.waitForFunction(() => {
    const s = window.__pa?.state();
    return s?.video.relPath === 'a_small.mp4' && s.video.identity === 'verified' && window.__pa?.player()?.getSnapshot().displayedFrame === 0;
  });
  await expect(rows(page).nth(1)).toContainText('Not verified');
  await expect(page.getByText(/Verifying 0 \/ 1/)).toBeVisible();
  // Switch while the background hash runs: the foreground video must not wait for it.
  const t1 = Date.now();
  await rows(page).nth(2).click();
  await page.waitForFunction(() => {
    const s = window.__pa?.state();
    return s?.video.relPath === 'c_small.mp4' && s.video.hash.state === 'done' && window.__pa?.player()?.getSnapshot().displayedFrame === 0;
  });
  const switchMs = Date.now() - t1;
  expect(await page.evaluate(() => window.__pa?.state().batch.verifying), 'background verification still running after the switch').not.toBeNull();
  await idle(page);
  const totalMs = Date.now() - t0;
  test.info().annotations.push({ type: 'timing', description: `switch+hash small video ${switchMs} ms during background hash; total ${totalMs} ms` });
  expect(switchMs, 'foreground hash preempts background verification').toBeLessThan(Math.max(1500, totalMs / 2));
  expect((await statusLog(page))['b_big.mp4']).toEqual(['unverified', 'annotated']);
  expect(await itemOf(page, 'b_big.mp4')).toMatchObject({ status: 'annotated', segmentCount: 2, size: manifest['cfr25_bframes.mp4'].size + PAD + 8 });
  await rows(page).nth(1).click();
  await waitVideoReady(page, 'b_big.mp4');
  expect(await page.evaluate(() => window.__pa?.state().video.hash.sha256)).toBe(bigSha);
  expect(await segsOf(page)).toEqual([{ phaseId: 'prep', start: 0, end: 120 }, { phaseId: 'dissect', start: 120, end: 250 }]);
  expect(errors).toEqual([]);
});

test('a neighbour with a longer stem keeps its sidecar: case_2.phases.csv is not a sidecar of case.mp4', async ({ page }) => {
  const errors = await gotoApp(page);
  const segs = segsWith([{ id: 'prep', name: 'Preparation' }], [[0, 0, 150]]);
  await buildFolder(page, 'stem', [
    { path: 'case.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'case_2.mp4', fixture: 'same_name_a.mp4' },
    { path: 'case_2.phases.csv', text: buildCsv('same_name_a.mp4', segs) },
  ]);
  await openFolder(page, 'stem');
  const first = (await items(page))[0].relPath;
  await waitVideoReady(page, first);
  await idle(page);
  expect(await itemOf(page, 'case_2.mp4')).toMatchObject({ status: 'annotated', segmentCount: 1 });
  expect(await itemOf(page, 'case.mp4'), 'background status from the folder scan').toMatchObject({ status: 'unannotated' });
  if (first !== 'case.mp4') {
    await rows(page).nth((await items(page)).findIndex((i) => i.relPath === 'case.mp4')).click();
    await waitVideoReady(page, 'case.mp4');
  }
  // case.mp4 has no annotation file of its own: it must not be flagged as a mismatch because of
  // its neighbour's file (the folder scan already pairs case_2.phases.csv with case_2.mp4 only).
  expect.soft(await sidecarsOf(page), 'sidecars listed for case.mp4').toEqual([]);
  expect.soft(await itemOf(page, 'case.mp4'), 'status of the open case.mp4').toMatchObject({ status: 'unannotated' });
  // Leaving it again keeps the batch status consistent with the folder scan.
  await rows(page).nth((await items(page)).findIndex((i) => i.relPath === 'case_2.mp4')).click();
  await waitVideoReady(page, 'case_2.mp4');
  expect.soft(await itemOf(page, 'case.mp4'), 'status of case.mp4 after leaving it').toMatchObject({ status: 'unannotated' });
  expect(await segsOf(page)).toEqual([{ phaseId: 'prep', start: 0, end: 150 }]);
  expect(errors).toEqual([]);
});

// ============================================================================ sidecar vs draft

/**
 * Leaves a 1-segment draft for ic/one.mp4 in IndexedDB (never exported), then adds a matching
 * sidecar with 2 different segments and reloads. The app reconnects the remembered folder,
 * finds the draft and the sidecar, and must ask.
 */
async function draftThenSidecar(page: Page): Promise<{ draft: { phaseId: string; start: number; end: number }[]; file: Seg[] }> {
  await buildFolder(page, 'ic', [
    { path: 'one.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'two.mp4', fixture: 'same_name_a.mp4' },
  ]);
  await openFolder(page, 'ic');
  await waitVideoReady(page, 'one.mp4');
  const ph = await twoPhases(page);
  const draft = [{ phaseId: ph[0].id, start: 10, end: 50 }];
  await addSegments(page, draft);
  await page.evaluate(() => window.__pa?.flushAutosave());
  const sha = manifest['cfr25_bframes.mp4'].sha256;
  expect((await readDraft(page, sha))?.segments.map((s) => [s.start, s.end])).toEqual([[10, 50]]);

  const file = segsWith([{ id: 'prep', name: 'Preparation' }, { id: 'dissect', name: 'Dissection' }], [[0, 0, 100], [1, 100, 250]]);
  await writeOpfsText(page, 'ic/one.phases.csv', buildCsv('cfr25_bframes.mp4', file));
  await page.reload();
  await page.waitForFunction(() => window.__pa?.state().ready === true);
  // The remembered OPFS folder is reconnected automatically (permission is granted).
  await page.waitForFunction(() => window.__pa?.state().batch.mode === 'folder', undefined, { timeout: 10_000 });
  await waitVideoReady(page, 'one.mp4');
  return { draft, file };
}

test('sidecar vs existing draft → import-choice dialog; "Use file" replaces the draft after an auto-before-import checkpoint', async ({ page }) => {
  const errors = await gotoApp(page);
  const { draft, file } = await draftThenSidecar(page);
  const dlg = page.locator('[data-testid="import-choice-dialog"]');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('one.phases.csv');
  await expect(dlg).toContainText('Draft in this browser');
  await expect(dlg).toContainText('Segments: 1');
  await expect(dlg).toContainText('Segments: 2');
  expect(await page.evaluate(() => window.__pa?.state().dialog)).toEqual({ kind: 'import-choice', sidecarName: 'one.phases.csv', fileSegmentCount: 2, draftSegmentCount: 1 });
  expect(await segsOf(page), 'draft shown until the user decides').toEqual(draft);
  await page.screenshot({ path: `${SHOTS}06-import-choice.png` });

  await dlg.getByRole('button', { name: 'Use file' }).click();
  await expect(dlg).toBeHidden();
  await expect.poll(() => segsOf(page)).toEqual(file.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
  await expect.poll(() => page.evaluate(() => window.__pa?.state().checkpoints.map((c) => [c.kind, c.segmentCount]))).toEqual([['auto-before-import', 1]]);
  await openTab(page, 'Checkpoints');
  await expect(page.locator('[data-testid="checkpoints-table"]')).toContainText('Before import');
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
  expect(await itemOf(page, 'one.mp4')).toMatchObject({ status: 'annotated', segmentCount: 2 });
  await page.evaluate(() => window.__pa?.flushAutosave());
  expect((await readDraft(page, manifest['cfr25_bframes.mp4'].sha256))?.segments.map((s) => [s.start, s.end])).toEqual([[0, 100], [100, 250]]);

  // The checkpoint really holds the replaced draft: restoring it brings the 1 segment back.
  const cpId = await page.evaluate(() => window.__pa?.state().checkpoints[0].id ?? '');
  await page.evaluate((id) => window.__pa?.actions.restoreCheckpoint(id), cpId);
  await expect.poll(() => segsOf(page)).toEqual(draft);
  // Nothing to export on Next would be wrong now: the restored draft differs from the file.
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(true);
  expect(errors).toEqual([]);
});

test('sidecar vs existing draft → "Keep draft" keeps it untouched and creates no checkpoint', async ({ page }) => {
  const errors = await gotoApp(page);
  const { draft } = await draftThenSidecar(page);
  const dlg = page.locator('[data-testid="import-choice-dialog"]');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Keep draft' }).click();
  await expect(dlg).toBeHidden();
  await idle(page);
  expect(await segsOf(page)).toEqual(draft);
  expect(await page.evaluate(() => window.__pa?.state().checkpoints)).toEqual([]);
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(true);
  expect(await itemOf(page, 'one.mp4')).toMatchObject({ status: 'draft', segmentCount: 1 });
  expect(await sidecarsOf(page)).toEqual([{ name: 'one.phases.csv', state: 'match', problems: [], segmentCount: 2 }]);
  expect((await readDraft(page, manifest['cfr25_bframes.mp4'].sha256))?.segments.map((s) => [s.start, s.end])).toEqual([[10, 50]]);
  // The sidecar file is untouched until the next export.
  expect(await readOpfsText(page, 'ic/one.phases.csv')).toBe(
    buildCsv('cfr25_bframes.mp4', segsWith([{ id: 'prep', name: 'Preparation' }, { id: 'dissect', name: 'Dissection' }], [[0, 0, 100], [1, 100, 250]])),
  );
  // Switching exports the kept draft over the sidecar (same video, so overwriting is allowed).
  await nextBtn(page).click();
  await waitVideoReady(page, 'two.mp4');
  const ph = await page.evaluate((id) => window.__pa?.state().library.phases[id].name ?? '', draft[0].phaseId);
  expect(await readOpfsText(page, 'ic/one.phases.csv')).toBe(buildCsv('cfr25_bframes.mp4', [{ ...draft[0], phaseName: ph }]));
  expect(errors).toEqual([]);
});

// ============================================================================ export on switch

test('switching auto-exports beside the source (CSV default) and follows format / destination changes', async ({ page }) => {
  const errors = await gotoApp(page);
  await buildFolder(page, 'exp', [
    { path: 'v1.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'v2.mp4', fixture: 'same_name_a.mp4' },
    { path: 'v3.mp4', fixture: 'same_name_b.mp4' },
    { path: 'w/v4.mp4', fixture: 'vfr_mixed.mp4' },
    { path: 'w/v5.mp4', fixture: 'baseline24_nob.mp4' },
  ]);
  await openFolder(page, 'exp');
  await waitVideoReady(page, 'v1.mp4');
  const ph = await twoPhases(page);
  expect(await page.evaluate(() => window.__pa?.state().settings.exportFormat)).toBe('csv');
  expect(await page.evaluate(() => window.__pa?.state().settings.exportDestination)).toEqual({ kind: 'beside' });
  await openTab(page, 'Export');
  const fmt = page.getByRole('radiogroup', { name: 'Format' });
  const dest = page.getByRole('radiogroup', { name: 'Destination' });
  await expect(fmt.getByRole('radio', { name: 'CSV' })).toHaveAttribute('aria-checked', 'true');

  // v1: default → CSV beside the video, nothing else.
  const s1 = segsWith(ph, [[0, 5, 20], [1, 20, 250]]);
  await addSegments(page, s1);
  await nextBtn(page).click();
  await waitVideoReady(page, 'v2.mp4');
  expect(await readOpfsText(page, 'exp/v1.phases.csv')).toBe(buildCsv('cfr25_bframes.mp4', s1));
  expect(await listOpfs(page, 'exp')).toEqual(['v1.mp4', 'v1.phases.csv', 'v2.mp4', 'v3.mp4', 'w']);
  expect(await itemOf(page, 'v1.mp4')).toMatchObject({ status: 'annotated', segmentCount: 2 });

  // v2: JSON.
  await openTab(page, 'Export');
  await fmt.getByRole('radio', { name: 'JSON' }).click();
  const s2 = segsWith(ph, [[1, 0, 75]]);
  await addSegments(page, s2);
  await nextBtn(page).click();
  await waitVideoReady(page, 'v3.mp4');
  const j2 = await readOpfsText(page, 'exp/v2.phases.json');
  expect(j2?.charCodeAt(0), 'JSON has no BOM').not.toBe(0xfeff);
  expect(JSON.parse(j2 ?? 'null')).toEqual(jsonDoc('same_name_a.mp4', 'v2.mp4', s2));
  expect(j2?.split('\n').filter((l) => l.includes('"phase_id"')).length, 'one segment per line').toBe(1);
  expect(await readOpfsText(page, 'exp/v2.phases.csv')).toBeNull();

  // v3: Both.
  await openTab(page, 'Export');
  await fmt.getByRole('radio', { name: 'Both' }).click();
  const s3 = segsWith(ph, [[0, 0, 1], [1, 149, 150]]);
  await addSegments(page, s3);
  await nextBtn(page).click();
  await waitVideoReady(page, 'w/v4.mp4');
  expect(await readOpfsText(page, 'exp/v3.phases.csv')).toBe(buildCsv('same_name_b.mp4', s3));
  expect(JSON.parse((await readOpfsText(page, 'exp/v3.phases.json')) ?? 'null')).toEqual(jsonDoc('same_name_b.mp4', 'v3.mp4', s3));

  // v4 (VFR): CSV to Download.
  await openTab(page, 'Export');
  await fmt.getByRole('radio', { name: 'CSV' }).click();
  await dest.getByRole('radio', { name: 'Download' }).click();
  const s4 = segsWith(ph, [[0, 3, 117], [1, 117, 239]]);
  await addSegments(page, s4);
  const download = page.waitForEvent('download');
  await nextBtn(page).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('v4.phases.csv');
  expect(readFileSync(await dl.path(), 'utf8')).toBe(buildCsv('vfr_mixed.mp4', s4));
  await waitVideoReady(page, 'w/v5.mp4');
  expect(await listOpfs(page, 'exp/w'), 'download wrote nothing beside the video').toEqual(['v4.mp4', 'v5.mp4']);
  expect(await itemOf(page, 'w/v4.mp4')).toMatchObject({ status: 'annotated' });

  // v5: a chosen folder (mirrors the batch sub-folder), JSON + CSV.
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    await window.__pa?.setExportFolderHandle(await opfs.getDirectoryHandle('exp-out', { create: true }));
  });
  await openTab(page, 'Export');
  await expect(dest.getByRole('radio', { name: 'Folder…' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Folder: exp-out')).toBeVisible();
  await fmt.getByRole('radio', { name: 'Both' }).click();
  const s5 = segsWith(ph, [[1, 24, 48]]);
  await addSegments(page, s5);
  await prevBtn(page).click();
  await waitVideoReady(page, 'w/v4.mp4');
  expect(await listOpfs(page, 'exp-out/w')).toEqual(['v5.phases.csv', 'v5.phases.json']);
  expect(JSON.parse((await readOpfsText(page, 'exp-out/w/v5.phases.json')) ?? 'null')).toEqual(jsonDoc('baseline24_nob.mp4', 'v5.mp4', s5));
  expect(await listOpfs(page, 'exp/w')).toEqual(['v4.mp4', 'v5.mp4']);
  expect(await page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(0);
  expect(errors).toEqual([]);
});

// ============================================================================ denied write permission

/** Folder with two same-name videos; caseA gets two segments; writes into `deny` are then denied. */
async function annotatedThenDenied(page: Page): Promise<Seg[]> {
  await buildFolder(page, 'deny', [
    { path: 'caseA/same_name.mp4', fixture: 'same_name_a.mp4' },
    { path: 'caseB/same_name.mp4', fixture: 'same_name_b.mp4' },
  ]);
  await openFolder(page, 'deny');
  await waitVideoReady(page, 'caseA/same_name.mp4');
  expect(await page.evaluate(() => window.__pa?.state().batch.access)).toBe('readwrite');
  const ph = await twoPhases(page);
  const segs = segsWith(ph, [[0, 0, 40], [1, 40, 150]]);
  await addSegments(page, segs);
  await denyWritePermission(page, 'deny');
  return segs;
}

async function expectBlockedOnA(page: Page, segs: Seg[]): Promise<void> {
  const dlg = page.locator('[data-testid="switch-failed-dialog"]');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Could not export before switching');
  await expect(dlg).toContainText('permission to write to the folder was denied');
  await expect(dlg).toContainText('Your draft stays saved in this browser.');
  for (const name of ['Download instead', 'Choose another folder', 'Switch without exporting', 'Stay on this video']) {
    await expect(dlg.getByRole('button', { name })).toBeEnabled();
  }
  const st = await page.evaluate(() => {
    const s = window.__pa?.state();
    return { current: s?.batch.currentId, rel: s?.video.relPath, phase: s?.video.loadPhase, dialog: s?.dialog?.kind, failure: s?.dialog?.kind === 'switch-failed' ? s.dialog.failure : null };
  });
  expect(st).toMatchObject({ current: 'caseA/same_name.mp4', rel: 'caseA/same_name.mp4', phase: 'ready', dialog: 'switch-failed' });
  expect(st.failure).toMatchObject({ reason: 'write', msg: { key: 'ctl.export.failed.permission_denied' }, canDownload: true });
  expect(await segsOf(page), 'draft still open').toEqual(segs.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
  expect(await page.evaluate(() => window.__pa?.player()?.getSnapshot().displayedFrame)).not.toBeNull();
  expect(await readOpfsText(page, 'deny/caseA/same_name.phases.csv'), 'nothing written').toBeNull();
  expect(await permLog(page), 'the app asked for readwrite and was refused').toContain('request:caseA:readwrite:denied');
}

test('denied write permission blocks the switch, explains recovery; Stay keeps everything; "Download instead" exports and switches', async ({ page }) => {
  const errors = await gotoApp(page);
  const segs = await annotatedThenDenied(page);
  await nextBtn(page).click();
  await expectBlockedOnA(page, segs);
  await page.screenshot({ path: `${SHOTS}07-denied.png` });

  const dlg = page.locator('[data-testid="switch-failed-dialog"]');
  await dlg.getByRole('button', { name: 'Stay on this video' }).click();
  await expect(dlg).toBeHidden();
  expect(await page.evaluate(() => window.__pa?.state().batch.currentId)).toBe('caseA/same_name.mp4');
  await expect(page.locator('[data-testid="export-state"]')).toContainText('Export failed');

  // Switching from the list is gated the same way.
  await rows(page).nth(1).click();
  await expectBlockedOnA(page, segs);

  const download = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Download instead' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('same_name.phases.csv');
  expect(readFileSync(await dl.path(), 'utf8')).toBe(buildCsv('same_name_a.mp4', segs));
  await waitVideoReady(page, 'caseB/same_name.mp4');
  await expect(dlg).toBeHidden();
  expect(await readOpfsText(page, 'deny/caseA/same_name.phases.csv')).toBeNull();
  expect(await itemOf(page, 'caseA/same_name.mp4')).toMatchObject({ status: 'annotated', segmentCount: 2 });
  expect(await page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(0);
  expect(errors).toEqual([]);
});

test('denied write permission → "Choose another folder" exports there (sub-folders mirrored) and switches', async ({ page }) => {
  const errors = await gotoApp(page);
  const segs = await annotatedThenDenied(page);
  await stubDirectoryPicker(page, 'deny-out');
  await nextBtn(page).click();
  await expectBlockedOnA(page, segs);
  await page.locator('[data-testid="switch-failed-dialog"]').getByRole('button', { name: 'Choose another folder' }).click();
  await waitVideoReady(page, 'caseB/same_name.mp4');
  expect(await readOpfsText(page, 'deny-out/caseA/same_name.phases.csv')).toBe(buildCsv('same_name_a.mp4', segs));
  expect(await page.evaluate(() => window.__pa?.state().settings.exportDestination)).toEqual({ kind: 'folder', folderName: 'deny-out' });
  expect(await itemOf(page, 'caseA/same_name.mp4')).toMatchObject({ status: 'annotated' });
  expect(errors).toEqual([]);
});

test('denied write permission → "Switch without exporting" keeps the draft in IndexedDB and the leave warning', async ({ page }) => {
  const errors = await gotoApp(page);
  const segs = await annotatedThenDenied(page);
  await nextBtn(page).click();
  await expectBlockedOnA(page, segs);
  await page.locator('[data-testid="switch-failed-dialog"]').getByRole('button', { name: 'Switch without exporting' }).click();
  await waitVideoReady(page, 'caseB/same_name.mp4');
  const shaA = manifest['same_name_a.mp4'].sha256;
  const rec = await readDraft(page, shaA);
  expect(rec?.segments.map((s) => [s.phaseId, s.start, s.end])).toEqual(segs.map((s) => [s.phaseId, s.start, s.end]));
  expect(rec?.exported).toBeNull();
  expect(await itemOf(page, 'caseA/same_name.mp4')).toMatchObject({ status: 'draft', segmentCount: 2 });
  expect(await page.evaluate(() => window.__pa?.state().unexportedCount)).toBe(1);
  await expect(rows(page).nth(0)).toContainText('Draft');
  expect(await readOpfsText(page, 'deny/caseA/same_name.phases.csv')).toBeNull();

  // Back on caseA the draft is there and still unexported; leaving again is gated again.
  await prevBtn(page).click();
  await waitVideoReady(page, 'caseA/same_name.mp4');
  expect(await segsOf(page)).toEqual(segs.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(true);
  await nextBtn(page).click();
  await expect(page.locator('[data-testid="switch-failed-dialog"]')).toBeVisible();
  await page.locator('[data-testid="switch-failed-dialog"]').getByRole('button', { name: 'Switch without exporting' }).click();
  await waitVideoReady(page, 'caseB/same_name.mp4');

  // After a reload (permission patch gone) the batch still reports caseA's unexported draft.
  await page.reload();
  await page.waitForFunction(() => window.__pa?.state().batch.mode === 'folder', undefined, { timeout: 10_000 });
  await waitVideoReady(page, 'caseA/same_name.mp4');
  expect(await segsOf(page)).toEqual(segs.map((s) => ({ phaseId: s.phaseId, start: s.start, end: s.end })));
  expect(await itemOf(page, 'caseA/same_name.mp4')).toMatchObject({ status: 'draft', segmentCount: 2 });
  await nextBtn(page).click();
  await waitVideoReady(page, 'caseB/same_name.mp4');
  expect(await readOpfsText(page, 'deny/caseA/same_name.phases.csv')).toBe(buildCsv('same_name_a.mp4', segs));
  expect(errors).toEqual([]);
});

// ============================================================================ empty draft

test('emptied draft exports the empty-annotation form and re-imports as annotated with 0 segments', async ({ page, browser }) => {
  const errors = await gotoApp(page);
  const ph = [{ id: 'prep', name: 'Preparation' }, { id: 'dissect', name: 'Dissection' }];
  await buildFolder(page, 'empty', [
    { path: 'case.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'case.phases.csv', text: buildCsv('cfr25_bframes.mp4', segsWith(ph, [[0, 0, 100], [1, 100, 250]])) },
    { path: 'other.mp4', fixture: 'same_name_a.mp4' },
  ]);
  await openFolder(page, 'empty');
  await waitVideoReady(page, 'case.mp4');
  expect((await segsOf(page)).length).toBe(2);
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);

  await openTab(page, 'Export');
  await page.getByRole('radiogroup', { name: 'Format' }).getByRole('radio', { name: 'Both' }).click();
  await openTab(page, 'Segments');
  const del = page.locator('[data-testid="segments-table"]').getByRole('button', { name: 'Delete segment' });
  await expect(del).toHaveCount(2);
  await del.first().click();
  await del.first().click();
  await expect(del).toHaveCount(0);
  expect(await segsOf(page)).toEqual([]);
  expect(await page.evaluate(() => ({ touched: window.__pa?.state().editor.touched, dirty: window.__pa?.state().editor.dirty }))).toEqual({ touched: true, dirty: true });
  await openTab(page, 'Export');
  await expect(page.getByText('An empty annotation exports as one row with the video columns only.')).toBeVisible();

  await nextBtn(page).click();
  await waitVideoReady(page, 'other.mp4');
  const csv = await readOpfsText(page, 'empty/case.phases.csv');
  const m = metaOf('cfr25_bframes.mp4');
  expect(csv).toBe(`﻿${HEADER}\r\n1,${m.sha256},${m.frameCount},${m.durationUs},,,,,,\r\n`);
  expect(csv).toBe(buildCsv('cfr25_bframes.mp4', []));
  expect(JSON.parse((await readOpfsText(page, 'empty/case.phases.json')) ?? 'null')).toEqual(jsonDoc('cfr25_bframes.mp4', 'case.mp4', []));
  expect(await itemOf(page, 'case.mp4')).toMatchObject({ status: 'annotated', segmentCount: 0 });

  // Untouched videos are not exported.
  await prevBtn(page).click();
  await waitVideoReady(page, 'case.mp4');
  expect(await listOpfs(page, 'empty')).toEqual(['case.mp4', 'case.phases.csv', 'case.phases.json', 'other.mp4']);
  // Recognised: both files match with 0 segments, nothing to export, no dialog.
  expect(await sidecarsOf(page)).toEqual([
    { name: 'case.phases.csv', state: 'match', problems: [], segmentCount: 0 },
    { name: 'case.phases.json', state: 'match', problems: [], segmentCount: 0 },
  ]);
  expect(await segsOf(page)).toEqual([]);
  expect(await page.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
  expect(await page.evaluate(() => window.__pa?.state().dialog)).toBeNull();
  expect(await itemOf(page, 'case.mp4')).toMatchObject({ status: 'annotated', segmentCount: 0 });

  // A fresh browser profile (no drafts) recognises the empty file through background verification.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  const errors2 = await gotoApp(p2);
  await buildFolder(p2, 'empty2', [
    { path: 'a_first.mp4', fixture: 'same_name_a.mp4' },
    { path: 'z_case.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'z_case.phases.csv', text: csv ?? '' },
  ]);
  await startStatusRecorder(p2);
  await openFolder(p2, 'empty2');
  await waitVideoReady(p2, 'a_first.mp4');
  await idle(p2);
  expect((await statusLog(p2))['z_case.mp4']).toEqual(['unverified', 'annotated']);
  expect(await itemOf(p2, 'z_case.mp4')).toMatchObject({ status: 'annotated', segmentCount: 0 });
  await rows(p2).nth(1).click();
  await waitVideoReady(p2, 'z_case.mp4');
  expect(await sidecarsOf(p2)).toEqual([{ name: 'z_case.phases.csv', state: 'match', problems: [], segmentCount: 0 }]);
  expect(await segsOf(p2)).toEqual([]);
  expect(await p2.evaluate(() => window.__pa?.state().editor.dirty)).toBe(false);
  await ctx.close();
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});

// ============================================================================ single file

test('a single MP4 opened without its folder shows "Allow folder access"; granting it finds and loads the sidecar', async ({ page }) => {
  const errors = await gotoApp(page);
  const ph = [{ id: 'prep', name: 'Preparation' }];
  const segs = segsWith(ph, [[0, 25, 125]]);
  await buildFolder(page, 'single', [
    { path: 'clip.mp4', fixture: 'cfr25_bframes.mp4' },
    { path: 'clip.phases.csv', text: buildCsv('cfr25_bframes.mp4', segs) },
  ]);
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('single');
    await window.__pa?.openFileHandle(await dir.getFileHandle('clip.mp4'));
  });
  await waitVideoReady(page, 'clip.mp4');
  const st = await page.evaluate(() => {
    const s = window.__pa?.state();
    return { mode: s?.batch.mode, access: s?.batch.access, sourceFolder: s?.video.sourceFolder, items: s?.batch.items.map((i) => i.relPath) };
  });
  expect(st).toEqual({ mode: 'file', access: 'none', sourceFolder: 'needs-access', items: ['clip.mp4'] });
  expect(await sidecarsOf(page)).toEqual([]);
  expect(await segsOf(page)).toEqual([]);
  const notice = page.getByText('Allow access to this video’s folder to find annotation files and save exports beside it.');
  await expect(notice.first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow folder access' }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}08-single-file-notice.png` });

  // Export beside the video is impossible without the folder: explained, nothing written.
  await openTab(page, 'Export');
  await page.getByRole('button', { name: 'Export now' }).click();
  await expect(page.getByText(/the folder of this video is not accessible/).first()).toBeVisible();

  // Allow folder access (the picker returns the video's folder).
  await stubDirectoryPicker(page, 'single');
  await page.getByRole('button', { name: 'Allow folder access' }).first().click();
  await expect.poll(() => page.evaluate(() => window.__pa?.state().video.sourceFolder)).toBe('available');
  await idle(page);
  expect(await page.evaluate(() => window.__pa?.state().batch.access)).toBe('readwrite');
  expect(await sidecarsOf(page)).toEqual([{ name: 'clip.phases.csv', state: 'match', problems: [], segmentCount: 1 }]);
  expect(await segsOf(page)).toEqual([{ phaseId: 'prep', start: 25, end: 125 }]);
  await expect(notice).toHaveCount(0);

  // With the parent known up front there is no notice at all.
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('single');
    await window.__pa?.openFileHandle(await dir.getFileHandle('clip.mp4'), dir);
  });
  await waitVideoReady(page, 'clip.mp4');
  expect(await page.evaluate(() => window.__pa?.state().video.sourceFolder)).toBe('available');
  expect(await segsOf(page)).toEqual([{ phaseId: 'prep', start: 25, end: 125 }]);
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ============================================================================ read-only (virtual) folder

test('read-only folder via <input webkitdirectory> fallback: listed with relative paths, exports download on switch', async ({ page }) => {
  const errors = await gotoApp(page);
  const dirRoot = fileURLToPath(new URL('../artifacts/batch-virtual/', import.meta.url));
  rmSync(dirRoot, { recursive: true, force: true });
  const vroot = `${dirRoot}vroot/`;
  mkdirSync(`${vroot}caseA`, { recursive: true });
  mkdirSync(`${vroot}caseB`, { recursive: true });
  const fx = (f: string): string => fileURLToPath(new URL(`../fixtures/videos/${f}`, import.meta.url));
  copyFileSync(fx('same_name_a.mp4'), `${vroot}caseA/same_name.mp4`);
  copyFileSync(fx('same_name_b.mp4'), `${vroot}caseB/same_name.mp4`);
  const bSegs = segsWith([{ id: 'prep', name: 'Preparation' }], [[0, 0, 150]]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${vroot}caseB/same_name.phases.csv`, buildCsv('same_name_b.mp4', bSegs));

  // The directory picker exists but is blocked (SecurityError) → the app falls back to the input.
  await page.evaluate(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<never> }).showDirectoryPicker = () => Promise.reject(new DOMException('blocked', 'SecurityError'));
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open folder…' }).first().click();
  await (await chooser).setFiles(vroot);
  await waitVideoReady(page, 'caseA/same_name.mp4');
  expect(await page.evaluate(() => window.__pa?.state().batch.access)).toBe('virtual');
  expect((await items(page)).map((i) => i.relPath)).toEqual(['caseA/same_name.mp4', 'caseB/same_name.mp4']);
  await expect(page.getByText('This browser cannot write to folders. Exports will be downloaded instead.').first()).toBeVisible();
  await idle(page);
  expect(await itemOf(page, 'caseB/same_name.mp4')).toMatchObject({ status: 'annotated', segmentCount: 1 });

  const ph = await twoPhases(page);
  const aSegs = segsWith(ph, [[0, 10, 20]]);
  await addSegments(page, aSegs);
  const download = page.waitForEvent('download');
  await nextBtn(page).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('same_name.phases.csv');
  expect(readFileSync(await dl.path(), 'utf8')).toBe(buildCsv('same_name_a.mp4', aSegs));
  await waitVideoReady(page, 'caseB/same_name.mp4');
  expect(await segsOf(page)).toEqual([{ phaseId: 'prep', start: 0, end: 150 }]);
  expect(await itemOf(page, 'caseA/same_name.mp4')).toMatchObject({ status: 'annotated' });
  expect(errors).toEqual([]);
});

test('folder opened without write permission: read-only notice matches what happens on switch', async ({ page }) => {
  const errors = await gotoApp(page);
  await buildFolder(page, 'ro', [
    { path: 'a.mp4', fixture: 'same_name_a.mp4' },
    { path: 'b.mp4', fixture: 'same_name_b.mp4' },
  ]);
  await denyWritePermission(page, 'ro');
  await openFolder(page, 'ro');
  await waitVideoReady(page, 'a.mp4');
  expect(await page.evaluate(() => window.__pa?.state().batch.access)).toBe('read');
  await expect(page.locator('.wb-pane-banner')).toBeVisible();
  const ph = await twoPhases(page);
  const segs = segsWith(ph, [[0, 5, 9]]);
  await addSegments(page, segs);
  // Whatever the app does on switch must match what the notice told the user: if it promises
  // downloads, switching downloads; otherwise the failure dialog offers "Download instead".
  const promisesDownload = await page.getByText('Exports will be downloaded').first().isVisible();
  const download = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await nextBtn(page).click();
  const failed = page.locator('[data-testid="switch-failed-dialog"]');
  await expect.poll(async () => (await failed.isVisible()) || (await currentRel(page)) === 'b.mp4').toBe(true);
  if (promisesDownload) {
    expect(await failed.isVisible(), 'notice says "Exports will be downloaded" but Next fails with a write error').toBe(false);
  } else {
    await expect(failed.getByRole('button', { name: 'Download instead' })).toBeVisible();
    await failed.getByRole('button', { name: 'Download instead' }).click();
  }
  const dl = await download;
  expect(dl?.suggestedFilename()).toBe('a.phases.csv');
  await waitVideoReady(page, 'b.mp4');
  expect(errors).toEqual([]);
});
