import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, outfit, personalAccessToken } from '../../src/db/schema';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { createAccessToken } from './mcp';

/**
 * Muse's outfits on the Outfits tab (#335, docs/plans/2026-10-05-muse-
 * suggestions.md section 4 B): ordinary outfits the agent proposed
 * (outfit.proposed_at). From Muse is its own section, the owner's grid
 * and pickers keep to their own (ownersOutfit); each card leads with one
 * primary by where the outfit stands; Love (Save once complete), Not for
 * me with a reason and Undo go through the one writer (reactToOutfit);
 * Bought it makes a loved outfit the owner's; a proposal is never deleted.
 * The migration that made plan looks these outfits is
 * muse-outfits-migration.spec.ts's.
 */
describe('Muse’s outfits (#335)', () => {
  let t: TestApp;
  let tokenId: number;
  let tee: number;
  let jeans: number;
  let shoes: number;
  let blazer: number;
  let knit: number;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  /** An outfit of these garments, proposed by Muse with `reaction`. */
  const proposed = async (
    name: string,
    garments: number[],
    reaction: 'proposed' | 'loved' | 'revise' | 'declined' = 'proposed',
    at = new Date(),
  ) => {
    const res = await post('/outfits', {
      name,
      notes: '',
      category: garments.map(() => 'tops'),
      garmentId: garments.map(String),
    });
    expect(res.statusCode, res.body).toBe(302);
    const id = Number(
      /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
    );
    await t.db
      .update(outfit)
      .set({
        proposedAt: at,
        proposedByTokenId: tokenId,
        proposalNote: `Why ${name}`,
        reaction,
        ownerNote: reaction === 'revise' ? 'Warmer, please' : null,
        dismissedReason: reaction === 'declined' ? 'colour' : null,
      })
      .where(eq(outfit.id, id));
    return id;
  };

  const rowOf = async (id: number) =>
    (await t.db.select().from(outfit).where(eq(outfit.id, id)))[0];

  /** One card's markup on the tab. */
  const cardOf = (html: string, id: number) => {
    const start = html.indexOf(`data-muse-outfit="${id}"`);
    if (start === -1) return undefined;
    return html.slice(
      start,
      html.indexOf('</li>', html.indexOf('data-piece', start) + 1) + 2000,
    );
  };

  const primaryOf = (html: string, id: number) =>
    /data-muse-primary="([a-z]+)"/.exec(cardOf(html, id) ?? '')?.[1];

  const tab = async () => unescapeHtml((await get('/outfits')).body);

  beforeAll(async () => {
    t = await createTestApp();
    await createAccessToken(t, { name: 'Muse' });
    const [token] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, t.owner.id));
    tokenId = token.id;
    tee = await createGarment(t, { name: 'White tee', category: 'tops' });
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    shoes = await createGarment(t, {
      name: 'Canvas shoes',
      category: 'footwear',
    });
    blazer = await createWishlistItem(t, {
      name: 'Wool blazer',
      category: 'outerwear',
      price: '280',
    });
    knit = await createWishlistItem(t, { name: 'Grey knit', category: 'tops' });
  });

  afterAll(() => t?.cleanup());

  describe('the tab', () => {
    it('shows Muse’s outfits first, as cards, newest first; the grid and the pickers keep to the owner’s', async () => {
      const own = await post('/outfits', {
        name: 'My own',
        notes: '',
        category: ['tops', 'bottoms'],
        garmentId: [tee, jeans].map(String),
      });
      const ownId = Number(
        /^\/outfits\/(\d+)$/.exec(String(own.headers.location))![1],
      );
      const older = await proposed(
        'Older look',
        [blazer, tee],
        'proposed',
        new Date(Date.now() - 60_000),
      );
      const newer = await proposed('Newer look', [knit, jeans]);
      const html = await tab();
      expect(html).toContain('From Muse');
      expect(html.indexOf(`data-muse-outfit="${newer}"`)).toBeLessThan(
        html.indexOf(`data-muse-outfit="${older}"`),
      );
      expect(html).toContain('Your outfits');
      // The grid's tiles: the owner's only.
      const grid = html.slice(html.indexOf('id="saved-outfits"'));
      expect(grid).toContain(`data-outfit-id="${ownId}"`);
      expect(grid).not.toContain(`data-outfit-id="${newer}"`);
      // Picking for a day: no section, and only the owner's outfits.
      const picking = unescapeHtml(
        (await get(`/outfits?for=day:${t.today()}&occasion=all-day`)).body,
      );
      expect(picking).not.toContain('data-muse-outfits');
      expect(picking).not.toContain(`value="${newer}"`);
      const plan = unescapeHtml(
        (await get(`/calendar/plan?for=day:${t.today()}&occasion=all-day`))
          .body,
      );
      expect(plan).toContain(`value="${ownId}"`);
      expect(plan).not.toContain(`value="${newer}"`);
      // The garment page's outfits: the owner's only.
      const jeansPage = unescapeHtml((await get(`/wardrobe/${jeans}`)).body);
      expect(jeansPage).not.toContain('Newer look');
    });

    it('each card leads with one primary, by where the outfit stands', async () => {
      const complete = await proposed('Complete one', [tee, shoes]);
      const loved = await proposed(
        'Loved, to buy',
        [blazer, jeans, shoes],
        'loved',
      );
      const revise = await proposed('Sent back', [knit, shoes], 'revise');
      const cardigan = await createWishlistItem(t, {
        name: 'Navy cardigan',
        category: 'outerwear',
      });
      const replace = await proposed('With a piece set aside', [
        cardigan,
        jeans,
      ]);
      await t.db
        .update(garment)
        .set({ dismissedAt: new Date(), dismissedReason: 'colour' })
        .where(eq(garment.id, cardigan));
      const html = await tab();
      expect(primaryOf(html, complete)).toBe('save');
      expect(primaryOf(html, loved)).toBe('choose');
      expect(primaryOf(html, revise)).toBe('love');
      expect(cardOf(html, revise)).toContain('You asked: Warmer, please');
      expect(primaryOf(html, replace)).toBe('replace');
      expect(cardOf(html, replace)).toContain(
        'Needs a replacement: Navy cardigan was set aside',
      );
      // A piece to buy wears its price, and says what it unlocks.
      const card = cardOf(html, loved)!;
      expect(card).toContain('$280');
      expect(card).toMatch(
        /data-unlocks-link=""[^>]*>[^<]*(Unlocks|Goes with|outfit)/i,
      );
    });

    it('costs one statement after the session, sections and unlocks included', async () => {
      const recorded = await recordQueries(() => get('/outfits'));
      expect(recorded.statements).toBe(2);
    });

    it('keeps bare /outfits byte-stable', async () => {
      expect((await get('/outfits')).body).toBe((await get('/outfits')).body);
    });
  });

  describe('reactions (reactToOutfit)', () => {
    it('Love keeps an incomplete outfit in Muse’s section, loved; Bought it makes it the owner’s', async () => {
      const coat = await createWishlistItem(t, {
        name: 'Rain coat',
        category: 'outerwear',
      });
      const id = await proposed('Rainy day', [coat, tee]);
      const res = await post(`/outfits/${id}/love`, { returnTo: '/outfits' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/outfits?decided=love');
      const row = await rowOf(id);
      expect(row.reaction).toBe('loved');
      expect(row.reactedAt).toBeInstanceOf(Date);
      expect(primaryOf(await tab(), id)).toBe('choose');
      const bought = await post(`/wardrobe/${coat}/bought`, {
        acquiredOn: t.today(),
        price: '150',
      });
      expect(bought.statusCode).toBe(303);
      const html = await tab();
      expect(cardOf(html, id)).toBeUndefined();
      expect(html.slice(html.indexOf('id="saved-outfits"'))).toContain(
        `data-outfit-id="${id}"`,
      );
    });

    it('Save on a complete outfit makes it the owner’s at once', async () => {
      const id = await proposed('Plain day', [jeans, shoes]);
      const res = await post(`/outfits/${id}/love`, {});
      expect(res.headers.location).toBe('/outfits?decided=save');
      const html = await tab();
      expect(cardOf(html, id)).toBeUndefined();
      expect(html).toContain(`data-outfit-id="${id}"`);
    });

    it('Not for me takes a reason (400 without), keeps the outfit set aside, and Undo brings it back', async () => {
      const id = await proposed('Too loud', [knit, tee]);
      expect(
        (await post(`/outfits/${id}/dismiss`, { note: 'no' })).statusCode,
      ).toBe(400);
      const res = await post(`/outfits/${id}/dismiss`, {
        reason: 'style',
        note: ' Not me ',
      });
      expect(res.headers.location).toBe('/outfits?decided=dismiss');
      expect(await rowOf(id)).toMatchObject({
        reaction: 'declined',
        dismissedReason: 'style',
        ownerNote: 'Not me',
      });
      const html = await tab();
      expect(cardOf(html, id)).toBeUndefined();
      expect(html).toMatch(
        new RegExp(
          `data-muse-set-aside-outfit="${id}"[\\s\\S]*?Too loud[\\s\\S]*?The style`,
        ),
      );
      const undo = await post(`/outfits/${id}/undo`, {});
      expect(undo.headers.location).toBe('/outfits?decided=undo');
      expect(await rowOf(id)).toMatchObject({
        reaction: 'proposed',
        dismissedReason: null,
        ownerNote: null,
      });
    });

    it('refuses a move its reaction does not take (409), and a non-proposal or another’s (404)', async () => {
      const id = await proposed('Loved already', [tee, jeans, blazer], 'loved');
      expect((await post(`/outfits/${id}/love`, {})).statusCode).toBe(409);
      expect((await post(`/outfits/${id}/undo`, {})).statusCode).toBe(409);
      const own = await post('/outfits', {
        name: 'Not a proposal',
        notes: '',
        category: ['tops'],
        garmentId: [String(shoes)],
      });
      const ownId = Number(
        /^\/outfits\/(\d+)$/.exec(String(own.headers.location))![1],
      );
      expect((await post(`/outfits/${ownId}/love`, {})).statusCode).toBe(404);
      const stranger = await t.register('stranger-muse@example.com');
      const theirs = await t.inject({
        method: 'POST',
        url: `/outfits/${id}/dismiss`,
        payload: { reason: 'style' },
        headers: { cookie: stranger },
      });
      expect(theirs.statusCode).toBe(404);
      expect((await rowOf(id)).reaction).toBe('loved');
    });

    it('goes back to a safe page only', async () => {
      const id = await proposed('Redirected', [knit, tee, shoes]);
      const res = await post(`/outfits/${id}/love`, {
        returnTo: 'https://evil.example/',
      });
      expect(res.headers.location).toBe('/outfits?decided=love');
    });
  });

  describe('the outfit page and delete', () => {
    it('says it is Muse’s, offers the card’s moves, and hides Delete until loved', async () => {
      const id = await proposed('Office blazer', [blazer, shoes]);
      const page = unescapeHtml((await get(`/outfits/${id}`)).body);
      expect(page).toContain('From Muse');
      expect(page).toContain('Why Office blazer');
      expect(page).toContain(`action="/outfits/${id}/love"`);
      expect(page).toContain(`action="/outfits/${id}/dismiss"`);
      expect(page).not.toContain(`hx-delete="/outfits/${id}"`);
      const refused = await t.inject({
        method: 'DELETE',
        url: `/outfits/${id}`,
      });
      expect(refused.statusCode).toBe(409);
      expect(await rowOf(id)).toBeDefined();
      await post(`/outfits/${id}/love`, {});
      const loved = unescapeHtml((await get(`/outfits/${id}`)).body);
      expect(loved).toContain(`hx-delete="/outfits/${id}"`);
    });
  });
});
