/**
 * Light / dark theme, driven through the top-bar "Appearance" menu with real clicks.
 *
 *  - default is dark; choosing Light flips the app surfaces and text, persists to settings
 *    (IndexedDB) and the localStorage mirror, while the video stage stays dark and the player
 *    canvas still carries the right frame;
 *  - the timeline canvas repaints from the theme tokens without a reload;
 *  - after a reload the light theme is on <html> before the first paint (no dark flash);
 *  - "Match system" follows prefers-color-scheme live and before the first paint;
 *  - switching theme never touches the annotation work, and shortcuts keep working afterwards;
 *  - the menu is translated in 繁中.
 */
import { test, expect } from '@playwright/test';
import {
  RECORD_EARLY_THEME,
  appearanceButton,
  chooseTheme,
  cssLuminance,
  expectSettledAt,
  menuState,
  openFixture,
  themeRecord,
  timelineLaneLuminance,
  waitReady,
} from './helpers/theme';

const FIXTURE = 'cfr25_bframes.mp4';
const html = (page: import('@playwright/test').Page) => page.locator('html');

function collectErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function settingsTheme(page: import('@playwright/test').Page): Promise<string | undefined> {
  return page.evaluate(() => window.__pa?.state().settings.theme);
}

async function mirroredPref(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('pa-theme'));
}

test('default theme is dark and the Appearance menu shows Dark checked', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitReady(page);
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  expect(await settingsTheme(page)).toBe('dark');
  expect(await cssLuminance(page, 'body', 'backgroundColor')).toBeLessThan(0.1);
  expect(await cssLuminance(page, 'body', 'color')).toBeGreaterThan(0.6);
  expect(await menuState(page)).toEqual({ Dark: true, Light: false, 'Match system': false });
  expect(errors).toEqual([]);
});

test('choosing Light: app goes light, video stage stays dark, barcode still decodes', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitReady(page);
  await openFixture(page, FIXTURE);
  await page.keyboard.press('KeyD');
  await page.keyboard.press('KeyD');
  await page.keyboard.press('KeyD');
  await expectSettledAt(page, 3);

  await chooseTheme(page, 'Light');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => settingsTheme(page)).toBe('light');
  expect(await mirroredPref(page)).toBe('light');

  // App surfaces and text.
  expect(await cssLuminance(page, 'body', 'backgroundColor')).toBeGreaterThan(0.7);
  expect(await cssLuminance(page, 'body', 'color')).toBeLessThan(0.1);
  expect(await cssLuminance(page, '.wb-top', 'color')).toBeLessThan(0.1);
  // The video stage keeps the neutral dark surround.
  expect(await cssLuminance(page, '.wb-well', 'backgroundColor')).toBeLessThan(0.1);
  // And the picture is untouched: the barcode drawn on the player canvas is the displayed frame.
  await expectSettledAt(page, 3);
  const { displayed, barcode } = await page.evaluate(() => ({
    displayed: window.__pa?.player()?.getSnapshot().displayedFrame,
    barcode: window.__pa?.readBarcode(),
  }));
  expect(barcode).toBe(displayed);
  expect(await menuState(page)).toEqual({ Dark: false, Light: true, 'Match system': false });

  // The trigger icon reflects the theme (sun in light).
  await expect(appearanceButton(page)).toBeVisible();
  await page.screenshot({ path: 'tests/artifacts/theme/light-workbench.png' });
  expect(errors).toEqual([]);
});

test('timeline canvas repaints with theme colours, both ways, without reload', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);
  await openFixture(page, FIXTURE);
  await expectSettledAt(page, 0);
  // No segments: the right part of the lane is plain timeline background.
  const darkLum = await timelineLaneLuminance(page);
  expect(darkLum, 'dark timeline background').toBeLessThan(0.1);

  const navs: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navs.push(f.url());
  });

  await chooseTheme(page, 'Light');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => timelineLaneLuminance(page), { message: 'light timeline background' }).toBeGreaterThan(0.7);

  await chooseTheme(page, 'Dark');
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => timelineLaneLuminance(page), { message: 'dark timeline background again' }).toBeLessThan(0.1);
  expect(await cssLuminance(page, 'body', 'backgroundColor')).toBeLessThan(0.1);
  expect(navs, 'no reload').toEqual([]);
});

test('light theme persists across reload and is applied before the first paint', async ({ page }) => {
  await page.addInitScript(RECORD_EARLY_THEME);
  await page.goto('/');
  await waitReady(page);
  await chooseTheme(page, 'Light');
  await expect.poll(() => settingsTheme(page)).toBe('light');
  // Let the settings write reach IndexedDB before reloading.
  await page.waitForTimeout(300);

  await page.reload();
  const early = await themeRecord(page);
  expect(early.atBody, 'data-theme when <body> is created (before any paint)').toBe('light');
  expect(early.atDcl, 'data-theme at DOMContentLoaded').toBe('light');
  expect(early.rootChildrenAtDcl, 'React had not rendered yet at DOMContentLoaded').toBe(0);

  await waitReady(page);
  expect(await settingsTheme(page), 'settings loaded from IndexedDB').toBe('light');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  const rec = await themeRecord(page);
  const afterBody = rec.changes.filter((c) => c.body).map((c) => c.theme);
  expect(afterBody.filter((t) => t !== 'light'), 'never dark once the page could paint').toEqual([]);
  expect(await cssLuminance(page, 'body', 'backgroundColor')).toBeGreaterThan(0.7);
  expect(await menuState(page)).toEqual({ Dark: false, Light: true, 'Match system': false });
});

