import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import { outfitCalendar } from '../../src/db/schema';
import { dayColumns } from './calendar-page';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * A planned outfit warns about a piece it cannot be worn with (#358;
 * docs/plans/2026-10-09-structural-refactors.md, Approach 2): a lent or
 * archived piece wears its GarmentMark on Today, the calendar and the
 * outfit page, so the owner taps Change before getting dressed. Nothing is
 * swapped. The wash only on today's cards; nothing on a past entry; away
 * never to a grantee.
 */
describe('planned outfits: unavailable pieces', () => {
  let t: TestApp;
  let jacket: number;
  let lentOutfit: number;
  let archivedOutfit: number;

  const form = (fields: Record<string, string>) => ({
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  const page = async (url: string, cookie?: string) => {
    const res = await t.inject({
      method: 'GET',
      url,
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const marksIn = (html: string) =>
    [...html.matchAll(/data-mark="([^"]+)"/g)].map((m) => m[1]).sort();

  const createOutfit = async (name: string, garments: [string, number][]) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: new URLSearchParams([
        ['name', name],
        ...garments.flatMap(([category, id]) => [
          ['category', category],
          ['garmentId', String(id)],
        ]),
      ]).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  const plan = async (outfitId: number, occasion: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(outfitId), date: t.today(), occasion }),
    });
    expect(res.statusCode).toBe(302);
  };

  beforeAll(async () => {
    t = await createTestApp();
    jacket = await createGarment(t, {
      name: 'Lent jacket',
      category: 'outerwear',
    });
    const shirt = await createGarment(t, { name: 'Shirt', category: 'tops' });
    const jeans = await createGarment(t, {
      name: 'Jeans',
      category: 'bottoms',
    });
    const tee = await createGarment(t, { name: 'Old tee', category: 'tops' });
    const chinos = await createGarment(t, {
      name: 'Chinos',
      category: 'bottoms',
    });
    lentOutfit = await createOutfit('Lent look', [
      ['outerwear', jacket],
      ['tops', shirt],
      ['bottoms', jeans],
    ]);
    archivedOutfit = await createOutfit('Archived look', [
      ['tops', tee],
      ['bottoms', chinos],
    ]);
    await plan(lentOutfit, 'work');
    await plan(archivedOutfit, 'evening');
    // Yesterday's plan of the same outfit: a past entry is a record.
    await t.db.insert(outfitCalendar).values({
      day: addDays(t.today(), -1),
      outfitId: lentOutfit,
      ownerId: t.owner.id,
      occasion: 'work',
    });
    const lent = await t.inject({
      method: 'POST',
      url: `/wardrobe/${jacket}/away`,
      ...form({ away: 'lent', awayNote: '' }),
    });
    expect(lent.statusCode).toBe(303);
    const archived = await t.inject({
      method: 'POST',
      url: `/wardrobe/${tee}/archive`,
      headers: { 'hx-request': 'true' },
    });
    expect(archived.statusCode).toBe(200);
    // Worn today on its own: a top's one wear before a wash (limit 1).
    const worn = await t.inject({
      method: 'POST',
      url: `/wardrobe/${shirt}/wear`,
      ...form({ worn: '1' }),
    });
    expect(worn.statusCode).toBe(303);
  });

  afterAll(() => t?.cleanup());

  it("marks Today's planned cards: lent, archived and the wash", async () => {
    const html = await page('/');
    expect(marksIn(html)).toEqual(['archived', 'away:lent', 'needs-wash']);
    expect(html).toContain('>Lent</span>');
  });

  it("marks the week's rows from today on, never a past day's", async () => {
    const today = dayColumns(await page('/calendar')).get(t.today())!;
    expect(marksIn(today)).toEqual(['archived', 'away:lent', 'needs-wash']);
    const yesterday = addDays(t.today(), -1);
    const past = dayColumns(await page(`/calendar?week=${yesterday}`)).get(
      yesterday,
    )!;
    expect(past).toContain('data-occasion="work"');
    expect(marksIn(past)).toEqual([]);
  });

  it("marks the month's cell with a blocking mark, never the wash", async () => {
    const html = await page('/calendar/month');
    const cell = new RegExp(`data-month-day="${t.today()}"[\\s\\S]*?</a>`).exec(
      html,
    )![0];
    // The cell draws its day's first entry (work before evening).
    expect(marksIn(cell)).toEqual(['away:lent']);
  });

  it('marks the outfit page, without the wash', async () => {
    expect(marksIn(await page(`/outfits/${lentOutfit}`))).toEqual([
      'away:lent',
    ]);
    expect(marksIn(await page(`/outfits/${archivedOutfit}`))).toEqual([
      'archived',
    ]);
  });

  it('never shows a grantee the away mark', async () => {
    const cookie = await t.register('marks-viewer@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'MANAGE' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      headers: { cookie },
    });
    // The lent jacket itself, shared: no away mark, and none of the
    // owner's outfits that hold it.
    const garmentPage = await page(
      `/wardrobe/${jacket}?ownerId=${t.owner.id}`,
      cookie,
    );
    expect(garmentPage).toContain('Lent jacket');
    expect(garmentPage).not.toContain('data-garment-outfit=');
    expect(garmentPage).not.toContain('data-mark="away:');
    // The owner's outfits and calendar are never the grantee's.
    const outfit = await t.inject({
      method: 'GET',
      url: `/outfits/${lentOutfit}`,
      headers: { cookie },
    });
    expect(outfit.statusCode).toBe(404);
    expect(marksIn(await page('/', cookie))).toEqual([]);
    expect(marksIn(await page('/calendar', cookie))).toEqual([]);
  });
});
