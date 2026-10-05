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
 * transition's rows are test/integration/plan-inline-review.spec.ts's. An
 * accepted item's sheet draws its options the same way, and Shop opens the
 * product's page in a new tab, as the garment page's View product does.
 */

/** Every candidate's product page, answered here: no request leaves the test. */
const SHOP = 'https://shop.example';

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

/** A draft with two proposals, the boots with three candidates. */
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
    brand: 'Blundstone',
    sourceUrl: `${SHOP}/cheap-boots`,
  });
  const navy = await createGarment(page, 'Navy boots', 'footwear', {
    ...wishlist,
    color: 'blue',
    price: '180',
    brand: 'Red Wing',
    sourceUrl: `${SHOP}/navy-boots`,
  });
  const brown = await createGarment(page, 'Brown boots', 'footwear', {
    ...wishlist,
    color: 'brown',
    price: '210',
    brand: 'Clarks',
    sourceUrl: `${SHOP}/brown-boots`,
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
  for (const garmentId of [cheap, navy, brown]) {
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
    await page
      .context()
      .route(`${SHOP}/**`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>The shop</h1>' }),
      );
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
    await expect(sheet.locator('[data-candidate]')).toHaveCount(3);
    await expect(sheet.locator('[data-shop]')).toHaveCount(3);
    // The sheet fades in; a shot before it settles shows the page behind.
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `test-results/315a-sheet-proposed-${width}.png`,
    });

    // Not this one on a candidate: it stays proposed, its sheet reopens.
    await sheet.locator('summary', { hasText: 'Not this one' }).first().click();
    await sheet.getByPlaceholder('Why not?').first().fill('Too dressy');
    await sheet.getByRole('button', { name: 'Not this one' }).first().click();
    await expect(page).toHaveURL(/show=proposed/);
    await expect(page.locator(`#plan-sheet-${boots}`)).toBeVisible();
    await expect(
      page.locator(`#plan-sheet-${boots} [data-candidate]`),
    ).toHaveCount(2);

    // Use this: the boots leave the proposals and the next sheet opens.
    await page
      .locator(`#plan-sheet-${boots}`)
      .getByRole('button', { name: 'Use this' })
      .first()
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

    // The accepted boots: the same tiles, Shop on each, no wishlist link.
    await page.goto(plan);
    await page.locator(`#plan-item-${boots} button[aria-haspopup]`).click();
    const accepted = page.locator(`#plan-sheet-${boots}`);
    await expect(accepted).toBeVisible();
    await expect(accepted.locator('[data-candidate]')).toHaveCount(2);
    await expect(
      accepted.locator('[data-candidate] a:not([data-shop])'),
    ).toHaveCount(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/315a-sheet-${width}.png` });
    const shop = accepted.locator('[data-shop]').first();
    const href = await shop.getAttribute('href');
    const [tab] = await Promise.all([page.waitForEvent('popup'), shop.click()]);
    await expect(tab).toHaveURL(href!);
    await tab.close();

    // A candidate's own page: View product opens the shop too.
    const kept = await accepted
      .locator('[data-candidate]')
      .first()
      .getAttribute('data-candidate');
    await page.goto(`/wardrobe/${kept}`);
    const view = page.getByRole('link', { name: 'View product' });
    await view.scrollIntoViewIfNeeded();
    const [product] = await Promise.all([
      page.waitForEvent('popup'),
      view.click(),
    ]);
    await expect(product).toHaveURL(/^https:\/\/shop\.example\//);
    await product.close();
    expect(errors).toEqual([]);
  });
}
