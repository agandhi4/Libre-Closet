import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { planItem } from '../src/db/schema';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { withServerDb } from './support/server-db';

/**
 * The inline review in a browser (#315, part A): a proposal's sheet in the
 * proposals-only view, at phone and desktop width. Each decision posts as it
 * is made and lands on the next proposal's open sheet; the rules and every
 * transition's rows are test/integration/plan-inline-review.spec.ts's.
 */

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

/** A draft with two proposals, the boots with two candidates. */
async function draftWithProposals(page: Page, user: string) {
  await signIn(page, user);
  const plan = await post(page, '/wardrobe/plans', { name: 'Muse’s draft' });
  const items: Record<string, string>[] = [
    { name: 'Black boots', category: 'footwear', colors: 'black' },
    { name: 'Camel coat', category: 'outerwear' },
  ];
  for (const item of items) {
    await post(page, `${plan}/items`, {
      quantity: '1',
      priority: 'medium',
      ...item,
    });
  }
  const wishlist = { to: 'wishlist', wishlist: '1', props: '1', product: '1' };
  const cheap = await createGarment(page, 'Cheap black boots', 'footwear', {
    ...wishlist,
    color: 'black',
    price: '150',
  });
  const navy = await createGarment(page, 'Navy boots', 'footwear', {
    ...wishlist,
    color: 'blue',
    price: '180',
  });
  const planId = Number(plan.split('/').pop());
  const ids = await withServerDb(async (db) => {
    const rows = await db
      .update(planItem)
      .set({ review: 'proposed' })
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id, name: planItem.name });
    const id = (name: string) => rows.find((row) => row.name === name)!.id;
    return { boots: id('Black boots'), coat: id('Camel coat') };
  });
  for (const garmentId of [cheap, navy]) {
    await post(page, `${plan}/items/${ids.boots}/candidates`, {
      garmentIds: String(garmentId),
    });
  }
  return { plan, ...ids };
}

for (const width of [390, 1440]) {
  test(`decide proposals in their sheets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const errors = pageErrors(page);
    const { plan, boots, coat } = await draftWithProposals(
      page,
      `plan-inline-${width}`,
    );

    await page.goto(`${plan}?show=proposed`);
    await expect(page.locator('li[data-status="proposed"]')).toHaveCount(2);
    // Top to toe: the coat before the boots.
    await page.locator(`#plan-item-${boots} button[aria-haspopup]`).click();
    const sheet = page.locator(`#plan-sheet-${boots}`);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-candidate]')).toHaveCount(2);
    // The sheet fades in; a shot before it settles shows the page behind.
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/315a-sheet-${width}.png` });

    // Not this one on a candidate: it stays proposed, its sheet reopens.
    await sheet.locator('summary', { hasText: 'Not this one' }).first().click();
    await sheet.getByPlaceholder('Why not?').first().fill('Too dressy');
    await sheet.getByRole('button', { name: 'Not this one' }).first().click();
    await expect(page).toHaveURL(/show=proposed/);
    await expect(page.locator(`#plan-sheet-${boots}`)).toBeVisible();
    await expect(
      page.locator(`#plan-sheet-${boots} [data-candidate]`),
    ).toHaveCount(1);

    // Use this: the boots leave the proposals and the next sheet opens.
    await page
      .locator(`#plan-sheet-${boots}`)
      .getByRole('button', { name: 'Use this' })
      .click();
    await expect(page.locator(`#plan-item-${boots}`)).toHaveCount(0);
    await expect(page.locator(`#plan-sheet-${coat}`)).toBeVisible();

    // The last one: Keep, and nothing is left to review.
    await page
      .locator(`#plan-sheet-${coat}`)
      .getByRole('button', { name: 'Keep' })
      .click();
    await expect(
      page.getByText('Nothing left to review.').first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
