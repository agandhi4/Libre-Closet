import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  capsule,
  capsuleGarment,
  garment,
  planItem,
  planItemCandidate,
  planItemRejection,
  planLookSlot,
} from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { proposeLook } from '../../src/web/plans/looks';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * Reviewing the agent's proposals inline (#315, part A): the item sheet's
 * decisions each post as they are made through the item's own routes
 * (`/accept` with a pick or none, `/decline`, `/change`, and the new
 * `/candidates/:garmentId/reject`), the `?show=proposed` filter, the
 * landing after a decision, and the stale-content guard (`asOf`: the
 * agent's `agent_changed_at` as the page drew it). Every transition's row
 * is asserted. The machine's pairs: src/wardrobe/plan-review.spec.ts; the
 * review page's post stays as it was: plan-item-review.spec.ts.
 */
describe('the inline review in the item sheet', () => {
  let t: TestApp;
  let token: string;
  let seq = 0;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: object = {}) =>
    t.inject({ method: 'POST', url, payload });

  const idFrom = (location: unknown, pattern: RegExp) => {
    const match = pattern.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect ${String(location)}`);
    return Number(match[1]);
  };

  /** A plan an agent drafted (create_plan): never the active one. */
  const draft = async () =>
    (
      await tool<{ id: number }>(t, token, 'create_plan', {
        name: `Draft ${++seq}`,
      })
    ).id;

  const propose = async (planId: number) =>
    (
      await tool<{ id: number }>(t, token, 'propose_plan_item', {
        planId,
        category: 'tops',
        name: `Item ${++seq}`,
      })
    ).id;

  const addWishlist = async (name: string) => {
    const res = await post('/wardrobe', {
      name,
      to: 'wishlist',
      wishlist: '1',
      replaces: '',
      props: '1',
      product: '1',
      category: 'tops',
      brand: 'Uniqlo',
      price: '25',
      sourceUrl: 'https://shop.example/tee',
    });
    expect(res.statusCode, res.body).toBe(302);
    return idFrom(res.headers.location, /^\/wardrobe\/(\d+)/);
  };

  const link = (itemIds: number[], garmentIds: number[]) =>
    changeCandidates(t.db, t.owner.id, { add: { itemIds, garmentIds } });

  /** A proposal with `count` wishlist candidates. */
  const proposal = async (count: number) => {
    const planId = await draft();
    const itemId = await propose(planId);
    const garments: number[] = [];
    for (let i = 0; i < count; i++) {
      garments.push(await addWishlist(`Tee ${++seq}`));
    }
    if (count > 0) await link([itemId], garments);
    return { planId, itemId, garments };
  };

  const rowOf = async (itemId: number) =>
    (
      await t.db
        .select({
          review: planItem.review,
          ownerNote: planItem.ownerNote,
        })
        .from(planItem)
        .where(eq(planItem.id, itemId))
    )[0];

  const candidatesOf = async (itemId: number) =>
    (
      await t.db
        .select({ garmentId: planItemCandidate.garmentId })
        .from(planItemCandidate)
        .where(eq(planItemCandidate.planItemId, itemId))
    )
      .map((row) => row.garmentId)
      .sort((a, b) => a - b);

  const existing = async (ids: number[]) =>
    (
      await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(inArray(garment.id, ids))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  const rejectionsOf = (itemId: number) =>
    t.db
      .select({
        name: planItemRejection.name,
        reason: planItemRejection.reason,
      })
      .from(planItemRejection)
      .where(eq(planItemRejection.planItemId, itemId));

  /** The `asOf` the item's sheet carries, as the page drew it. */
  const asOfOnPage = async (planId: number, itemId: number) => {
    const html = unescapeHtml((await get(`/wardrobe/plans/${planId}`)).body);
    const sheet = html.slice(html.indexOf(`id="plan-sheet-${itemId}"`));
    const match = /name="asOf" value="(\d*)"/.exec(sheet);
    if (!match) throw new Error('no asOf in the sheet');
    return match[1];
  };

  /** One item's sheet, as the plan page draws it. */
  const sheetOf = async (planId: number, itemId: number) => {
    const html = unescapeHtml((await get(`/wardrobe/plans/${planId}`)).body);
    const start = html.indexOf(`id="plan-sheet-${itemId}"`);
    return html.slice(start, html.indexOf('</dialog>', start));
  };

  /** The candidates the sheet's decision form posts (`offered`), as drawn. */
  const offeredOnPage = async (planId: number, itemId: number) =>
    [
      ...(await sheetOf(planId, itemId)).matchAll(
        /name="offered" value="(\d+)"/g,
      ),
    ].map((match) => match[1]);

  /** A closet garment of the owner's, for a look's other pieces. */
  const closetGarment = async (category: string) =>
    (
      await t.db
        .insert(garment)
        .values({
          ownerId: t.owner.id,
          status: 'closet',
          category,
          name: `${category} ${++seq}`,
          shareableId: randomUUID(),
        })
        .returning({ id: garment.id })
    )[0].id;

  /** A look of the plan holding `candidate` as its to-buy piece, loved by the owner. */
  const lovedLookWith = async (planId: number, candidate: number) => {
    const look = await proposeLook(
      t.db,
      t.owner.id,
      planId,
      { name: `Look ${++seq}`, occasion: 'work', note: 'Why it works' },
      [
        await closetGarment('bottoms'),
        await closetGarment('footwear'),
        candidate,
      ],
    );
    const loved = await post(`/wardrobe/plans/${planId}/looks/${look.id}/love`);
    expect(loved.statusCode, loved.body).toBe(303);
    return look.id;
  };

  const slotHolds = async (lookId: number, garmentId: number) =>
    (
      await t.db
        .select({ garmentId: planLookSlot.garmentId })
        .from(planLookSlot)
        .where(
          and(
            eq(planLookSlot.lookId, lookId),
            eq(planLookSlot.garmentId, garmentId),
          ),
        )
    ).length === 1;

  const planUrl = (planId: number) => `/wardrobe/plans/${planId}`;
  const itemUrl = (planId: number, itemId: number, suffix: string) =>
    `${planUrl(planId)}/items/${itemId}${suffix}`;

  beforeAll(async () => {
    t = await createTestApp();
    token = await createAccessToken(t, { name: 'Muse' });
    // The active plan, so the drafts below stay drafts.
    await post('/wardrobe/plans', { name: 'Mine' });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('the sheet and the proposals filter', () => {
    it('draws each candidate large with Use this and Not this one, and the decisions', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const html = unescapeHtml((await get(planUrl(planId))).body);
      const sheet = html.slice(html.indexOf(`id="plan-sheet-${itemId}"`));
      for (const id of garments) {
        expect(sheet).toContain(`data-candidate="${id}"`);
        expect(sheet).toContain(
          `formaction="${itemUrl(planId, itemId, '/accept')}"`,
        );
        expect(sheet).toContain(
          itemUrl(planId, itemId, `/candidates/${id}/reject`),
        );
      }
      expect(sheet).toContain('Use this');
      expect(sheet).toContain('Not this one');
      expect(sheet).toContain(
        'formaction="' + itemUrl(planId, itemId, '/decline'),
      );
      expect(sheet).toContain(
        'Remove the products I didn’t pick from my wishlist',
      );
      expect(sheet).toMatch(/name="removeUnpicked" value="1"(?![^>]*checked)/);
      expect(sheet).toContain(itemUrl(planId, itemId, '/change'));
      expect(await offeredOnPage(planId, itemId)).toEqual(garments.map(String));
    });

    it('draws an accepted item’s candidates the same way, with Shop and no wishlist links', async () => {
      const { planId, itemId, garments } = await proposal(2);
      await post(itemUrl(planId, itemId, '/accept'), {});
      const sheet = await sheetOf(planId, itemId);
      for (const id of garments) {
        const tile = sheet.slice(sheet.indexOf(`data-candidate="${id}"`));
        expect(tile).toMatch(
          /^[^]*?<a href="https:\/\/shop\.example\/tee" target="_blank" rel="noopener noreferrer"[^>]*data-shop="">Shop<\/a>/,
        );
        expect(sheet).not.toContain(`href="/wardrobe/${id}"`);
      }
      expect(sheet).toContain('Uniqlo');
      expect(sheet).toContain('$25.00');
      expect(sheet).not.toContain('options');
      expect(sheet).not.toContain(`${itemUrl(planId, itemId, '/candidates')}"`);
      expect(sheet).not.toContain('Use this');
      expect(sheet).not.toContain('name="offered"');
    });

    it('an item with no candidates says so and still offers Keep and Don’t buy', async () => {
      const { planId, itemId } = await proposal(0);
      const html = unescapeHtml((await get(planUrl(planId))).body);
      const sheet = html.slice(html.indexOf(`id="plan-sheet-${itemId}"`));
      expect(sheet).toContain('data-no-options');
      expect(sheet).not.toContain('Use this');
      expect(sheet).toContain('Keep');
      expect(sheet).not.toContain('name="removeUnpicked"');
    });

    it('?show=proposed lists only the proposals; anything else lists everything', async () => {
      const { planId, itemId } = await proposal(0);
      const done = await propose(planId);
      expect((await post(itemUrl(planId, done, '/accept'))).statusCode).toBe(
        303,
      );

      const only = (await get(`${planUrl(planId)}?show=proposed`)).body;
      expect(only).toContain(`id="plan-item-${itemId}"`);
      expect(only).not.toContain(`id="plan-item-${done}"`);
      expect(only).toContain('id="plan-proposed-filter"');
      for (const url of [planUrl(planId), `${planUrl(planId)}?show=bogus`]) {
        const all = (await get(url)).body;
        expect(all).toContain(`id="plan-item-${itemId}"`);
        expect(all).toContain(`id="plan-item-${done}"`);
      }
    });
  });

  describe('each decision saves as it is made', () => {
    it('Keep accepts the item and lets go of nothing', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const res = await post(itemUrl(planId, itemId, '/accept'), {
        asOf: await asOfOnPage(planId, itemId),
        removeUnpicked: '1',
        show: 'proposed',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?show=proposed&open=next&saved=1`,
      );
      expect(await rowOf(itemId)).toEqual({
        review: 'accepted',
        ownerNote: null,
      });
      expect(await candidatesOf(itemId)).toEqual(garments);
      expect(await existing(garments)).toEqual(garments);
    });

    it('Use this accepts and, with the box unticked, keeps every candidate', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const res = await post(itemUrl(planId, itemId, '/accept'), {
        pick: String(garments[0]),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${planUrl(planId)}?saved=1`);
      expect((await rowOf(itemId)).review).toBe('accepted');
      expect(await existing(garments)).toEqual(garments);
    });

    it('Use this with the box ticked deletes the unpicked from the wishlist, in the same transaction as the move', async () => {
      const { planId, itemId, garments } = await proposal(3);
      const res = await post(itemUrl(planId, itemId, '/accept'), {
        pick: String(garments[1]),
        removeUnpicked: '1',
        offered: await offeredOnPage(planId, itemId),
        show: 'proposed',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?show=proposed&open=next&reviewed=1&removed=2`,
      );
      expect((await rowOf(itemId)).review).toBe('accepted');
      expect(await existing(garments)).toEqual([garments[1]]);
      expect(await candidatesOf(itemId)).toEqual([garments[1]]);
      expect(await rejectionsOf(itemId)).toEqual([]);
    });

    it('an unpicked candidate another item holds is unlinked here and kept', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const other = await propose(planId);
      await link([other], [garments[1]]);
      await post(itemUrl(planId, itemId, '/accept'), {
        pick: String(garments[0]),
        removeUnpicked: '1',
        offered: garments.map(String),
      });
      expect(await existing(garments)).toEqual(garments);
      expect(await candidatesOf(itemId)).toEqual([garments[0]]);
      expect(await candidatesOf(other)).toEqual([garments[1]]);
    });

    it('Don’t buy declines the item; with the box ticked it lets go of every candidate', async () => {
      const kept = await proposal(2);
      expect(
        (await post(itemUrl(kept.planId, kept.itemId, '/decline'), {}))
          .statusCode,
      ).toBe(303);
      expect((await rowOf(kept.itemId)).review).toBe('declined');
      expect(await existing(kept.garments)).toEqual(kept.garments);

      const gone = await proposal(2);
      const res = await post(itemUrl(gone.planId, gone.itemId, '/decline'), {
        removeUnpicked: '1',
        offered: gone.garments.map(String),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(gone.planId)}?reviewed=1&removed=2`,
      );
      expect((await rowOf(gone.itemId)).review).toBe('declined');
      expect(await existing(gone.garments)).toEqual([]);
    });

    it('lets go only of the candidates the sheet drew: one the agent added since stays, row and garment', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const offered = await offeredOnPage(planId, itemId);
      const late = await addWishlist(`Tee ${++seq}`);
      await tool(t, token, 'add_candidate', { itemId, garmentId: late });

      const res = await post(itemUrl(planId, itemId, '/accept'), {
        pick: String(garments[0]),
        removeUnpicked: '1',
        offered,
        asOf: await asOfOnPage(planId, itemId),
      });
      expect(res.statusCode, res.body).toBe(303);
      expect((await rowOf(itemId)).review).toBe('accepted');
      expect(await existing([...garments, late])).toEqual([garments[0], late]);
      expect(await candidatesOf(itemId)).toEqual([garments[0], late]);

      // Don't buy judges the same way; and a box ticked with nothing offered lets go of nothing.
      const declined = await proposal(1);
      const added = await addWishlist(`Tee ${++seq}`);
      await link([declined.itemId], [added]);
      await post(itemUrl(declined.planId, declined.itemId, '/decline'), {
        removeUnpicked: '1',
        offered: declined.garments.map(String),
      });
      expect(await existing([...declined.garments, added])).toEqual([added]);
      expect(await candidatesOf(declined.itemId)).toEqual([added]);
      const bare = await proposal(1);
      await post(itemUrl(bare.planId, bare.itemId, '/decline'), {
        removeUnpicked: '1',
      });
      expect(await existing(bare.garments)).toEqual(bare.garments);
    });

    it('an unpicked candidate a loved look holds is deleted and empties the look’s slot', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const look = await lovedLookWith(planId, garments[1]);
      const res = await post(itemUrl(planId, itemId, '/accept'), {
        pick: String(garments[0]),
        removeUnpicked: '1',
        offered: garments.map(String),
      });
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?reviewed=1&removed=1`,
      );
      expect(await existing(garments)).toEqual([garments[0]]);
      expect(await candidatesOf(itemId)).toEqual([garments[0]]);
      expect(await slotHolds(look, garments[1])).toBe(false);
    });

    it('an unpicked candidate in a capsule is unlinked, never deleted', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const [{ id: capsuleId }] = await t.db
        .insert(capsule)
        .values({ ownerId: t.owner.id, name: `Capsule ${++seq}` })
        .returning({ id: capsule.id });
      await t.db
        .insert(capsuleGarment)
        .values({ capsuleId, garmentId: garments[1] });
      await post(itemUrl(planId, itemId, '/accept'), {
        pick: String(garments[0]),
        removeUnpicked: '1',
        offered: garments.map(String),
      });
      expect(await existing(garments)).toEqual(garments);
      expect(await candidatesOf(itemId)).toEqual([garments[0]]);
    });

    it('Change this sends the item back with the note, and refuses a blank one', async () => {
      const { planId, itemId, garments } = await proposal(1);
      const blank = await post(itemUrl(planId, itemId, '/change'), {
        note: ' ',
      });
      expect(blank.statusCode).toBe(400);
      expect((await rowOf(itemId)).review).toBe('proposed');

      const res = await post(itemUrl(planId, itemId, '/change'), {
        note: 'Darker, please',
        asOf: await asOfOnPage(planId, itemId),
        show: 'proposed',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(await rowOf(itemId)).toEqual({
        review: 'revise',
        ownerNote: 'Darker, please',
      });
      expect(await existing(garments)).toEqual(garments);
    });

    it('a second decision on a decided item is a 409 and changes nothing', async () => {
      const { planId, itemId } = await proposal(0);
      await post(itemUrl(planId, itemId, '/decline'), {});
      const again = await post(itemUrl(planId, itemId, '/accept'), {});
      expect(again.statusCode).toBe(409);
      expect((await rowOf(itemId)).review).toBe('declined');
    });
  });

  describe('Not this one', () => {
    it('records the product and the reason, deletes it, and leaves the item proposed', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const res = await post(
        itemUrl(planId, itemId, `/candidates/${garments[0]}/reject`),
        {
          reason: ' Too baggy ',
          asOf: await asOfOnPage(planId, itemId),
          show: 'proposed',
        },
      );
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?show=proposed&open=${itemId}&reviewed=1&removed=1`,
      );
      expect((await rowOf(itemId)).review).toBe('proposed');
      expect(await existing(garments)).toEqual([garments[1]]);
      expect(await candidatesOf(itemId)).toEqual([garments[1]]);
      const rows = await rejectionsOf(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('Too baggy');
    });

    it('unlinks, and keeps the product, when another item holds it; no reason is null', async () => {
      const { planId, itemId, garments } = await proposal(1);
      const other = await propose(planId);
      await link([other], garments);
      const res = await post(
        itemUrl(planId, itemId, `/candidates/${garments[0]}/reject`),
        {},
      );
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?open=${itemId}&saved=1`,
      );
      expect(await existing(garments)).toEqual(garments);
      expect(await candidatesOf(itemId)).toEqual([]);
      expect(await candidatesOf(other)).toEqual(garments);
      expect((await rejectionsOf(itemId))[0].reason).toBeNull();
    });

    it('a candidate a loved look holds is recorded and deleted, and empties the look’s slot', async () => {
      const { planId, itemId, garments } = await proposal(2);
      const look = await lovedLookWith(planId, garments[0]);
      const res = await post(
        itemUrl(planId, itemId, `/candidates/${garments[0]}/reject`),
        { reason: 'Too shiny', asOf: await asOfOnPage(planId, itemId) },
      );
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?open=${itemId}&reviewed=1&removed=1`,
      );
      expect((await rowOf(itemId)).review).toBe('proposed');
      expect(await existing(garments)).toEqual([garments[1]]);
      expect(await candidatesOf(itemId)).toEqual([garments[1]]);
      expect(await slotHolds(look, garments[0])).toBe(false);
      expect((await rejectionsOf(itemId)).map((row) => row.reason)).toEqual([
        'Too shiny',
      ]);
    });

    it('is a 409 for a product that is no candidate (any more), or an item decided meanwhile', async () => {
      const { planId, itemId, garments } = await proposal(1);
      const stranger = await addWishlist('Not linked');
      const notLinked = await post(
        itemUrl(planId, itemId, `/candidates/${stranger}/reject`),
        {},
      );
      expect(notLinked.statusCode).toBe(409);
      expect(await rejectionsOf(itemId)).toEqual([]);

      await post(itemUrl(planId, itemId, '/decline'), {});
      const decided = await post(
        itemUrl(planId, itemId, `/candidates/${garments[0]}/reject`),
        {},
      );
      expect(decided.statusCode).toBe(409);
      expect(await rejectionsOf(itemId)).toEqual([]);
      expect(await existing(garments)).toEqual(garments);
    });

    it('is a 404 for a plan that is not the owner’s', async () => {
      const { itemId, garments } = await proposal(1);
      const res = await post(
        itemUrl(999_999, itemId, `/candidates/${garments[0]}/reject`),
        {},
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('the stale-content guard', () => {
    it('refuses a Keep when the agent rewrote the item since the page was drawn, and the sheet says so', async () => {
      const { planId, itemId } = await proposal(1);
      const asOf = await asOfOnPage(planId, itemId);
      expect(asOf).not.toBe('');
      // The agent's own writer moves agent_changed_at on.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tool(t, token, 'update_plan_item', { itemId, quantity: 2 });

      const res = await post(itemUrl(planId, itemId, '/accept'), { asOf });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `${planUrl(planId)}?open=${itemId}&stale=1`,
      );
      expect(await rowOf(itemId)).toEqual({
        review: 'proposed',
        ownerNote: null,
      });

      const page = unescapeHtml(
        (await get(res.headers.location as string)).body,
      );
      expect(page).toContain('Your agent changed this');
      const fresh = await asOfOnPage(planId, itemId);
      expect(fresh).not.toBe(asOf);
      expect(
        (await post(itemUrl(planId, itemId, '/accept'), { asOf: fresh }))
          .headers.location,
      ).toBe(`${planUrl(planId)}?saved=1`);
      expect((await rowOf(itemId)).review).toBe('accepted');
    });

    it('refuses Don’t buy, Change this… and Not this one the same way, writing nothing', async () => {
      const { planId, itemId, garments } = await proposal(1);
      const asOf = await asOfOnPage(planId, itemId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tool(t, token, 'update_plan_item', { itemId, quantity: 3 });
      const stale = `${planUrl(planId)}?open=${itemId}&stale=1`;

      const calls: [string, object][] = [
        ['/decline', { asOf, removeUnpicked: '1' }],
        ['/change', { asOf, note: 'Nope' }],
        [`/candidates/${garments[0]}/reject`, { asOf, reason: 'No' }],
      ];
      for (const [suffix, payload] of calls) {
        const res = await post(itemUrl(planId, itemId, suffix), payload);
        expect(res.headers.location, suffix).toBe(stale);
      }
      expect(await rowOf(itemId)).toEqual({
        review: 'proposed',
        ownerNote: null,
      });
      expect(await candidatesOf(itemId)).toEqual(garments);
      expect(await existing(garments)).toEqual(garments);
      expect(await rejectionsOf(itemId)).toEqual([]);
    });

    it('a null agent_changed_at as drawn matches a null now, and a post without asOf is not guarded', async () => {
      const { planId, itemId } = await proposal(0);
      await t.db
        .update(planItem)
        .set({ agentChangedAt: null })
        .where(eq(planItem.id, itemId));
      expect(await asOfOnPage(planId, itemId)).toBe('');
      const res = await post(itemUrl(planId, itemId, '/accept'), { asOf: '' });
      expect(res.headers.location).toBe(`${planUrl(planId)}?saved=1`);
      expect((await rowOf(itemId)).review).toBe('accepted');

      const other = await propose(planId);
      await tool(t, token, 'update_plan_item', { itemId: other, quantity: 2 });
      expect(
        (await post(itemUrl(planId, other, '/accept'))).headers.location,
      ).toBe(`${planUrl(planId)}?saved=1`);
    });
  });

  describe('the last proposal decided', () => {
    it('the filtered view says nothing is left, and a draft offers Make active', async () => {
      const { planId, itemId } = await proposal(0);
      const before = (await get(`${planUrl(planId)}?show=proposed`)).body;
      expect(before).not.toContain('Make active</button>\n');
      await post(itemUrl(planId, itemId, '/accept'), { show: 'proposed' });

      const after = unescapeHtml(
        (await get(`${planUrl(planId)}?show=proposed`)).body,
      );
      expect(after).toContain('Nothing left to review.');
      expect(after).toContain(`action="${planUrl(planId)}/activate"`);
      expect(after).not.toContain('id="plan-proposals"');
    });
  });
});
