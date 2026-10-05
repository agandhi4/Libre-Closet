import type {
  PlanItemReview,
  PlanItemReviewEvent,
} from '../../wardrobe/plan-review';
import { ownerTransaction } from '../auth/queries';
import type { StoredPhoto } from '../files/image-variant';
import type { WardrobeDeps } from '../wardrobe/writes';
import { agentChangedAtOf, findPlan, itemsOf, reviewItems } from './queries';
import {
  applyRelease,
  dropPhotos,
  type ReleaseChoice,
  releasedCandidates,
} from './review';

/**
 * The owner's decisions on one item, from its sheet on the plan page (#315):
 * each posts as it is made, through the plan item's own review writer
 * (`reviewItems`, one transition per call) and the review's release rule
 * (`releasedCandidates`, `applyRelease`: the one place a candidate leaves
 * an item or the wishlist by a review). The review page's "Accept these"
 * (review.ts) ends in the same two. Nothing here writes a review state of
 * its own.
 *
 * Every decision carries `asOf`, the item's `agent_changed_at` as the page
 * drew it: an agent that rewrote the item since (update_plan_item) makes
 * the decision `stale`, nothing is written, and the owner looks again. A
 * post without it (the plan page's other moves, Reconsider) is unguarded.
 */

export type ItemDecision = {
  event: PlanItemReviewEvent;
  note?: string | null;
  asOf?: number | null;
  /**
   * With `accept`: the candidate the owner picked, the one kept when
   * `removeUnpicked`. Null: Keep, which lets go of nothing.
   */
  pick?: number | null;
  /** "Remove the products I didn't pick from my wishlist": the owner's box, unticked by default. */
  removeUnpicked?: boolean;
  /** The candidates the sheet drew: the only ones `removeUnpicked` lets go (ReleaseChoice). */
  offered?: readonly number[];
};

export type DecisionOutcome =
  | { kind: 'not-found' }
  /** The agent rewrote the item since the page was drawn. */
  | { kind: 'stale' }
  /** The item's review does not take the event: it moved already. */
  | { kind: 'refused'; review: PlanItemReview }
  | { kind: 'moved'; removed: number[]; kept: number[] };

type Deps = Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>;

/** What a release deleted from the wishlist, photos still to drop after the commit. */
interface Released {
  removed: { id: number; photo: StoredPhoto | null }[];
  kept: number[];
}

const NOTHING_RELEASED: Released = { removed: [], kept: [] };

/**
 * `decision` on item `itemId` of the owner's plan `planId`, with the
 * release it asks for (accept with a pick, or decline, and
 * `removeUnpicked`), in one owner transaction: either the move and the
 * release land, or neither does. Photos of deleted products go after the
 * commit.
 */
export async function decideItem(
  deps: Deps,
  ownerId: number,
  planId: number,
  itemId: number,
  decision: ItemDecision,
): Promise<DecisionOutcome> {
  const { db, photos } = deps;
  const result = await ownerTransaction(
    db,
    ownerId,
    'decideItem',
    async (
      tx,
    ): Promise<DecisionOutcome | { kind: 'released'; released: Released }> => {
      const { moved, stale, refused } = await reviewItems(
        tx,
        ownerId,
        planId,
        decision.event,
        [{ itemId, note: decision.note, asOf: decision.asOf }],
      );
      if (stale.length > 0) return { kind: 'stale' };
      if (refused.length > 0) {
        return { kind: 'refused', review: refused[0].review };
      }
      if (moved.length === 0) return { kind: 'not-found' };
      // Keep lets go of nothing: only a pick, or Don't buy, judges the rest.
      const pick = decision.pick ?? null;
      const judges = decision.event === 'decline' || pick !== null;
      if (!decision.removeUnpicked || !judges) {
        return { kind: 'released', released: NOTHING_RELEASED };
      }
      const choice: ReleaseChoice = {
        pick:
          pick === null
            ? { kind: 'decline' }
            : { kind: 'candidate', garmentId: pick },
        offered: decision.offered ?? [],
        rejected: new Map(),
      };
      const release = await releasedCandidates(
        tx,
        ownerId,
        [itemId],
        new Map([[itemId, choice]]),
        true,
      );
      return {
        kind: 'released',
        released: await applyRelease(tx, ownerId, release),
      };
    },
  );
  if (result.kind !== 'released') return result;
  const { removed, kept } = result.released;
  await dropPhotos(photos, removed);
  return { kind: 'moved', removed: removed.map(({ id }) => id), kept };
}

export type RejectionOutcome =
  | { kind: 'not-found' }
  | { kind: 'stale' }
  /** The item is no longer a proposal: a decision was made meanwhile. */
  | { kind: 'refused'; review: PlanItemReview }
  /** The product is no candidate of the item (any more): bought, removed or unlinked since the page was drawn. */
  | { kind: 'not-a-candidate' }
  | { kind: 'rejected'; deleted: boolean };

/**
 * "Not this one" on one candidate of a proposed item: records the product
 * and the reason (plan_item_rejection) and lets it go by the review's
 * release rule (deleted from the wishlist when it stands for no other plan
 * item and no look, outfit or capsule holds it, else unlinked from this
 * one). The item stays proposed: rejecting one option is not deciding the
 * item. `asOf` guards as a decision's does.
 */
export async function rejectCandidate(
  deps: Deps,
  ownerId: number,
  planId: number,
  itemId: number,
  garmentId: number,
  input: { reason: string | null; asOf?: number | null },
): Promise<RejectionOutcome> {
  const { db, photos } = deps;
  const result = await ownerTransaction(
    db,
    ownerId,
    'rejectCandidate',
    async (
      tx,
    ): Promise<RejectionOutcome | { kind: 'released'; released: Released }> => {
      if (!(await findPlan(tx, planId, ownerId))) return { kind: 'not-found' };
      const item = (await itemsOf(tx, [planId])).find((i) => i.id === itemId);
      if (!item) return { kind: 'not-found' };
      if (input.asOf !== undefined && input.asOf !== agentChangedAtOf(item)) {
        return { kind: 'stale' };
      }
      if (item.review !== 'proposed') {
        return { kind: 'refused', review: item.review };
      }
      const choice: ReleaseChoice = {
        pick: { kind: 'keep' },
        offered: [garmentId],
        rejected: new Map([[garmentId, input.reason]]),
      };
      const release = await releasedCandidates(
        tx,
        ownerId,
        [itemId],
        new Map([[itemId, choice]]),
        false,
      );
      if (release.rejected.length === 0) return { kind: 'not-a-candidate' };
      const released = await applyRelease(tx, ownerId, release);
      return { kind: 'released', released };
    },
  );
  if (result.kind !== 'released') return result;
  await dropPhotos(photos, result.released.removed);
  return { kind: 'rejected', deleted: result.released.removed.length > 0 };
}
