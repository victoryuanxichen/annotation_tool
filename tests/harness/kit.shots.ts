import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.KIT_SHOTS_DIR ?? join(process.cwd(), 'tests/artifacts/kit-shots');
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { w: 1440, h: 900 },
  { w: 1280, h: 760 },
] as const;

async function open(page: Page, query: string): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`/tests/harness/kit.html?${query}`);
  await page.waitForSelector('.wb');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  expect(errors, errors.join('\n')).toEqual([]);
}

for (const { w, h } of SIZES) {
  for (const lang of ['en', 'zh-Hant'] as const) {
    test(`workbench ${w}x${h} ${lang}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page, `lang=${lang}`);
      await page.screenshot({ path: join(OUT, `wb-${w}x${h}-${lang}.png`) });
    });
  }
}

test('gallery full page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'lang=en');
  const gallery = page.locator('#gallery');
  await gallery.screenshot({ path: join(OUT, 'gallery-en.png') });
});

for (const dialog of ['help', 'conflict', 'switch'] as const) {
  test(`dialog ${dialog}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `lang=${dialog === 'help' ? 'zh-Hant' : 'en'}&dialog=${dialog}`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: join(OUT, `dialog-${dialog}.png`) });
  });
}

test('popover, toasts, invalid input, tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'lang=en&toasts=1');
  const jump = page.getByRole('textbox', { name: 'Go to frame' }).first();
  await jump.fill('12000');
  await jump.press('Enter');
  await expect(page.getByText('Enter a frame from 0 to 8999.')).toBeVisible();
  await page.screenshot({ path: join(OUT, 'invalid-input.png'), clip: { x: 0, y: 480, width: 800, height: 160 } });
  await page.getByRole('button', { name: 'More phases' }).first().click();
  await expect(page.getByRole('dialog', { name: 'More phases' })).toBeVisible();
  await page.screenshot({ path: join(OUT, 'overlays.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Previous frame' }).focus();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'tooltip-focus.png'), clip: { x: 0, y: 500, width: 900, height: 220 } });
});

test('menu open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'lang=en');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: join(OUT, 'menu.png'), clip: { x: 1000, y: 0, width: 440, height: 220 } });
});
