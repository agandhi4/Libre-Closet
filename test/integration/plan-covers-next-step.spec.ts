import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { file, garment } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { proposeLook, reactToLooks } from '../../src/web/plans/looks';
import { addItems } from '../../src/web/plans/queries';
import type { PlanItemFields } from '../../src/web/plans/validation';
import type { GarmentStatus } from '../../src/wardrobe/status';
import { recordStatements } from '../support/query-recorder';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { expectFullPage } from './pages';
import { createAccessToken, tool } from './mcp';

/**
 * What #302 puts where the owner looks: a photo row and "N items · N looks
 * · N to buy" on each plans-list card (looks' collages first, loved first,
 * then each item's top candidate, five at most, read in one statement for
 * every plan), and Today's card turned into the next step, "<product>
 * completes N of your loved looks", while no draft waits on review.
 * Looks' own behaviour is plan-look-reactions.spec.ts's.
 */
describe('plan covers and the next step (#302)', () => {
  let t: TestApp;
  let seq = 0;

  const get = (url: string, cookie: string) =>
    t.inject({ method: 'GET', url, headers: { cookie } });

  const item = (category: string): PlanItemFields => ({
    name: null,
    category,
    type: null,
    colors: null,
    materials: null,
    warmthMin: null,
    warmthMax: null,
    formalityMin: null,
    formalityMax: null,
    quantity: 1,
    priority: 'medium',
    budget: null,
    note: null,
  });

  const newGarment = async (
    ownerId: number,
    status: GarmentStatus,
    category: string,
    name: string,
    photo = true,
  ) => {
    let photoId: number | null = null;
    if (photo) {
      [{ photoId }] = await t.db
        .insert(file)
        .values({
          fileName: `${randomUUID()}.webp`,
          shareableId: randomUUID(),
          createdOn: new Date().toISOString(),
          createdById: ownerId,
        })
        .returning({ photoId: file.id });
    }
    return (
      await t.db
        .insert(garment)
        .values({
          ownerId,
          status,
          category,
          name,
          photoId,
          shareableId: randomUUID(),
        })
        .returning({ id: garment.id })
    )[0].id;
  };

  /** A fresh owner and `plan(name)`, which creates a plan (the first is active) and returns its id. */
  const owner = async () => {
    const email = `cover-${++seq}@example.com`;
    const cookie = await t.register(email);
    const ownerId = await userIdOf(t, email);
    const plan = async (name: string) => {
      const created = await t.inject({
        method: 'POST',
        url: '/wardrobe/plans',
        payload: { name, notes: '' },
        headers: { cookie },
      });
      return Number(
        /^\/wardrobe\/plans\/(\d+)\?/.exec(
          String(created.headers.location),
        )![1],
      );
    };
    return { cookie, ownerId, plan };
  };

  /** Candidates of one new accepted item of `planId` (categories as given), by name. */
  const candidatesFor = async (
    ownerId: number,
    planId: number,
    category: string,
    names: string[],
  ) => {
    const [itemId] = (await addItems(t.db, ownerId, planId, [item(category)], {
      review: 'accepted',
    }))!;
    const ids: number[] = [];
    for (const name of names) {
      ids.push(await newGarment(ownerId, 'wishlist', category, name));
    }
    await changeCandidates(t.db, ownerId, {
      add: { itemIds: [itemId], garmentIds: ids },
    });
    return ids;
  };

  const look = async (
    ownerId: number,
    planId: number,
    name: string,
    garmentIds: number[],
  ) =>
    (
      await proposeLook(
        t.db,
        ownerId,
        planId,
        { name, occasion: 'work', note: null },
        garmentIds,
      )
    ).id;

  const love = (ownerId: number, planId: number, lookId: number) =>
    reactToLooks(t.db, ownerId, planId, 'love', [{ lookId }]);

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('the plans list', () => {
    it('draws a photo row, looks before candidates, loved first, and the counts', async () => {
      const o = await owner();
      const planId = await o.plan('Autumn');
      const top = await newGarment(o.ownerId, 'closet', 'tops', 'Oxford');
      const bottom = await newGarment(o.ownerId, 'closet', 'bottoms', 'Chinos');
      const [loafers] = await candidatesFor(o.ownerId, planId, 'footwear', [
        'Suede loafers',
        'Second choice boots',
      ]);
      await candidatesFor(o.ownerId, planId, 'outerwear', ['Wool coat']);
      const plain = await look(o.ownerId, planId, 'Plain', [top, bottom]);
      const dressy = await look(o.ownerId, planId, 'Dressy', [
        top,
        bottom,
        loafers,
      ]);
      await love(o.ownerId, planId, dressy);
      expect(plain).toBeLessThan(dressy);

      const res = await get('/wardrobe/plans', o.cookie);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      // Two items missing (nothing owned in footwear or outerwear), two looks.
      expect(html).toContain('2 items · 2 looks · 2 to buy');
      const cells = [...html.matchAll(/data-cover-cell="(look|photo)"/g)].map(
        (m) => m[1],
      );
      // Two looks, then one candidate per item.
      expect(cells).toEqual(['look', 'look', 'photo', 'photo']);
      // The loved look leads: its marked loafers are the first cell's.
      const [first] = html.split('data-cover-cell="look"').slice(1);
      expect(first).toContain('data-to-buy');
    });

    it('holds at five cells, passes over photoless looks, and says one look', async () => {
      const o = await owner();
      const planId = await o.plan('Big');
      const top = await newGarment(o.ownerId, 'closet', 'tops', 'Bare', false);
      for (const category of [
        'footwear',
        'outerwear',
        'bottoms',
        'bags',
        'hats',
        'scarves',
      ]) {
        await candidatesFor(o.ownerId, planId, category, [`New ${category}`]);
      }
      // A look of photoless pieces is no cover cell; a declined one is no look.
      const bare = await newGarment(
        o.ownerId,
        'closet',
        'bottoms',
        'Bare',
        false,
      );
      const only = await look(o.ownerId, planId, 'Bare look', [top, bare]);
      const html = unescapeHtml((await get('/wardrobe/plans', o.cookie)).body);
      expect([...html.matchAll(/data-cover-cell="/g)]).toHaveLength(5);
      expect(html).toContain('6 items · 1 look · 5 to buy');

      await reactToLooks(t.db, o.ownerId, planId, 'decline', [
        { lookId: only, note: 'No' },
      ]);
      const after = unescapeHtml((await get('/wardrobe/plans', o.cookie)).body);
      expect(after).toContain('6 items · 0 looks · 5 to buy');
    });

    it('is one batched statement for every plan: the count does not grow with the plans', async () => {
      const o = await owner();
      const first = await o.plan('One');
      await candidatesFor(o.ownerId, first, 'footwear', ['Loafers']);
      const one = await recordStatements(() =>
        get('/wardrobe/plans', o.cookie),
      );
      expect(one.result.statusCode).toBe(200);
      for (const name of ['Two', 'Three', 'Four']) {
        const planId = await o.plan(name);
        await candidatesFor(o.ownerId, planId, 'tops', [`${name} tee`]);
      }
      const four = await recordStatements(() =>
        get('/wardrobe/plans', o.cookie),
      );
      expect(four.statements).toHaveLength(one.statements.length);
      // The session, the plans, their items, the closet, the covers, the shared wardrobes.
      expect(four.statements).toHaveLength(6);
    });

    it('shows nothing of another owner’s plans', async () => {
      const a = await owner();
      const b = await owner();
      const planId = await a.plan('Private');
      await candidatesFor(a.ownerId, planId, 'footwear', ['Secret shoes']);
      const html = unescapeHtml((await get('/wardrobe/plans', b.cookie)).body);
      expect(html).not.toContain('Private');
      expect(html).not.toContain('data-cover-cell');
    });
  });

  describe('Today', () => {
    /** A plan whose closet pieces make three looks (top, bottom, and one product each). */
    const fixture = async () => {
      const o = await owner();
      const planId = await o.plan('Autumn');
      const top = await newGarment(o.ownerId, 'closet', 'tops', 'Oxford');
      const bottom = await newGarment(o.ownerId, 'closet', 'bottoms', 'Chinos');
      const [first] = await candidatesFor(o.ownerId, planId, 'footwear', [
        'Suede loafers',
      ]);
      const [second] = await candidatesFor(o.ownerId, planId, 'outerwear', [
        'Wool coat',
      ]);
      return { ...o, planId, top, bottom, first, second };
    };
    const today = async (cookie: string) =>
      unescapeHtml((await get('/', cookie)).body);

    it('is silent until a look is loved, then names the product and links the shopping strip', async () => {
      const f = await fixture();
      const proposed = await look(f.ownerId, f.planId, 'A', [
        f.top,
        f.bottom,
        f.first,
      ]);
      // Something proposed, but nothing loved and no draft: no card.
      expect(await today(f.cookie)).not.toContain('data-next-purchase');
      await love(f.ownerId, f.planId, proposed);
      const html = await today(f.cookie);
      expectFullPage(await get('/', f.cookie));
      expect(html).toContain('Suede loafers completes your loved look');
      expect(html).toContain(`data-next-purchase="${f.first}"`);
      expect(html).toMatch(
        /data-next-purchase="\d+"[\s\S]*href="\/wardrobe\/shopping"/,
      );
    });

    it('picks the product in the most loved looks, then the most looks, then the lowest id', async () => {
      const f = await fixture();
      const shoes = await newGarment(f.ownerId, 'closet', 'footwear', 'Boots');
      const a1 = await look(f.ownerId, f.planId, 'A1', [f.top, f.first]);
      const b1 = await look(f.ownerId, f.planId, 'B1', [f.top, f.second]);
      await love(f.ownerId, f.planId, a1);
      await love(f.ownerId, f.planId, b1);
      // One loved look each, one look each: the lower garment id.
      expect(f.first).toBeLessThan(f.second);
      expect(await today(f.cookie)).toContain(
        `data-next-purchase="${f.first}"`,
      );

      // A look of any kind breaks the tie: the coat is in two looks.
      const b2 = await look(f.ownerId, f.planId, 'B2', [f.bottom, f.second]);
      expect(await today(f.cookie)).toContain(
        `data-next-purchase="${f.second}"`,
      );

      // A second loved look beats it: the loafers are in two loved looks.
      const a2 = await look(f.ownerId, f.planId, 'A2', [shoes, f.first]);
      const a3 = await look(f.ownerId, f.planId, 'A3', [f.bottom, f.first]);
      await love(f.ownerId, f.planId, a2);
      await love(f.ownerId, f.planId, a3);
      const html = await today(f.cookie);
      expect(html).toContain('Suede loafers completes 3 of your loved looks');

      // A declined look no longer counts: back to the coat's two looks.
      for (const lookId of [a2, a3]) {
        await reactToLooks(t.db, f.ownerId, f.planId, 'decline', [
          { lookId, note: 'No' },
        ]);
      }
      expect(await today(f.cookie)).toContain(
        `data-next-purchase="${f.second}"`,
      );
      expect(b2).toBeGreaterThan(b1);
    });

    it('only the active plan, only products still on the wishlist, only the owner', async () => {
      const f = await fixture();
      const other = await f.plan('Elsewhere');
      const [elsewhere] = await candidatesFor(f.ownerId, other, 'footwear', [
        'Other plan shoes',
      ]);
      const inOther = await look(f.ownerId, other, 'Other', [f.top, elsewhere]);
      await love(f.ownerId, other, inOther);
      expect(await today(f.cookie)).not.toContain('data-next-purchase');

      const mine = await look(f.ownerId, f.planId, 'Mine', [f.top, f.first]);
      await love(f.ownerId, f.planId, mine);
      expect(await today(f.cookie)).toContain(
        `data-next-purchase="${f.first}"`,
      );

      // Bought: it is in the closet, nothing left to buy there.
      await t.db
        .update(garment)
        .set({ status: 'closet' })
        .where(eq(garment.id, f.first));
      expect(await today(f.cookie)).not.toContain('data-next-purchase');

      // Somebody else sees none of it.
      const stranger = await owner();
      expect(await today(stranger.cookie)).not.toContain('data-next-purchase');
    });

    it('gives way to Review N ideas while anything is proposed: one card', async () => {
      const f = await fixture();
      const mine = await look(f.ownerId, f.planId, 'Mine', [f.top, f.first]);
      await love(f.ownerId, f.planId, mine);
      const token = await createAccessToken(t, { name: 'Muse' });
      const draft = await tool<{ id: number }>(t, token, 'create_plan', {
        name: 'Spring capsule',
      });
      // createAccessToken and tool act as the harness owner, not this user:
      // the draft is theirs, so this owner's Today keeps its next step...
      expect(await today(f.cookie)).toContain('data-next-purchase');
      // ...and the harness owner, with a draft waiting, has its card alone.
      await tool(t, token, 'propose_plan_item', {
        planId: draft.id,
        category: 'tops',
        name: 'Navy blazer',
      });
      const html = unescapeHtml(
        (await t.inject({ method: 'GET', url: '/' })).body,
      );
      expect(html).toContain('Muse drafted Spring capsule: 1 idea to review');
      expect(html).not.toContain('data-next-purchase');
    });

    it('costs no statement of its own', async () => {
      const f = await fixture();
      const bare = await recordStatements(() => get('/', f.cookie));
      const mine = await look(f.ownerId, f.planId, 'Mine', [f.top, f.first]);
      await love(f.ownerId, f.planId, mine);
      const withStep = await recordStatements(() => get('/', f.cookie));
      expect(withStep.result.body).toContain('data-next-purchase');
      expect(withStep.statements).toHaveLength(bare.statements.length);
      expect(withStep.statements).toHaveLength(3);
    });
  });
});
