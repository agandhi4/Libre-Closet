import { expect, type Page, test } from '@playwright/test';
import { addDays } from '../src/web/calendar/calendar-date';
import { createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { openGarmentMenu } from './support/garment-page';
import { householdToday } from './support/household-today';

/**
 * The app bar's back arrow goes back like a native app's (#105,
 * public/js/back.js): to the page the user came from, as history holds it,
 * when that page is in the app; to its fixed href only on a cold entry. A
 * trip back through history leaves the page after it forward in history
 * and adds no entry; the fallback adds one. At phone width, in the
 * installed-app config when the server runs with PWA_ENABLED (CI's).
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const backArrow = (page: Page) =>
  page.locator('header.app-bar a[data-history-back]');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

const historyLength = (page: Page) => page.evaluate(() => history.length);

/**
 * Taps the back arrow and waits for `to`; answers whether it went back in
 * history (no new entry) or forward to the arrow's href (one more).
 */
async function tapBack(page: Page, to: RegExp): Promise<{ wentBack: boolean }> {
  const before = await historyLength(page);
  await backArrow(page).click();
  await expect(page).toHaveURL(to);
  return { wentBack: (await historyLength(page)) === before };
}

test('wardrobe, a garment, back: the wardrobe, back in history', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-wardrobe');
  const id = await createGarment(page, 'Back tee');
  await page.goto('/wardrobe');

  await page.locator(`a[href="/wardrobe/${id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));
  await expect(page.locator('h1')).toHaveText('Back tee');

  expect(await tapBack(page, /\/wardrobe$/)).toEqual({ wentBack: true });
  await expect(page.locator('h1')).toHaveText('Wardrobe');
  // The garment is forward, as after the browser's own back.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Styling, a garment, back: Styling with its rows as they were', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-styling');
  const oldTee = await createGarment(page, 'Old tee', 'tops');
  const newTee = await createGarment(page, 'New tee', 'tops');
  await createGarment(page, 'Jeans', 'bottoms');
  await page.goto('/styling');

  // Fresh, the row holds the newest tee; the person moves it to the old one.
  const tops = page.locator('[data-styling-row="top"]').first();
  const chosen = tops.locator('input[name="garmentId"]');
  await expect(chosen).toHaveValue(String(newTee));
  await tops.locator(`[data-garment-id="${oldTee}"]`).click();
  await expect(chosen).toHaveValue(String(oldTee));

  // A tap on the chosen garment opens its page.
  await tops.locator(`[data-garment-id="${oldTee}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${oldTee}$`));
  await expect(page.locator('h1')).toHaveText('Old tee');

  expect(await tapBack(page, /\/styling$/)).toEqual({ wentBack: true });
  await expect(page.locator('h1')).toHaveText('Styling');
  await expect(
    page
      .locator('[data-styling-row="top"]')
      .first()
      .locator('input[name="garmentId"]'),
  ).toHaveValue(String(oldTee));
  expect(errors, errors.join('\n')).toEqual([]);
});

test("the calendar's week, an outfit, back: that week", async ({ page }) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-calendar');
  const garment = await createGarment(page, 'Week top');
  const day = addDays(householdToday(), 14);
  await createOutfit(page, 'Fortnight look', garment, day);
  await page.goto(`/calendar?week=${day}`);

  await page.getByRole('link', { name: 'Fortnight look', exact: true }).click();
  await expect(page).toHaveURL(/\/styling\?outfit=\d+/);

  expect(await tapBack(page, new RegExp(`/calendar\\?week=${day}`))).toEqual({
    wentBack: true,
  });
  await expect(page.locator(`section[data-day="${day}"]`)).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a deep link to a garment, back: the wardrobe, its fixed parent', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-deep-link');
  const id = await createGarment(page, 'Shared tee');
  // A new tab on the garment: nothing of the app's before it.
  const tab = await page.context().newPage();
  await tab.goto(`/wardrobe/${id}`);
  await expect(tab.locator('h1')).toHaveText('Shared tee');

  expect(await tapBack(tab, /\/wardrobe$/)).toEqual({ wentBack: false });
  await expect(tab.locator('h1')).toHaveText('Wardrobe');
  await tab.close();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Styling, a garment, Edit, Save, back: Styling, never the form', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-after-save');
  const tee = await createGarment(page, 'Edited tee', 'tops');
  await page.goto('/styling');

  const tops = page.locator('[data-styling-row="top"]').first();
  await tops.locator(`[data-garment-id="${tee}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}$`));

  const menu = await openGarmentMenu(page);
  await menu.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}/edit`));
  await page.getByRole('textbox', { name: 'Name' }).fill('Renamed tee');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}$`));
  await expect(page.locator('h1')).toHaveText('Renamed tee');

  // Back past the form and the garment as it was before the edit.
  await backArrow(page).click();
  await expect(page).toHaveURL(/\/styling$/);
  await expect(page.locator('h1')).toHaveText('Styling');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('wardrobe, a garment, Edit, Save, back: the wardrobe shows the save', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-save-fresh');
  const tee = await createGarment(page, 'Before tee', 'tops');
  await page.goto('/wardrobe');
  const tile = page.locator(`main a[href="/wardrobe/${tee}"]`).first();
  await expect(tile).toContainText('Before tee');
  await tile.click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}$`));

  const menu = await openGarmentMenu(page);
  await menu.getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('After tee');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('After tee');

  // Back lands on the wardrobe as it is now, not htmx's snapshot from
  // before the save.
  await backArrow(page).click();
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(tile).toContainText('After tee');
  await expect(page.locator('main').getByText('Before tee')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a reload (pull to refresh) keeps the way back', async ({ page }) => {
  const errors = collectErrors(page);
  await signIn(page, 'back-reload');
  const id = await createGarment(page, 'Reloaded tee');
  await page.goto('/wardrobe');
  await page.locator(`a[href="/wardrobe/${id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));

  // location.reload(), as pull to refresh does: Playwright's own reload in
  // Firefox makes a new history entry, which no person's reload does.
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => location.reload()),
  ]);
  await expect(page.locator('h1')).toHaveText('Reloaded tee');
  expect(await tapBack(page, /\/wardrobe$/)).toEqual({ wentBack: true });
  expect(errors, errors.join('\n')).toEqual([]);
});
