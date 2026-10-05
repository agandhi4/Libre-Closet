import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  optionGroup,
  outfitSlot,
  personalAccessToken,
} from '../../src/db/schema';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { createGarment, createWishlistItem, garmentRow } from './garments';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * Muse's suggestions, phase 1A (#333): the provenance writer's wishlist
 * rule, every decision's rows through the one writer (decide), "Bought it"
 * settling a suggestion's group, and the wishlist's exclusion rule held
 * for suggestions in every state: no closet read shows one, and no list of
 * things to buy shows one set aside. Dismissal never deletes.
 */

describe('suggestions', () => {
  let t: TestApp;
  let ownerId: number;
  let tokenId: number;
  let mcpToken: string;
  let jeans: number;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    t.inject({ method: 'POST', url, payload });

  async function group(name: string): Promise<number> {
    const [row] = await t.db
      .insert(optionGroup)
      .values({ ownerId, name, suggestedByTokenId: tokenId })
      .returning({ id: optionGroup.id });
    return row.id;
  }

  /** A wishlist garment marked as Muse's pick of `groupId`, ranked `rank`. */
  async function pick(
    name: string,
    groupId: number | null,
    rank: number | null = null,
  ): Promise<number> {
    const id = await createWishlistItem(t, {
      name,
      category: 'tops',
      price: '120',
      sourceUrl: `https://shop.example/${encodeURIComponent(name)}`,
    });
    expect(
      await markSuggestion(t.db, ownerId, id, {
        tokenId,
        groupId,
        note: `Why ${name}`,
        rank,
      }),
    ).toBe('marked');
    return id;
  }

  const groupRow = async (id: number) =>
    (await t.db.select().from(optionGroup).where(eq(optionGroup.id, id)))[0];

  const dismissal = async (id: number) => {
    const row = await garmentRow(t, id);
    return {
      status: row?.status,
      reason: row?.dismissedReason ?? null,
      note: row?.dismissedNote ?? null,
      at: row?.dismissedAt ?? null,
    };
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = t.owner.id;
    mcpToken = await createAccessToken(t, { name: 'Muse' });
    const [token] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, ownerId));
    tokenId = token.id;
    jeans = await createGarment(t, { name: 'Raw jeans', category: 'bottoms' });
    await createGarment(t, { name: 'White tee', category: 'tops' });
  });

  afterAll(() => t?.cleanup());

  describe('provenance (markSuggestion)', () => {
    it('is written only on the owner’s wishlist garment, once, into their own group', async () => {
      const tee = await createGarment(t, {
        name: 'Grey tee',
        category: 'tops',
      });
      const own = await group('A grey tee');
      const provenance = { tokenId, groupId: own, note: 'n', rank: 1 };
      expect(await markSuggestion(t.db, ownerId, tee, provenance)).toBe(
        'refused',
      );
      const wish = await createWishlistItem(t, {
        name: 'Ecru tee',
        category: 'tops',
      });
      await t.register('other-suggestions@example.com');
      const otherId = await userIdOf(t, 'other-suggestions@example.com');
      const [theirs] = await t.db
        .insert(optionGroup)
        .values({ ownerId: otherId, name: 'Theirs' })
        .returning({ id: optionGroup.id });
      expect(
        await markSuggestion(t.db, ownerId, wish, {
          ...provenance,
          groupId: theirs.id,
        }),
      ).toBe('refused');
      expect(await markSuggestion(t.db, ownerId, wish, provenance)).toBe(
        'marked',
      );
      expect(await markSuggestion(t.db, ownerId, wish, provenance)).toBe(
        'refused',
      );
      expect(await garmentRow(t, tee)).toMatchObject({
        suggestedAt: null,
        suggestionGroupId: null,
      });
      // The database's backstop: no provenance without suggested_at.
      await expect(
        t.db
          .update(garment)
          .set({ suggestionNote: 'sneaked in' })
          .where(eq(garment.id, tee)),
      ).rejects.toThrow();
    });
  });

  describe('decisions (decide)', () => {
    it('This one resolves the group and sets its other open picks aside at that instant; Undo restores them', async () => {
      const blazer = await group('Navy blazer');
      const a = await pick('Blazer A', blazer, 1);
      const b = await pick('Blazer B', blazer, 2);
      const c = await pick('Blazer C', blazer, 3);
      expect(
        await decide(
          t.db,
          ownerId,
          { garmentId: c },
          {
            kind: 'dismiss-pick',
            garmentId: c,
            reason: 'colour',
            note: null,
          },
        ),
      ).toMatchObject({ ok: true, dismissed: [c] });
      const before = await t.db.$count(garment);

      expect(
        await decide(
          t.db,
          ownerId,
          { garmentId: a },
          { kind: 'choose', garmentId: a },
        ),
      ).toEqual({ ok: true, groupId: blazer, dismissed: [b], restored: [] });
      const chosen = await groupRow(blazer);
      expect(chosen).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: a,
      });
      expect(await dismissal(b)).toEqual({
        status: 'wishlist',
        reason: 'chose_another',
        note: null,
        at: chosen.decidedAt,
      });
      expect((await dismissal(a)).reason).toBeNull();
      // Nothing is deleted.
      expect(await t.db.$count(garment)).toBe(before);
      // A second tap is refused, not applied twice.
      expect(
        await decide(
          t.db,
          ownerId,
          { garmentId: b },
          { kind: 'choose', garmentId: b },
        ),
      ).toEqual({ ok: false, reason: 'not-allowed' });

      expect(
        await decide(
          t.db,
          ownerId,
          { groupId: blazer },
          { kind: 'undo-group' },
        ),
      ).toMatchObject({ ok: true, restored: [b] });
      expect(await groupRow(blazer)).toMatchObject({
        status: 'open',
        resolvedGarmentId: null,
        decidedAt: null,
      });
      expect((await dismissal(b)).reason).toBeNull();
      // The owner's own earlier "Not for me" stays.
      expect((await dismissal(c)).reason).toBe('colour');
    });

    it('Not for me records the reason and note; Undo opens the pick again', async () => {
      const coat = await group('Rain coat');
      const pickId = await pick('Coat A', coat, 1);
      await decide(
        t.db,
        ownerId,
        { garmentId: pickId },
        {
          kind: 'dismiss-pick',
          garmentId: pickId,
          reason: 'too_pricey',
          note: 'Over $300',
        },
      );
      expect(await dismissal(pickId)).toMatchObject({
        status: 'wishlist',
        reason: 'too_pricey',
        note: 'Over $300',
      });
      expect(
        await decide(
          t.db,
          ownerId,
          { garmentId: pickId },
          { kind: 'undo-pick', garmentId: pickId },
        ),
      ).toMatchObject({ ok: true, restored: [pickId] });
      expect(await dismissal(pickId)).toMatchObject({
        reason: null,
        note: null,
        at: null,
      });
    });

    it('Not for me on a need dismisses the group with its note; Undo reopens it', async () => {
      const need = await group('Linen shirt');
      await pick('Linen A', need, 1);
      await decide(
        t.db,
        ownerId,
        { groupId: need },
        { kind: 'dismiss-group', reason: 'not_now', note: 'Next summer' },
      );
      expect(await groupRow(need)).toMatchObject({
        status: 'dismissed',
        dismissedReason: 'not_now',
        ownerNote: 'Next summer',
      });
      await decide(t.db, ownerId, { groupId: need }, { kind: 'undo-group' });
      expect(await groupRow(need)).toMatchObject({
        status: 'open',
        dismissedReason: null,
        decidedAt: null,
      });
    });

    it('refuses another owner’s group as not found', async () => {
      await t.register('stranger-suggestions@example.com');
      const need = await group('Mine alone');
      const strangerId = await userIdOf(t, 'stranger-suggestions@example.com');
      expect(
        await decide(
          t.db,
          strangerId,
          { groupId: need },
          { kind: 'undo-group' },
        ),
      ).toEqual({ ok: false, reason: 'not-found' });
    });

    it('"Bought it" on a pick resolves its group and sets the others aside; Returned archives it and reopens the need', async () => {
      const boots = await group('Chelsea boots');
      const a = await pick('Boots A', boots, 1);
      const b = await pick('Boots B', boots, 2);
      await decide(
        t.db,
        ownerId,
        { garmentId: b },
        { kind: 'choose', garmentId: b },
      );
      const res = await post(`/wardrobe/${a}/bought`, {
        acquiredOn: t.today(),
        price: '180',
      });
      expect(res.statusCode).toBe(303);
      expect(await groupRow(boots)).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: a,
      });
      // The chosen one too: the owner bought another.
      expect((await dismissal(b)).reason).toBe('chose_another');
      // Provenance is kept on the owned garment.
      expect(await garmentRow(t, a)).toMatchObject({
        status: 'closet',
        suggestionGroupId: boots,
        suggestedByTokenId: tokenId,
      });

      expect(
        await decide(
          t.db,
          ownerId,
          { garmentId: a },
          { kind: 'returned', garmentId: a },
        ),
      ).toMatchObject({ ok: true, dismissed: [a] });
      expect(await dismissal(a)).toMatchObject({
        status: 'archived',
        reason: 'returned',
      });
      expect(await groupRow(boots)).toMatchObject({
        status: 'open',
        resolvedGarmentId: null,
      });
    });

    it('a different one bought resolves the group with that garment', async () => {
      const scarf = await group('Wool scarf');
      const a = await pick('Scarf A', scarf, 1);
      const mine = await createGarment(t, {
        name: 'Scarf from the market',
        category: 'scarves',
      });
      expect(
        await decide(
          t.db,
          ownerId,
          { groupId: scarf },
          { kind: 'bought', garmentId: mine },
        ),
      ).toMatchObject({ ok: true, dismissed: [a] });
      expect(await groupRow(scarf)).toMatchObject({
        status: 'resolved',
        resolvedGarmentId: mine,
      });
      expect(await garmentRow(t, mine)).toMatchObject({
        suggestedAt: null,
        suggestionGroupId: null,
      });
    });
  });

  describe('are out of every closet read, in every state', () => {
    let open: number;
    let chosen: number;
    let setAside: number;
    let lone: number;

    beforeAll(async () => {
      const knit = await group('Merino knit');
      open = await pick('Suggested knit open', knit, 1);
      const cardigan = await group('Cardigan');
      chosen = await pick('Suggested cardigan chosen', cardigan, 1);
      setAside = await pick('Suggested cardigan aside', cardigan, 2);
      await decide(
        t.db,
        ownerId,
        { garmentId: chosen },
        { kind: 'choose', garmentId: chosen },
      );
      lone = await pick('Suggested lone pick', null);
      await decide(
        t.db,
        ownerId,
        { garmentId: lone },
        {
          kind: 'dismiss-pick',
          garmentId: lone,
          reason: 'style',
          note: null,
        },
      );
    });

    it('the grid, its archived view, Styling, capsules, laundry, tagging, Ideas, Today and insights', async () => {
      // Each would show a garment by name; a suggestion is named "Suggested …".
      for (const url of [
        '/wardrobe',
        '/wardrobe?archived=true',
        '/wardrobe/tiles?before=2147483647',
        '/styling',
        '/styling/garments?role=top&before=2147483647',
        '/capsules',
        '/laundry',
        '/outfits/ideas',
        '/',
        '/wardrobe/insights',
        '/wardrobe/tag',
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(200);
        expect(unescapeHtml(res.body), url).not.toContain('Suggested');
      }
    });

    it('cannot be worn, washed or lent, nor saved in an outfit', async () => {
      for (const id of [open, chosen, setAside, lone]) {
        for (const [action, payload] of [
          ['wear', { worn: '1' }],
          ['washed', {}],
          ['away', { away: 'lent' }],
        ] as const) {
          const res = await post(`/wardrobe/${id}/${action}`, payload);
          expect(res.statusCode, `${action} ${id}`).toBe(409);
        }
      }
      const before = await t.db.$count(outfitSlot);
      const res = await post('/outfits', {
        name: 'With a pick',
        category: ['tops', 'bottoms'],
        garmentId: [String(chosen), String(jeans)],
      });
      expect(res.statusCode).toBe(409);
      expect(await t.db.$count(outfitSlot)).toBe(before);
    });

    it('MCP’s closet reads never list one', async () => {
      const searched = await tool<{ garments: { name: string | null }[] }>(
        t,
        mcpToken,
        'search_garments',
      );
      const wardrobe = await tool<{ garments: { name: string | null }[] }>(
        t,
        mcpToken,
        'get_wardrobe',
      );
      for (const { garments } of [searched, wardrobe]) {
        expect(garments.map((g) => g.name)).toContain('Raw jeans');
        expect(garments.filter((g) => g.name?.startsWith('Suggested'))).toEqual(
          [],
        );
      }
    });

    it('lists of things to buy leave out what was set aside: the Wishlist tab and list_wishlist', async () => {
      const page = unescapeHtml((await get('/wardrobe/wishlist')).body);
      expect(page).toContain('Suggested knit open');
      expect(page).toContain('Suggested cardigan chosen');
      expect(page).not.toContain('Suggested cardigan aside');
      expect(page).not.toContain('Suggested lone pick');
      const listed = await tool<{ items: { name: string | null }[] }>(
        t,
        mcpToken,
        'list_wishlist',
      );
      const names = listed.items.map((i) => i.name);
      expect(names).toContain('Suggested knit open');
      expect(names).not.toContain('Suggested cardigan aside');
      expect(names).not.toContain('Suggested lone pick');
      // Set aside, never deleted: the rows are all there.
      const rows = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(inArray(garment.id, [open, chosen, setAside, lone]));
      expect(rows).toHaveLength(4);
    });
  });
});
