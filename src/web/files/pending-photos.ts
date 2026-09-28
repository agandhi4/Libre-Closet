import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { pendingPhoto } from '../../db/schema';

/**
 * Pending photos: bytes stored before the garment form that will own them
 * is saved, and the `pending_photo` row that explains them. Three sources
 * store them (src/web/wardrobe/writes.ts): link import's fetched photo
 * (issue #6) and the add sheet's camera or one-photo library upload (#97),
 * kept one at a time by keepPendingPhoto; and a library pick of several,
 * kept together as a batch of drafts by recordDraftBatch (#200). The row names the user who stored the photo; only that user may
 * claim it (the save, src/web/wardrobe/writes.ts) or discard it (another
 * pick). Reconciliation removes the ones left a day
 * (src/maintenance/reconcile.ts), counted apart from its deletion guard:
 * an abandoned import is routine, not the database and the disk
 * disagreeing. Account deletion removes a user's with their photos.
 *
 * Nothing here touches bytes: the callers delete a returned name's
 * variants through Photos, after their transaction commits.
 */

/**
 * Unbatched pending photos one user may hold; storing another evicts the
 * oldest. Batched drafts are not counted here and never evicted.
 */
export const MAX_PENDING_PER_USER = 10;

/**
 * Batched drafts one user may hold (#200): two batches of 15. An upload
 * that would pass it is refused whole (recordDraftBatch), never evicting a
 * draft, so a batch loses nothing it was not told about.
 */
export const MAX_DRAFTS_PER_USER = 30;

/**
 * Serializes one user's pending-photo writes: two uploads at once cannot
 * both keep an eleventh unbatched photo or a thirty-first draft.
 */
