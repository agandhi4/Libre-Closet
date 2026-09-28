import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { garmentWear, wardrobeShare } from '../../src/db/schema';
import { createWishlistItem } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFullPage, expectNoScriptNavigation } from './pages';

/**
 * The year in review (#26, docs/plans/2026-09-28-yearly-recap.md) over a
 * closet whose wears are written here on known days, the clock pinned to
 * 2026-09-27 in New York: the year's boundaries (a wear on January 1 and on
 * December 31), a past year's figures stopping at its December 31, an
 * archived garment still that year's, a wishlist item and another user's
 * wears changing nothing, additions by acquired date (undated ones left
 * out), the threshold's empty state, `?year=` as navigation state, and the
 * access: the owner's, a grantee's under `?ownerId=` (no image), a
 * stranger's 404. The rules on made-up rows are src/wardrobe/recap.spec.ts;
 * the seed's Theo is insights-seed.spec.ts.
 */

const NOW = '2026-09-27T16:00:00Z';

const form = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return body.toString();
};

interface GarmentFields {
  name: string;
  category: string;
  color?: string[];
  price?: string;
  acquired?: string;
}

function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start, id).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

/** The `data-garment-id`s in section `id`, in order. */
function idsIn(html: string, id: string): number[] {
  return [...section(html, id).matchAll(/data-garment-id="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
}

describe('year in review', () => {
  let t: TestApp;
  let ownerId: number;
  let viewerCookie: string;
  let strangerCookie: string;
  const g: Record<string, number> = {};

  async function newGarment(fields: GarmentFields, cookie?: string) {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: form({
        name: fields.name,
        category: fields.category,
        color: fields.color ?? [],
        dateAquired: fields.acquired ?? '',
        product: '1',
        price: fields.price ?? '',
        sourceUrl: '',
      }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie && { cookie }),
      },
    });
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)\?/.exec(res.headers.location!)![1]);
  }

  async function wear(garmentId: number, days: string[], owner = ownerId) {
    await t.db
      .insert(garmentWear)
      .values(days.map((day) => ({ garmentId, ownerId: owner, day })));
  }

  const page = async (query = '', cookie?: string) => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/recap${query}`,
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode, res.body).toBe(200);
    return { res, html: unescapeHtml(res.body) };
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    t = await createTestApp();
    ownerId = t.owner.id;
    g.tee = await newGarment({
      name: 'White tee',
      category: 'tops',
      color: ['white'],
      price: '20',
      acquired: '2024-05-01',
    });
    g.jeans = await newGarment({
      name: 'Blue jeans',
      category: 'bottoms',
      color: ['blue'],
      price: '100',
      acquired: '2026-02-10',
    });
    g.coat = await newGarment({
      name: 'Black coat',
      category: 'outerwear',
      color: ['black'],
      price: '300',
      acquired: '2025-11-01',
    });
    g.sneakers = await newGarment({
      name: 'New sneakers',
      category: 'footwear',
      acquired: '2026-09-27',
    });
    g.undated = await newGarment({ name: 'Old shirt', category: 'tops' });
    g.wish = await createWishlistItem(t, { name: 'Wanted scarf' });

    // 2025: ten days of the tee, the last on New Year's Eve.
    await wear(g.tee, [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((month) => `2025-0${month}-15`),
      '2025-12-31',
    ]);
    // 2026 up to today: 8 + 6 + 3 + 1 = 18 wears, the tee and jeans
    // together on four days.
    await wear(g.tee, [
      '2026-01-01',
      '2026-02-11',
      '2026-03-03',
      '2026-04-14',
      '2026-05-20',
      '2026-06-30',
      '2026-08-08',
      '2026-09-27',
    ]);
    await wear(g.jeans, [
      '2026-02-11',
      '2026-03-03',
      '2026-04-14',
      '2026-05-20',
      '2026-07-01',
      '2026-09-01',
    ]);
    await wear(g.coat, ['2026-01-06', '2026-01-07', '2026-02-12']);
    await wear(g.undated, ['2026-03-10']);
    // Worn out and archived since: still 2026's.
    const archived = await t.inject({
      method: 'POST',
      url: `/wardrobe/${g.coat}/archive`,
    });
    expect(archived.statusCode).toBeLessThan(400);
    // Nothing a wishlist item "wore" counts.
    await wear(g.wish, ['2026-03-03', '2026-04-14']);

    strangerCookie = await t.register('stranger@example.com');
    const strangerId = await userIdOf(t, 'stranger@example.com');
    const theirs = await newGarment(
      { name: 'Their tee', category: 'tops' },
      strangerCookie,
    );
    await wear(theirs, ['2026-03-03', '2026-04-14'], strangerId);

    viewerCookie = await t.register('viewer@example.com');
    await t.db.insert(wardrobeShare).values({
      grantorId: ownerId,
      granteeId: await userIdOf(t, 'viewer@example.com'),
      permission: 'VIEW',
      inviteToken: randomUUID(),
      createdAt: new Date(),
      acceptedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await t?.cleanup();
  });

  it('is the current year so far by default, through the household’s today', async () => {
    const { res, html } = await page();
    expectFullPage(res);
    expectNoScriptNavigation(res);
    expect(html).toContain('data-year="2026"');
    expect(html).toContain('data-from="2026-01-01"');
    expect(html).toContain('data-to="2026-09-27"');
    expect(html).toContain('Your 2026 so far');
    expect(html).toContain('Jan 1 – Sep 27, 2026');
  });

  it('counts the year’s wears and pieces: January 1 in, the wishlist and other users out', async () => {
    const summary = section((await page()).html, 'recap-summary');
    expect(summary).toMatch(/data-stat="wears"[^]*?>18</);
    expect(summary).toMatch(/data-stat="pieces"[^]*?>4</);
    expect(summary).toMatch(/data-stat="additions"[^]*?>2</);
  });

  it('ranks the most worn by the year’s wears, the archived coat included', async () => {
    const { html } = await page();
    expect(idsIn(html, 'recap-most-worn')).toEqual([
      g.tee,
      g.jeans,
      g.coat,
      g.undated,
    ]);
    expect(section(html, 'recap-most-worn')).toContain('Worn 8 times');
  });

  it('lists the year’s additions by acquired date, newest first, not the undated', async () => {
    const { html } = await page();
    expect(idsIn(html, 'recap-additions')).toEqual([g.sneakers, g.jeans]);
    const additions = section(html, 'recap-additions');
    expect(additions).toContain('Added Sep 27 · Not worn yet');
    expect(additions).toContain('Added Feb 10 · Worn 6 times');
  });

  it('takes best value per wear from the year’s pieces, over every wear so far', async () => {
    const { html } = await page();
    // The tee: $20 over 18 wears (2025's ten and 2026's eight).
    expect(idsIn(html, 'recap-best-value')).toEqual([g.tee, g.jeans]);
    expect(section(html, 'recap-best-value')).toContain(
      '$1.11 a wear · $20.00 over 18 days',
    );
  });

  it('shares the year’s wears among colours, and names the pair worn together most', async () => {
    const { html } = await page();
    const colours = section(html, 'recap-colours');
    const shares = [
      ...colours.matchAll(/data-colour="(\w+)" data-share="(\d+)"/g),
    ].map((m) => [m[1], Number(m[2])]);
    expect(shares).toEqual([
      ['white', 44],
      ['blue', 33],
      ['black', 17],
    ]);
    expect(colours).toContain('data-uncoloured="" data-share="6"');
    const pair = section(html, 'recap-pair');
    expect(pair).toContain(`data-pair="${g.tee}-${g.jeans}"`);
    expect(pair).toContain('4 days together');
  });

  it('gives the owner the image: a ‹ link to last year, the card’s data, no › link', async () => {
    const { html } = await page();
    expect(html).toContain('href="/wardrobe/recap?year=2025"');
    expect(html).not.toContain('rel="next"');
    expect(html).toContain('id="recap-export"');
    expect(html).toContain(
      `import { prepareRecapExport } from 'recap-export';`,
    );
    const island =
      /<script type="application\/json" id="recap-card-data">([^<]*)<\/script>/.exec(
        html,
      );
    const card = JSON.parse(island![1]) as {
      fileName: string;
      title: string;
      stats: { value: string }[];
      mostWorn: { garments: { name: string; image: string | null }[] };
      pair: { detail: string } | null;
    };
    expect(card.fileName).toBe('closet-2026.png');
    expect(card.title).toBe('My 2026 so far');
    expect(card.stats.map((s) => s.value)).toEqual(['18', '4', '2']);
    expect(card.mostWorn.garments.map((m) => m.name)).toEqual([
      'White tee',
      'Blue jeans',
      'Black coat',
    ]);
    expect(card.pair!.detail).toBe('4 days together');
  });

  it('stops a past year at its December 31: later wears change nothing', async () => {
    const { html } = await page('?year=2025');
    expect(html).toContain('data-to="2025-12-31"');
    expect(html).toContain('Your 2025');
    expect(section(html, 'recap-summary')).toMatch(
      /data-stat="wears"[^]*?>10</,
    );
    // $20 over 2025's ten wears, not over all eighteen.
    expect(section(html, 'recap-best-value')).toContain(
      '$2.00 a wear · $20.00 over 10 days',
    );
    // Nothing was added in 2025 that is not the coat (acquired Nov 1).
    expect(idsIn(html, 'recap-additions')).toEqual([g.coat]);
    // › goes to the current year's bare address; no year before 2025 wore anything.
    expect(html).toContain(
      'href="/wardrobe/recap" class="btn btn-ghost btn-sm" rel="next"',
    );
    expect(html).not.toContain('rel="prev"');
  });

  it('shows a year below the threshold as its empty state, without the image', async () => {
    const { html } = await page('?year=2024');
    expect(html).toContain('id="recap-empty"');
    expect(html).toContain('Nothing was marked worn in 2024.');
    expect(html).toContain('id="recap-calendar"');
    expect(html).not.toContain('id="recap-export"');
    expect(html).not.toContain('id="recap-summary"');

    await wear(g.undated, ['2023-06-01', '2023-06-02']);
    const few = (await page('?year=2023')).html;
    expect(few).toContain(
      'Only 2 wears were marked in 2023. A recap needs 10.',
    );
  });

  it('reads ?year= as navigation state: anything else is the current year', async () => {
    for (const year of ['2031', 'abc', '99', 'x'.repeat(3000)]) {
      const { html } = await page(`?year=${year}`);
      expect(html, year).toContain('data-year="2026"');
    }
  });

  it('reads the owner row, then insights’ two statements', async () => {
    const record = await recordQueries(() => page());
    expect(record.statements).toBe(3);
  });

  it('shows a VIEW grantee the owner’s recap, links under the share, no image', async () => {
    const { html } = await page(`?ownerId=${ownerId}`, viewerCookie);
    expect(html).toContain('id="recap-shared"');
    expect(idsIn(html, 'recap-most-worn')).toEqual([
      g.tee,
      g.jeans,
      g.coat,
      g.undated,
    ]);
    expect(html).toContain(`href="/wardrobe/${g.tee}?ownerId=${ownerId}"`);
    expect(html).toContain(
      `href="/wardrobe/recap?year=2025&ownerId=${ownerId}"`,
    );
    expect(html).toContain(`href="/wardrobe?ownerId=${ownerId}"`);
    expect(html).not.toContain('id="recap-export"');
    expect(html).not.toContain('recap-card-data');
    // An empty year of the owner's: nothing to mark worn for them.
    const empty = (await page(`?year=2024&ownerId=${ownerId}`, viewerCookie))
      .html;
    expect(empty).toContain('id="recap-empty"');
    expect(empty).not.toContain('id="recap-calendar"');
    // Their own is their own: nothing worn.
    const own = (await page('', viewerCookie)).html;
    expect(own).toContain('id="recap-empty"');
    expect(own).not.toContain('White tee');
  });

  it('is a 404 to someone the wardrobe is not shared with, and a 400 for a malformed ownerId', async () => {
    const stranger = await t.inject({
      method: 'GET',
      url: `/wardrobe/recap?ownerId=${ownerId}`,
      headers: { cookie: strangerCookie },
    });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).not.toContain('White tee');
    const malformed = await t.inject({
      method: 'GET',
      url: '/wardrobe/recap?ownerId=abc',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('is linked from insights', async () => {
    const insights = await t.inject({
      method: 'GET',
      url: '/wardrobe/insights',
    });
    expect(insights.body).toContain('href="/wardrobe/recap"');
  });
});
