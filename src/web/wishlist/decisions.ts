import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { garment, optionGroup } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import {
  type DismissReason,
  type DecisionOutcome,
  decideSuggestion,
  type GroupState,
  type OptionGroupStatus,
  type PickState,
  type SuggestionDecision,
} from '../../wardrobe/suggestions';
import { ownerTransaction } from '../auth/queries';
import { onWishlist, setGarmentStatus } from '../wardrobe/status';

/**
 * The one writer of a suggestion's and an option group's decisions (Muse,
 * #333): every This one, Not for me, Bought it's settling of the group,
 * Returned and Undo comes through decide, which holds the owner lock
 * (every writer of option_group and of the garment's dismissal holds it,
 * so no row lock is needed), reads the group and its garments in one
 * statement, asks the pure machine (decideSuggestion,
 * src/wardrobe/suggestions.ts) and writes its answer in one statement.
 * Nothing is deleted: a turned-down pick or need is dismissed, for the
 * agent to learn from.
 */

/**
 * What the decision is about: the group (a need's own decisions, and a
 * purchase of "a different one", a garment that is none of its picks), or
 * a garment, whose group is the one it is a pick of or that it resolved.
 */
export type DecisionSubject = { groupId: number } | { garmentId: number };

export type DecideOutcome =
  | {
      ok: true;
      groupId: number | null;
      dismissed: number[];
      restored: number[];
    }
  /** Not the owner's group, or not a suggestion of theirs: a 404 like an unknown id. */
  | { ok: false; reason: 'not-found' }
  /** Not where the decision applies (a stale page, a double tap): a 409. */
  | { ok: false; reason: 'not-allowed' };

interface GroupRow {
  id: number;
  status: OptionGroupStatus;
  resolvedGarmentId: number | null;
  decidedAt: string | null;
}

interface PickRow {
  id: number;
  wanted: boolean;
  dismissedAt: string | null;
  dismissedReason: DismissReason | null;
}

/** The subject's group id, as SQL: named, or the group the garment is a pick of or resolved. */
function groupIdSql(ownerId: number, subject: DecisionSubject): SQL {
  if ('groupId' in subject) return sql`${subject.groupId}::integer`;
  return sql`coalesce(
    (select ${garment.suggestionGroupId} from ${garment}
      where ${and(eq(garment.id, subject.garmentId), eq(garment.ownerId, ownerId))}),
    (select ${optionGroup.id} from ${optionGroup}
      where ${and(eq(optionGroup.resolvedGarmentId, subject.garmentId), eq(optionGroup.ownerId, ownerId))})
  )`;
}

/**
 * The group (null when there is none of the owner's) and the garments the
 * machine judges: its picks, the garment that resolved it, and the
 * subject garment when it is a suggestion of the owner's outside any group.
 * One statement.
 */
async function readSubject(
  tx: Queryable,
  ownerId: number,
  subject: DecisionSubject,
): Promise<{ group: GroupRow | null; picks: PickRow[] }> {
  const id = groupIdSql(ownerId, subject);
  const resolvedOf = sql`(select ${optionGroup.resolvedGarmentId} from ${optionGroup} where ${optionGroup.id} = ${id})`;
  return selectScalars(tx, {
    group: sql<GroupRow | null>`(
      select json_build_object(
        'id', ${optionGroup.id},
        'status', ${optionGroup.status},
        'resolvedGarmentId', ${optionGroup.resolvedGarmentId},
        'decidedAt', ${optionGroup.decidedAt}
      )
      from ${optionGroup}
      where ${optionGroup.id} = ${id} and ${eq(optionGroup.ownerId, ownerId)}
    )`,
    picks: sql<PickRow[]>`(
      select coalesce(json_agg(json_build_object(
        'id', ${garment.id},
        'wanted', ${garment.status} = 'wishlist',
        'dismissedAt', ${garment.dismissedAt},
        'dismissedReason', ${garment.dismissedReason}
      ) order by ${garment.id}), '[]')
      from ${garment}
      where ${eq(garment.ownerId, ownerId)} and (
        ${garment.suggestionGroupId} = ${id}
        or ${garment.id} = ${resolvedOf}
        ${
          'garmentId' in subject
            ? sql`or (${garment.id} = ${subject.garmentId} and ${garment.suggestedAt} is not null)`
            : sql``
        }
      )
    )`,
  });
}

function groupState(row: GroupRow): GroupState {
  return {
    status: row.status,
    resolvedGarmentId: row.resolvedGarmentId,
    decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt),
  };
}

function pickState(row: PickRow): PickState {
  return {
    id: row.id,
    wanted: row.wanted,
    dismissedAt: row.dismissedAt === null ? null : new Date(row.dismissedAt),
    dismissedReason: row.dismissedReason,
  };
}

/**
 * The machine's answer as update statements (the group's, then each
 * dismissal and restore), for decide to send as one statement.
 */
