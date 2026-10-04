import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * The shared snap strip with a mouse (#311): previous/next buttons and the
 * arrow keys move the choice through the same observer a swipe does, and on
 * a phone the buttons are not there. Screenshots land in test-results/.
 */

async function wardrobe(page: Page, user: string) {
  await signIn(page, user);
  const oldTee = await createGarment(page, 'Old tee', 'tops');
  const newTee = await createGarment(page, 'New tee', 'tops');
  await page.goto('/styling');
  return { oldTee, newTee };
}

test.describe('with a mouse', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('buttons and arrow keys move a strip and its value', async ({
    page,
  }) => {
    const errors = pageErrors(page, { console: true });
    const g = await wardrobe(page, 'strip-pointer');
    const tops = page.locator('[data-styling-row="top"]').first();
    const value = tops.locator('input[name="garmentId"]');
    const previous = tops.getByRole('button', { name: 'Previous item' });
    const next = tops.getByRole('button', { name: 'Next item' });
    await expect(value).toHaveValue(String(g.newTee));

    // Newest first: the next item is the older tee, then back.
    await next.click();
    await expect(value).toHaveValue(String(g.oldTee));
    await previous.click();
    await expect(value).toHaveValue(String(g.newTee));

    // Arrow keys with focus in the strip (an item).
    await tops.locator('.styling-strip [data-snap-item]').nth(1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(value).toHaveValue(String(g.oldTee));
    await page.keyboard.press('ArrowLeft');
    await expect(value).toHaveValue(String(g.newTee));

    // The first item is whole at 1440 px: nothing clips it.
    const strip = tops.locator('.styling-strip');
    await strip.evaluate((el) => el.scrollTo({ left: 0, behavior: 'instant' }));
    const first = (await tops
      .locator('[data-snap-item]')
      .first()
      .boundingBox())!;
    const frame = (await strip.boundingBox())!;
    expect(first.x).toBeGreaterThanOrEqual(frame.x);

    await page.screenshot({ path: 'test-results/311-styling-1440.png' });
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('the step buttons are not shown', async ({ page }) => {
    await wardrobe(page, 'strip-touch');
    const tops = page.locator('[data-styling-row="top"]').first();
    await expect(tops.getByRole('button', { name: 'Next item' })).toBeHidden();
    await page.screenshot({ path: 'test-results/311-styling-390.png' });
  });
});
