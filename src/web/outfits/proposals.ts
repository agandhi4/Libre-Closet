import { and, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  file,
  garment,
  outfit,
  outfitSlot,
  personalAccessToken,
} from '../../db/schema';
import type { GarmentStatus } from '../../wardrobe/status';
import { photoRefJson } from '../files/queries';
import type { SignablePhotoRef } from '../files/image-url';
import type { OutfitCount } from '../../wardrobe/goes-with';
import {
  type LookReaction,
  type LookReactionEvent,
  lookReactionTransition,
} from '../../wardrobe/look-reaction';
import type { OutfitDismissReason } from '../../wardrobe/suggestions';
import { ownerTransaction } from '../auth/queries';
import { unlocksOf } from '../gallery/ideas';
import {
  goesWithManyInputsSql,
  type ManyGoesWithInputsJson,
  readManyGoesWithInputs,
} from '../gallery/queries';
import { onWishlist } from '../wardrobe/status';
import { outfitIsComplete, ownersOutfit } from './references';

/**
 * Muse's outfits (#335, docs/plans/2026-10-05-muse-suggestions.md section
 * 4 B): ordinary outfits the owner's agent proposed (outfit.proposed_at),
 * with its note and the owner's reaction (src/wardrobe/look-reaction.ts,
 * reused from plan looks: proposed, loved, revise, declined). Which list an
 * outfit is on is derived, never stored:
 * - **the owner's** (`ownersOutfit`): never proposed, or a proposal loved
 *   while complete ("Save" is Love on a complete outfit). The Saved grid,
 *   the pickers, the garment page's strip.
 * - **from Muse** (`awaitingOwner`): proposed or sent back, or loved but
 *   still holding a piece to buy. The Outfits tab's first section.
 * - **set aside**: declined, with a reason. Collapsed under it, to undo.
 * Bought it moves a loved outfit from Muse's to the owner's by itself.
 */

/** Muse's proposals still waiting on the owner, and those set aside: not the owner's. */
function museOutfit(): SQL {
  return sql`(${isNotNull(outfit.proposedAt)} and not ${ownersOutfit()})`;
}

/** A piece of a Muse outfit as its card shows it: what it is, and if to buy, its price and whether it was set aside. */
export interface MusePiece {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
  price: string | null;
  /** A pick the owner set aside: the outfit "needs a replacement". */
  setAside: boolean;
  photo: SignablePhotoRef | null;
}

/** A Muse outfit as its card shows it. */
export interface MuseOutfit {
  id: number;
  name: string | null;
  note: string | null;
  reaction: LookReaction;
  ownerNote: string | null;
  dismissedReason: OutfitDismissReason | null;
  /** The token's name ("Muse"); null once the token is gone. */
  agent: string | null;
  pieces: MusePiece[];
}

/** An outfit's pieces in slot order (empty slots show nothing), for a scalar subquery over `outfit`. */
function musePiecesSql(): SQL<MusePiece[]> {
  return sql<MusePiece[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${garment.id},
      'name', ${garment.name},
      'category', ${garment.category},
      'status', ${garment.status},
      'price', ${garment.price},
      'setAside', ${garment.dismissedAt} is not null,
      'photo', ${photoRefJson}
    ) order by ${outfitSlot.position}), '[]')
    from ${outfitSlot}
    inner join ${garment} on ${eq(garment.id, outfitSlot.garmentId)}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${eq(outfitSlot.outfitId, outfit.id)}
  )`;
}

/**
 * The owner's Muse outfits not theirs yet (awaiting them, or set aside),
 * newest proposal first, as one scalar subquery for savedContext's
 * statement. Raw SQL, so `outfit` renders qualified (references.ts).
 */
export function museOutfitsSql(ownerId: number): SQL<MuseOutfit[]> {
  return sql<MuseOutfit[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfit.id},
      'name', ${outfit.name},
      'note', ${outfit.proposalNote},
      'reaction', ${outfit.reaction},
      'ownerNote', ${outfit.ownerNote},
      'dismissedReason', ${outfit.dismissedReason},
      'agent', (select ${personalAccessToken.name} from ${personalAccessToken} where ${eq(personalAccessToken.id, outfit.proposedByTokenId)}),
      'pieces', ${musePiecesSql()}
    ) order by ${outfit.proposedAt} desc, ${outfit.id} desc), '[]')
    from ${outfit}
    where ${and(eq(outfit.ownerId, ownerId), museOutfit())}
  )`;
}

