import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';
import { hashPassword } from '../../src/web/auth/passwords';
import { planUrl, reviewUrl } from '../../src/web/plans/urls';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
} from './harness';

/**
 * drizzle/0040_muse-suggestions.sql (#333) on a database the previous build
 * migrated, holding the owner's production plan in its shape (2026-10-05:
 * Muse's draft, 24 proposed items, of which 10 have no candidate, 4 one,
 * 8 two and 2 three; 26 wishlist candidates; no rejections) and, for
 * another owner, every other case the data step maps (a declined item, a
 * revise item with a bought candidate, a rejection, a duplicated plan).
 * The real app boots on it (createApp runs 0040), and the plans pages
 * still work after it: they read the plan tables, which it never changes.
 */

const MUSE_COUNTS = [
  ...Array<number>(10).fill(0),
  ...Array<number>(4).fill(1),
  ...Array<number>(8).fill(2),
  ...Array<number>(2).fill(3),
];

function configOf(env: Record<string, string>): DbConfig {
  return {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    database: env.DATABASE_SCHEMA,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASS,
    ssl: false,
  };
}

/** A copy of drizzle/ that stops before 0040. */
async function migrationsBeforeSuggestions(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-drizzle-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((e) =>
    e.tag.endsWith('_muse-suggestions'),
  );
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  for (const { tag } of journal.entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${tag}.sql`),
      join(dir, `${tag}.sql`),
    );
  }
  return dir;
}

interface Fixture {
  muse: { owner: number; token: number; plan: number; items: number[] };
  /** Muse's candidates by item index, in rank order. */
  candidates: number[][];
  edge: {
    owner: number;
    declined: number;
    declinedPick: number;
    revise: number;
    bought: number;
    unbought: number;
    rejected: number;
    unnamed: number;
    copy: number;
  };
}

async function buildFixture(client: Client): Promise<Fixture> {
  const insert = async (text: string, values: unknown[] = []) =>
    (await client.query<{ id: number }>(`${text} returning id`, values)).rows[0]
      .id;
  const password = await hashPassword(TEST_PASSWORD);
  const userOf = (email: string) =>
    insert(`insert into "user" (email, password) values ($1, $2)`, [
      email,
      password,
    ]);
  const wish = (owner: number, name: string, status = 'wishlist') =>
    insert(
      `insert into garment (shareable_id, category, owner_id, status, name, price, source_url)
       values (gen_random_uuid()::text, 'tops', $1, $2, $3, '90.00', 'https://shop.example/' || md5($3))`,
      [owner, status, name],
    );
  const link = (item: number, garment: number, rank: number | null) =>
    client.query(
      `insert into plan_item_candidate (plan_item_id, garment_id, note, rank, created_at)
       values ($1, $2, $3, $4, '2026-10-04T08:00:00Z')`,
      [item, garment, rank === null ? null : `Muse on ${rank}`, rank],
    );

  // The owner's production plan, in shape.
  const owner = await userOf('muse-owner@example.com');
  const token = await insert(
    `insert into personal_access_token (user_id, name, token_hash, token_prefix)
     values ($1, 'Muse', repeat('a', 64), 'cl_aaaa')`,
    [owner],
  );
  const plan = await insert(
    `insert into wardrobe_plan (owner_id, name, active, drafted_by_token_id)
     values ($1, 'Muse’s draft', false, $2)`,
    [owner, token],
  );
  const items: number[] = [];
  const candidates: number[][] = [];
  for (const [index, count] of MUSE_COUNTS.entries()) {
    const n = index + 1;
    const item = await insert(
      `insert into plan_item (plan_id, name, category, budget, note, review, created_at)
       values ($1, $2, 'tops', '120.00', $3, 'proposed', '2026-10-03T08:00:00Z')`,
      [plan, `Need ${n}`, `Why need ${n}`],
    );
    items.push(item);
    const garments: number[] = [];
    for (let rank = 1; rank <= count; rank++) {
      const garment = await wish(owner, `Option ${n}.${rank}`);
      await link(item, garment, rank);
      garments.push(garment);
    }
    candidates.push(garments);
  }

  // Every other case, another owner's plans (no agent: drafted by no token).
  const edgeOwner = await userOf('edge@example.com');
  const edgePlan = await insert(
    `insert into wardrobe_plan (owner_id, name, active) values ($1, 'Mine', true)`,
    [edgeOwner],
  );
  const item = (name: string | null, review: string, ownerNote?: string) =>
    insert(
      `insert into plan_item (plan_id, name, category, review, owner_note)
       values ($1, $2, 'shoes', $3, $4)`,
      [edgePlan, name, review, ownerNote ?? null],
    );
  const declined = await item('Loafers', 'declined', 'have a pair');
  const declinedPick = await wish(edgeOwner, 'Penny loafer');
  await link(declined, declinedPick, null);
  const revise = await item('Boots', 'revise', 'darker');
  const bought = await wish(edgeOwner, 'Brown boots', 'closet');
  const unbought = await wish(edgeOwner, 'Tan boots');
  await link(revise, bought, 1);
  await link(revise, unbought, 2);
  const rejected = await item('Sneakers', 'accepted');
  await client.query(
    `insert into plan_item_rejection (plan_item_id, name, brand, url, price, reason, created_at)
     values ($1, 'Shiny trainer', 'Acme', 'https://shop.example/shiny', '80.00', 'too shiny', '2026-10-02T08:00:00Z')`,
    [rejected],
  );
  const unnamed = await item(null, 'accepted');
  // A duplicated plan: its copy links the same products as the original.
  const copyPlan = await insert(
    `insert into wardrobe_plan (owner_id, name, active) values ($1, 'Mine (copy)', false)`,
    [edgeOwner],
  );
  const copy = await insert(
    `insert into plan_item (plan_id, name, category, review) values ($1, 'Boots', 'shoes', 'accepted')`,
    [copyPlan],
  );
  await link(copy, bought, 1);
  await link(copy, unbought, 2);

  return {
    muse: { owner, token, plan, items },
    candidates,
    edge: {
      owner: edgeOwner,
      declined,
      declinedPick,
      revise,
      bought,
      unbought,
      rejected,
      unnamed,
      copy,
    },
  };
}

interface GroupRow {
  id: number;
  owner_id: number;
  name: string;
  budget: string | null;
  note: string | null;
  suggested_by_token_id: number | null;
  status: string;
  resolved_garment_id: number | null;
  dismissed_reason: string | null;
  owner_note: string | null;
  decided_at: Date | null;
  plan_item_id: number | null;
}

interface SuggestionRow {
  id: number;
  status: string;
  suggestion_group_id: number | null;
  suggested_by_token_id: number | null;
  suggestion_note: string | null;
  suggestion_rank: number | null;
  suggested_at: Date | null;
  dismissed_at: Date | null;
  dismissed_reason: string | null;
  dismissed_note: string | null;
}

let t: TestApp;
let fixture: Fixture;
let groups: GroupRow[];
let garments: Map<number, SuggestionRow>;

beforeAll(async () => {
  let folder: string | undefined;
  t = await createTestApp(
    {},
    {
      beforeBoot: async (env) => {
        const client = new Client(connectionOptions(configOf(env)));
        await client.connect();
        try {
          folder = await migrationsBeforeSuggestions();
          await migrate(drizzle(client), { migrationsFolder: folder });
          fixture = await buildFixture(client);
        } finally {
          await client.end();
          if (folder) await rm(folder, { recursive: true, force: true });
        }
      },
    },
  );
  const client = new Client(connectionOptions(t.database));
  await client.connect();
  try {
    groups = (
      await client.query<GroupRow>(`select * from option_group order by id`)
    ).rows;
    garments = new Map(
      (
        await client.query<SuggestionRow>(
          `select id, status, suggestion_group_id, suggested_by_token_id, suggestion_note,
             suggestion_rank, suggested_at, dismissed_at, dismissed_reason, dismissed_note
           from garment`,
        )
      ).rows.map((row) => [row.id, row]),
    );
  } finally {
    await client.end();
  }
});

afterAll(() => t?.cleanup());

function groupOf(planItemId: number): GroupRow | undefined {
  return groups.find((g) => g.plan_item_id === planItemId);
}

describe('the owner’s draft plan (production’s shape)', () => {
  it('makes each of the 24 items an open group of Muse’s, needs without options included', () => {
    const { owner, token, items } = fixture.muse;
    const mine = groups.filter((g) => g.owner_id === owner);
    expect(mine).toHaveLength(24);
    expect(mine.map((g) => g.plan_item_id)).toEqual(items);
    for (const [index, group] of mine.entries()) {
      expect(group).toMatchObject({
        name: `Need ${index + 1}`,
        budget: '120.00',
        note: `Why need ${index + 1}`,
        suggested_by_token_id: token,
        status: 'open',
        resolved_garment_id: null,
        dismissed_reason: null,
        decided_at: null,
      });
    }
  });

  it('makes the 26 candidates the groups’ suggestions, with Muse’s note, rank and token', () => {
    const { token, items } = fixture.muse;
    expect(fixture.candidates.flat()).toHaveLength(26);
    for (const [index, ids] of fixture.candidates.entries()) {
      const group = groupOf(items[index])!;
      const picks = [...garments.values()].filter(
        (g) => g.suggestion_group_id === group.id,
      );
      expect(picks.map((p) => p.id).sort()).toEqual([...ids].sort());
      for (const [position, id] of ids.entries()) {
        expect(garments.get(id)).toMatchObject({
          status: 'wishlist',
          suggested_by_token_id: token,
          suggestion_note: `Muse on ${position + 1}`,
          suggestion_rank: position + 1,
          suggested_at: new Date('2026-10-04T08:00:00Z'),
          dismissed_at: null,
        });
      }
    }
    // Ten needs Muse is still looking for: groups with no suggestion.
    const empty = groups.filter(
      (g) =>
        g.owner_id === fixture.muse.owner &&
        ![...garments.values()].some((s) => s.suggestion_group_id === g.id),
    );
    expect(empty).toHaveLength(10);
  });

  it('leaves the plan tables as they were', async () => {
    const client = new Client(connectionOptions(t.database));
    await client.connect();
    try {
      const { rows } = await client.query<{ items: number; links: number }>(
        `select (select count(*)::int from plan_item where plan_id = $1) as items,
           (select count(*)::int from plan_item_candidate c join plan_item i on i.id = c.plan_item_id
             where i.plan_id = $1) as links`,
        [fixture.muse.plan],
      );
      expect(rows[0]).toEqual({ items: 24, links: 26 });
    } finally {
      await client.end();
    }
  });

  it('keeps the plans pages working on it: the plan, its review, the shopping list and the wishlist', async () => {
    const cookie = await t.login('muse-owner@example.com');
    const get = (url: string) =>
      t.inject({ method: 'GET', url, headers: { cookie } });
    const { plan } = fixture.muse;
    const planPage = await get(planUrl(plan));
    expect(planPage.statusCode).toBe(200);
    expect(unescapeHtml(planPage.body)).toContain('Need 24');
    const review = await get(reviewUrl(plan));
    expect(review.statusCode).toBe(200);
    expect(unescapeHtml(review.body)).toContain('Option 23.3');
    expect((await get(`/wardrobe/shopping?plan=${plan}`)).statusCode).toBe(200);
    const wishlist = await get('/wardrobe/wishlist');
    expect(wishlist.statusCode).toBe(200);
    const html = unescapeHtml(wishlist.body);
    for (const name of ['Option 11.1', 'Option 15.2', 'Option 24.3']) {
      expect(html).toContain(name);
    }
    const pick = fixture.candidates[10][0];
    expect((await get(`/wardrobe/${pick}`)).statusCode).toBe(200);
  });
});

describe('every other case', () => {
  it('a declined item is a dismissed need (not now), its note kept, its candidate still its pick', () => {
    const { declined, declinedPick } = fixture.edge;
    expect(groupOf(declined)).toMatchObject({
      name: 'Loafers',
      suggested_by_token_id: null,
      status: 'dismissed',
      dismissed_reason: 'not_now',
      owner_note: 'have a pair',
    });
    expect(groupOf(declined)!.decided_at).not.toBeNull();
    expect(garments.get(declinedPick)).toMatchObject({
      suggestion_group_id: groupOf(declined)!.id,
      suggestion_rank: null,
      suggestion_note: null,
      dismissed_at: null,
    });
  });

  it('a candidate already bought resolves its need, and its open sibling is set aside at that instant', () => {
    const { revise, bought, unbought } = fixture.edge;
    const group = groupOf(revise)!;
    expect(group).toMatchObject({
      status: 'resolved',
      resolved_garment_id: bought,
      owner_note: 'darker',
    });
    expect(garments.get(bought)).toMatchObject({
      status: 'closet',
      suggestion_group_id: group.id,
      dismissed_at: null,
    });
    expect(garments.get(unbought)).toMatchObject({
      status: 'wishlist',
      suggestion_group_id: group.id,
      dismissed_reason: 'chose_another',
      dismissed_at: group.decided_at,
    });
  });

  it('a rejection comes back as a dismissed suggestion of its need, its reason as the note', () => {
    const group = groupOf(fixture.edge.rejected)!;
    expect(group.status).toBe('open');
    const placeholders = [...garments.values()].filter(
      (g) => g.suggestion_group_id === group.id,
    );
    expect(placeholders).toEqual([
      expect.objectContaining({
        status: 'wishlist',
        suggested_at: new Date('2026-10-02T08:00:00Z'),
        dismissed_at: new Date('2026-10-02T08:00:00Z'),
        dismissed_reason: null,
        dismissed_note: 'too shiny',
      }),
    ]);
  });

  it('names an unnamed need after its category, and leaves a duplicated plan’s copy out', () => {
    expect(groupOf(fixture.edge.unnamed)?.name).toBe('Shoes');
    expect(groupOf(fixture.edge.copy)).toBeUndefined();
  });
});