function outcomeWrites(
  tx: Queryable,
  ownerId: number,
  groupId: number | undefined,
  outcome: Extract<DecisionOutcome, { ok: true }>,
): SQL[] {
  const writes: SQL[] = [];
  if (outcome.group && groupId !== undefined) {
    const change = outcome.group;
    writes.push(
      tx
        .update(optionGroup)
        .set({
          status: change.status,
          resolvedGarmentId: change.resolvedGarmentId,
          decidedAt: change.decided ? sql`now()` : null,
          dismissedReason: change.dismissedReason,
          ...(change.ownerNote !== undefined && {
            ownerNote: change.ownerNote,
          }),
        })
        .where(eq(optionGroup.id, groupId))
        .getSQL(),
    );
  }
  // A decision's dismissals share one reason and note (one pick's, or
  // the siblings' chose_another): one update per pair.
  const byReason = new Map<string, number[]>();
  for (const { garmentId, reason, note } of outcome.dismiss) {
    const key = JSON.stringify([reason, note]);
    byReason.set(key, [...(byReason.get(key) ?? []), garmentId]);
  }
  for (const [key, ids] of byReason) {
    const [reason, note] = JSON.parse(key) as [DismissReason, string | null];
    writes.push(
      tx
        .update(garment)
        .set({
          dismissedAt: sql`now()`,
          dismissedReason: reason,
          dismissedNote: note,
        })
        .where(and(inArray(garment.id, ids), eq(garment.ownerId, ownerId)))
        .getSQL(),
    );
  }
  if (outcome.restore.length > 0) {
    writes.push(
      tx
        .update(garment)
        .set({
          dismissedAt: null,
          dismissedReason: null,
          dismissedNote: null,
        })
        .where(
          and(
            inArray(garment.id, outcome.restore),
            eq(garment.ownerId, ownerId),
          ),
        )
        .getSQL(),
    );
  }
  return writes;
}

/**
 * Decides `decision` about `subject` for the owner, in their owner
 * transaction (joined when the caller holds it: "Bought it", buyCandidate).
 * Dismissals and the group's decided_at are stamped with the
 * transaction's time (now()), so a choice and the siblings it set aside
 * share one instant, which is how its undo finds them. Returned archives
 * the bought garment (setGarmentStatus) in the same transaction.
 */
export function decide(
  db: Queryable,
  ownerId: number,
  subject: DecisionSubject,
  decision: SuggestionDecision,
): Promise<DecideOutcome> {
  return ownerTransaction(db, ownerId, 'decide', async (tx) => {
    const read = await readSubject(tx, ownerId, subject);
    if ('groupId' in subject && !read.group) {
      return { ok: false, reason: 'not-found' };
    }
    const outcome = decideSuggestion(
      read.group ? groupState(read.group) : undefined,
      read.picks.map(pickState),
      decision,
    );
    if (!outcome.ok) {
      return {
        ok: false,
        reason:
          outcome.refusal === 'not-in-group' ? 'not-found' : 'not-allowed',
      };
    }
    if (decision.kind === 'returned') {
      const archived = await setGarmentStatus(tx, decision.garmentId, ownerId, {
        event: 'archive',
      });
      if (!archived.ok) return { ok: false, reason: 'not-allowed' };
    }

    const writes = outcomeWrites(tx, ownerId, read.group?.id, outcome);
    // One statement: each write a data-modifying CTE (they touch disjoint
    // rows), embedded through getSQL(), which Drizzle does not parenthesise.
    if (writes.length > 0) {
      await tx.execute(
        sql`with ${sql.join(
          writes.map(
            (write, index) => sql`${sql.raw(`w${index}`)} as (${write})`,
          ),
          sql`, `,
        )} select 1`,
      );
    }
    return {
      ok: true,
      groupId: read.group?.id ?? null,
      dismissed: outcome.dismiss.map((d) => d.garmentId),
      restored: outcome.restore,
    };
  });
}

/** What makes a wishlist garment a suggestion: who proposed it, where, why, and its rank. */
export interface Provenance {
  tokenId: number | null;
  groupId: number | null;
  note: string | null;
  rank: number | null;
}

/**
 * The one writer of a suggestion's provenance after drizzle/0040: marks
 * the owner's garment `garmentId` as suggested now, only while it is on
 * the wishlist and not a suggestion already (the agent's tools, #337), and
 * only into a group of the same owner. Provenance is kept once the garment
 * is bought, which is why no check constraint can hold the wishlist rule:
 * it is this writer's. One statement.
 */
export async function markSuggestion(
  db: Queryable,
  ownerId: number,
  garmentId: number,
  provenance: Provenance,
): Promise<'marked' | 'refused'> {
  const groupOk =
    provenance.groupId === null
      ? sql`true`
      : sql`exists (select 1 from ${optionGroup} where ${and(
          eq(optionGroup.id, provenance.groupId),
          eq(optionGroup.ownerId, ownerId),
        )})`;
  const marked = await db
    .update(garment)
    .set({
      suggestedAt: sql`now()`,
      suggestedByTokenId: provenance.tokenId,
      suggestionGroupId: provenance.groupId,
      suggestionNote: provenance.note,
      suggestionRank: provenance.rank,
    })
    .where(
      and(
        eq(garment.id, garmentId),
        eq(garment.ownerId, ownerId),
        onWishlist(),
        isNull(garment.suggestedAt),
        groupOk,
      ),
    )
    .returning({ id: garment.id });
  return marked.length === 1 ? 'marked' : 'refused';
}
