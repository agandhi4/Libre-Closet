import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openPhotoSheet } from './support/garment-page';

/**
 * Rotate ↺ / ↻ in the garment page's photo sheet at phone width (#199): a
 * tap posts once, the page comes back with the turned photo (a new file,
 * its cutout pending again), and the sheet's buttons fit the screen.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('rotates the garment photo from the photo sheet at 390 px', async ({
  page,
}) => {
  await signIn(page, 'rotate-test');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Sideways Tee', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  expect(created.ok()).toBe(true);
  const garmentId = new URL(created.url()).pathname.split('/').pop();
  const photo = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();
  const uploaded = await page.request.post(`/wardrobe/${garmentId}/photo`, {
    multipart: {
      photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo },
    },
    headers: SAME_ORIGIN,
  });
  expect(uploaded.ok()).toBe(true);

  await page.goto(`/wardrobe/${garmentId}`);
  const hero = page.locator('#garment-photo img');
  const before = await hero.getAttribute('src');

  const sheet = await openPhotoSheet(page);
  const right = sheet.getByRole('button', { name: 'Rotate right' });
  const left = sheet.getByRole('button', { name: 'Rotate left' });
  await expect(right).toBeVisible();
  await expect(left).toBeVisible();
  // Both fit beside each other on the phone's screen.
  for (const button of [left, right]) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }

  const rotations: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/wardrobe/${garmentId}/photo/rotate`)) {
      rotations.push(request.postData() ?? '');
    }
  });
  await right.tap();
  // The 303 lands on the same address: wait for the new photo instead.
  await expect(hero).not.toHaveAttribute('src', before!);
  expect(rotations).toEqual(['direction=right']);

  // A new photo, its cutout queued again; the sheet is closed.
  await expect(page.locator('#garment-photo-sheet')).toBeHidden();
  const after = await hero.getAttribute('src');
  const original = await page.request.get(
    after!.replace('/file/nobg/', '/file/'),
  );
  expect(await sharp(await original.body()).metadata()).toMatchObject({
    width: 720,
    height: 1080,
  });
});