async function lockUserPending(tx: Queryable, userId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`closet:pending-photos:${userId}`}))`,
  );
}

/**
 * Records `fileName` (just stored) as `userId`'s pending photo and returns
 * the names evicted to keep their unbatched ones within
 * MAX_PENDING_PER_USER, oldest first: their rows are gone, and the caller
 * deletes their bytes. Drafts of a batch are never evicted.
 */
export function recordPendingPhoto(
  db: Db,
  fileName: string,
  userId: number,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockUserPending(tx, userId);
    await tx.insert(pendingPhoto).values({ fileName, userId });
    const unbatched = and(
      eq(pendingPhoto.userId, userId),
      isNull(pendingPhoto.batchId),
    );
    const kept = tx
      .select({ fileName: pendingPhoto.fileName })
      .from(pendingPhoto)
      .where(unbatched)
      .orderBy(desc(pendingPhoto.createdAt), desc(pendingPhoto.fileName))
      .limit(MAX_PENDING_PER_USER);
    const evicted = await tx
      .delete(pendingPhoto)
      .where(and(unbatched, sql`${pendingPhoto.fileName} not in ${kept}`))
      .returning({ fileName: pendingPhoto.fileName });
    return evicted.map((row) => row.fileName);
  });
}

/** The drafts `userId` holds, in every batch (the upload's room left). */
export async function draftsHeld(
  db: Queryable,
  userId: number,
): Promise<number> {
  const [row] = await db
    .select({ held: count() })
    .from(pendingPhoto)
    .where(
      and(eq(pendingPhoto.userId, userId), isNotNull(pendingPhoto.batchId)),
    );
  return row?.held ?? 0;
}

/**
 * Records `fileNames` (just stored, in the order picked) as one batch of
 * `userId`'s drafts for `ownerId`'s wardrobe: its id, or `refused` with the
 * drafts they already hold when the batch would take them past
 * MAX_DRAFTS_PER_USER. Nothing is written then; the caller deletes the
 * bytes and says so.
 */
export function recordDraftBatch(
  db: Db,
  fileNames: readonly string[],
  userId: number,
  ownerId: number,
): Promise<{ batchId: string } | { refused: { held: number } }> {
  return db.transaction(async (tx) => {
    await lockUserPending(tx, userId);
    const held = await draftsHeld(tx, userId);
    if (held + fileNames.length > MAX_DRAFTS_PER_USER) {
      return { refused: { held } };
    }
    const batchId = randomUUID();
    await tx.insert(pendingPhoto).values(
      fileNames.map((fileName, position) => ({
        fileName,
        userId,
        batchId,
        batchPosition: position,
        batchOwnerId: ownerId,
      })),
    );
    return { batchId };
  });
}

/** A draft: which batch, and its place there. */
export interface Draft {
  batchId: string;
  position: number;
}

/** The drafts of `batchId` still waiting, in the order they were picked. */
export async function batchDrafts(
  db: Queryable,
  userId: number,
  batchId: string,
): Promise<{ fileName: string; position: number }[]> {
  const rows = await db
    .select({
      fileName: pendingPhoto.fileName,
      position: pendingPhoto.batchPosition,
    })
    .from(pendingPhoto)
    .where(
      and(eq(pendingPhoto.userId, userId), eq(pendingPhoto.batchId, batchId)),
    )
    .orderBy(asc(pendingPhoto.batchPosition));
  return rows.map((row) => ({
    fileName: row.fileName,
    position: row.position ?? 0,
  }));
}

/**
 * `userId`'s drafts waiting for `ownerId`'s wardrobe (the grid's prompt):
 * how many, and the first of the oldest batch, where Continue opens. One
 * row: the count is a window over the whole match, taken before the limit.
 */
export async function draftsWaiting(
  db: Queryable,
  userId: number,
  ownerId: number,
): Promise<{ count: number; first: string } | undefined> {
  const [row] = await db
    .select({
      first: pendingPhoto.fileName,
      count: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(pendingPhoto)
    .where(
      and(
        eq(pendingPhoto.userId, userId),
        eq(pendingPhoto.batchOwnerId, ownerId),
      ),
    )
    .orderBy(
      asc(pendingPhoto.createdAt),
      asc(pendingPhoto.batchId),
      asc(pendingPhoto.batchPosition),
    )
    .limit(1);
  return row;
}

/**
 * Deletes the pending row of `fileName` if `userId` fetched it; false when
 * there is none for that user (someone else's, claimed, discarded, evicted
 * or reconciled). Inside the claim's or the discard's transaction: the row
 * lock orders it against any other taker, so exactly one wins.
 */
export async function takePendingPhoto(
  tx: Queryable,
  fileName: string,
  userId: number,
): Promise<boolean> {
  const taken = await tx
    .delete(pendingPhoto)
    .where(
      and(eq(pendingPhoto.fileName, fileName), eq(pendingPhoto.userId, userId)),
    )
    .returning({ fileName: pendingPhoto.fileName });
  return taken.length > 0;
}

/**
 * `fileName` while it is still `userId`'s pending photo, with its batch and
 * place when it is a draft (#200); undefined otherwise. The new garment
 * form started from an upload shows the photo only then (GET
 * /wardrobe/new?photo=), and a save reads the batch before its claim to
 * know where the queue goes next. Only a hint: the claim is the check that
 * counts.
 */
export async function pendingPhotoOf(
  db: Queryable,
  fileName: string,
  userId: number,
): Promise<{ draft: Draft | undefined } | undefined> {
  const [row] = await db
    .select({
      batchId: pendingPhoto.batchId,
      position: pendingPhoto.batchPosition,
    })
    .from(pendingPhoto)
    .where(
      and(eq(pendingPhoto.fileName, fileName), eq(pendingPhoto.userId, userId)),
    );
  if (!row) return undefined;
  const { batchId, position } = row;
  return {
    draft:
      batchId !== null && position !== null ? { batchId, position } : undefined,
  };
}

/** Deletes the pending rows created before `cutoff`; their names (reconciliation). */
export async function takeAgedPendingPhotos(
  db: Db,
  cutoff: Date,
): Promise<string[]> {
  const taken = await db
    .delete(pendingPhoto)
    .where(lt(pendingPhoto.createdAt, cutoff))
    .returning({ fileName: pendingPhoto.fileName });
  return taken.map((row) => row.fileName);
}

/** Every pending row (reconciliation's plan). */
export function pendingPhotoRows(
  db: Db,
): Promise<{ fileName: string; createdAt: Date }[]> {
  return db
    .select({
      fileName: pendingPhoto.fileName,
      createdAt: pendingPhoto.createdAt,
    })
    .from(pendingPhoto);
}

/** Deletes one pending row, whoever it belongs to (reconciliation: its bytes are gone). */
export async function deletePendingPhotoRow(
  db: Db,
  fileName: string,
): Promise<void> {
  await db.delete(pendingPhoto).where(eq(pendingPhoto.fileName, fileName));
}