test('Match system follows prefers-color-scheme live and before the first paint', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(RECORD_EARLY_THEME);
  await page.goto('/');
  await waitReady(page);
  // Explicit Dark preference ignores the OS.
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');

  await chooseTheme(page, 'Match system');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => settingsTheme(page)).toBe('system');
  expect(await mirroredPref(page)).toBe('system');
  expect(await cssLuminance(page, 'body', 'backgroundColor')).toBeGreaterThan(0.7);

  // OS switches to dark: follows live, no reload.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  expect(await cssLuminance(page, 'body', 'backgroundColor')).toBeLessThan(0.1);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  expect(await menuState(page)).toEqual({ Dark: false, Light: false, 'Match system': true });

  // Reload with the OS on light: light before the first paint.
  await page.waitForTimeout(300);
  await page.reload();
  const early = await themeRecord(page);
  expect(early.atBody).toBe('light');
  expect(early.atDcl).toBe('light');
  await waitReady(page);
  expect(await settingsTheme(page)).toBe('system');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  const rec = await themeRecord(page);
  expect(rec.changes.filter((c) => c.body && c.theme !== 'light')).toEqual([]);

  // And with the OS on dark after a reload, it is dark from the start.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  expect((await themeRecord(page)).atBody).toBe('dark');
  await waitReady(page);
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
});

test('switching theme does not disturb the work; shortcuts still work after the menu', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitReady(page);
  await openFixture(page, FIXTURE);

  const chips = page.locator('[data-testid="recent-chips"] button');
  await chips.nth(0).click();
  await page.keyboard.press('KeyD');
  await expectSettledAt(page, 1);
  await page.keyboard.press('KeyQ');
  for (let i = 0; i < 9; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 10);
  await page.keyboard.press('KeyE'); // segment [1, 10), pending start 10
  await expect.poll(() => page.evaluate(() => window.__pa?.state().editor.doc.segments.length)).toBe(1);
  for (let i = 0; i < 4; i++) await page.keyboard.press('KeyD');
  await expectSettledAt(page, 14);

  const snapshot = () =>
    page.evaluate(() => {
      const s = window.__pa!.state();
      return {
        segments: s.editor.doc.segments.map((g) => ({ id: g.id, phaseId: g.phaseId, start: g.start, end: g.end })),
        pendingStart: s.editor.pendingStart,
        selectedPhaseId: s.selectedPhaseId,
        displayed: window.__pa!.player()?.getSnapshot().displayedFrame,
        barcode: window.__pa!.readBarcode(),
        relPath: s.video.relPath,
      };
    });
  const before = await snapshot();
  expect(before.segments.map((g) => [g.start, g.end])).toEqual([[1, 10]]);
  expect(before.pendingStart).toBe(10);
  expect(before.displayed).toBe(14);
  await expect(page.locator('[data-testid="pending-start"]')).toContainText('10');

  await chooseTheme(page, 'Light');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  await page.waitForTimeout(200);
  expect(await snapshot()).toEqual(before);
  await chooseTheme(page, 'Match system');
  await chooseTheme(page, 'Dark');
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await chooseTheme(page, 'Light');
  await page.waitForTimeout(200);
  expect(await snapshot()).toEqual(before);
  await expect(page.locator('[data-testid="pending-start"]')).toContainText('10');

  // Focus is back on the Appearance button; the step shortcut must still work.
  await page.keyboard.press('KeyD');
  await expectSettledAt(page, 15);
  await page.keyboard.press('KeyW'); // finish the pending segment at 15
  await expect
    .poll(() => page.evaluate(() => window.__pa?.state().editor.doc.segments.map((g) => [g.start, g.end])))
    .toEqual([
      [1, 10],
      [10, 15],
    ]);
  expect(errors).toEqual([]);
});

test('Appearance menu is translated in 繁中', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);
  expect(await menuState(page)).toEqual({ Dark: true, Light: false, 'Match system': false });

  await page.getByRole('radio', { name: '繁中' }).click();
  await expect(html(page)).toHaveAttribute('lang', /zh/);
  await expect(appearanceButton(page, '外觀')).toBeVisible();
  expect(await menuState(page, '外觀')).toEqual({ 深色: true, 淺色: false, 跟隨系統: false });

  await chooseTheme(page, '淺色', '外觀');
  await expect(html(page)).toHaveAttribute('data-theme', 'light');
  expect(await menuState(page, '外觀')).toEqual({ 深色: false, 淺色: true, 跟隨系統: false });

  await page.getByRole('radio', { name: 'EN' }).click();
  await expect(html(page)).toHaveAttribute('lang', 'en');
  expect(await menuState(page)).toEqual({ Dark: false, Light: true, 'Match system': false });
});

test('Appearance menu is keyboard operable: focus moves in, arrows move, Esc closes, focus returns', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);
  const trigger = appearanceButton(page);
  const menu = page.getByRole('menu', { name: 'Appearance' });

  await trigger.click();
  await expect(menu).toBeVisible();
  // Opening the menu puts focus on its first item, so the arrow keys and Esc reach it.
  await expect(menu.getByRole('menuitemradio', { name: 'Dark', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'Light', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger, 'Esc returns focus to the trigger').toBeFocused();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');

  // Choosing an item with the mouse also hands focus back to the trigger.
  await chooseTheme(page, 'Light');
  await expect(trigger).toBeFocused();
});