/**
 * The pieces to buy of the owner's Muse outfits, with the closet and the
 * avoided pairs once, to count what each unlocks (unlocksOf: the inbox's
 * "Unlocks N", #333). For savedContext's statement.
 */
export function museUnlocksInputsSql(
  ownerId: number,
): SQL<ManyGoesWithInputsJson> {
  return goesWithManyInputsSql(
    ownerId,
    sql`${garment.id} in (select ${outfitSlot.garmentId} from ${outfitSlot} inner join ${outfit} on ${eq(outfit.id, outfitSlot.outfitId)} where ${and(eq(outfit.ownerId, ownerId), museOutfit(), onWishlist())})`,
  );
}

/** museUnlocksInputsSql's answer: each piece to buy's count. */
export function readMuseUnlocks(
  json: ManyGoesWithInputsJson,
): Map<number, OutfitCount> {
  return unlocksOf(readManyGoesWithInputs(json));
}

/** Which of Muse's outfits a section shows: awaiting the owner, or set aside. */
export function isSetAside(item: Pick<MuseOutfit, 'reaction'>): boolean {
  return item.reaction === 'declined';
}

/** The owner's reactions on the Outfits tab (the agent's own moves are its tools', phase 3). */
export type OutfitReaction =
  | { event: 'love' }
  | { event: 'decline'; reason: OutfitDismissReason; note: string | null }
  | { event: 'reconsider' };

export type ReactOutcome =
  | {
      ok: true;
      from: LookReaction;
      to: LookReaction;
      /** Every piece owned: Love is "Save", the outfit the owner's now. */
      complete: boolean;
    }
  /** Not the owner's outfit, or no proposal: a 404 like an unknown id. */
  | { ok: false; reason: 'not-found' }
  /** The reaction does not take the move (a stale page, a double tap): a 409. */
  | { ok: false; reason: 'not-allowed'; reaction: LookReaction };

/**
 * The one writer of a Muse outfit's reaction: under the owner lock, the
 * outfit locked, the machine asked (lookReactionTransition), then one
 * update: the reaction, the owner's note as the move says (written with
 * Not for me, cleared by Love and Undo), the reason only while declined,
 * and when (`reacted_at`, the agent's "feedback since", phase 3).
 */
export function reactToOutfit(
  db: Queryable,
  ownerId: number,
  outfitId: number,
  change: OutfitReaction,
): Promise<ReactOutcome> {
  return ownerTransaction(db, ownerId, 'reactToOutfit', async (tx) => {
    const [row] = await tx
      .select({
        reaction: outfit.reaction,
        ownerNote: outfit.ownerNote,
        // A parameter, never the column: this select names one table.
        complete: outfitIsComplete(sql`${outfitId}::int`),
      })
      .from(outfit)
      .where(and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId)))
      .for('update');
    if (!row?.reaction) return { ok: false, reason: 'not-found' };
    const event: LookReactionEvent = change.event;
    const move = lookReactionTransition(row.reaction, event);
    if (!move.ok) {
      return { ok: false, reason: 'not-allowed', reaction: move.reaction };
    }
    const written = change.event === 'decline' ? change.note : null;
    await tx
      .update(outfit)
      .set({
        reaction: move.to,
        ownerNote:
          move.note === 'write'
            ? written
            : move.note === 'clear'
              ? null
              : row.ownerNote,
        dismissedReason: change.event === 'decline' ? change.reason : null,
        reactedAt: sql`now()`,
      })
      .where(eq(outfit.id, outfitId));
    return { ok: true, from: move.from, to: move.to, complete: row.complete };
  });
}
