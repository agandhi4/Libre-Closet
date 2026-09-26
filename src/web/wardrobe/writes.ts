import type { MultipartFile } from '@fastify/multipart';
import {
  type InitialCutoutColumns,
  initialCutoutState,
} from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { HttpError } from '../errors';
import { parseStoredName } from '../files/image-variant';
import type { Photos } from '../files/photos';
import {
  insertPhotoRow,
  lockPhotoName,
  type NewPhotoRow,
  photoRowExists,
} from '../files/queries';
import type { Logger } from '../../logger';
import {
  deleteGarment,
  type GarmentDetail,
  insertGarment,
  lockGarment,
  replacePhotoRow,
} from './queries';
import type { GarmentFields } from './validation';

/**
 * The garment writes that involve photo bytes, which a transaction cannot
 * roll back. The contract (CLAUDE.md Gotchas, "Photo bytes are written
 * before any row"): Photos writes the bytes and returns the `file` row; the
 * row is inserted in the same transaction as the garment write that points
 * at it; if that transaction fails the new bytes are deleted, and bytes a
 * committed write replaced or orphaned are deleted after the commit.
 */

export interface WardrobeDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  /** Told when a photo was queued (src/cutout/queue.ts). */
  cutouts: { wake(): void };
}

/**
 * Runs `write` in one transaction with `photo`'s row inserted first (its id
 * handed over); if it does not commit, the photo's bytes go too.
 */
async function commitWithPhoto<T>(
  { db, photos, logger }: WardrobeDeps,
  photo: NewPhotoRow & InitialCutoutColumns,
  write: (tx: Queryable, photoId: number) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) =>
      write(tx, await insertPhotoRow(tx, photo)),
    );
  } catch (error) {
    logger.warn(`Rolled back; removing orphaned upload ${photo.fileName}`);
    await photos.deleteVariants(photo.fileName);
    throw error;
  }
}

/** A new garment in `ownerId`'s wardrobe (the form has no photo; it comes next). */
export function createGarment(
  { db }: WardrobeDeps,
  ownerId: number,
  fields: GarmentFields,
): Promise<number> {
  return insertGarment(db, ownerId, fields, null);
}

/**
 * A new garment whose photo came from a link (link import, #6). The photo's
 * bytes were stored when the link was fetched, without a row: a pending
 * photo, named by the form's hidden `linkPhoto`. Its row is inserted here,
 * queued for its cutout, in the transaction that inserts the garment, so
 * nothing is written to either table until the form is saved; a pending
 * photo never saved is removed by reconciliation after a day, like bytes
 * whose upload transaction never committed.
 *
 * Undefined when the name cannot be claimed: not a stored original, its
 * bytes gone (reconciled, or discarded by picking another photo), or
 * already a row (a saved photo, anyone's). Nothing is written then, and no
 * bytes are ever deleted here: the name came from the client, so bytes this
 * request cannot prove are its own are left alone.
 */
export async function createGarmentWithLinkPhoto(
  { db, photos, logger, cutouts }: WardrobeDeps,
  ownerId: number,
  fields: GarmentFields,
  fileName: string,
): Promise<number | undefined> {
  const id = await db.transaction(async (tx) => {
    await lockPhotoName(tx, fileName);
    if (await photoRowExists(tx, fileName)) return undefined;
    // The wardrobe's owner owns the row, whoever saves (as replacePhoto).
    const photo = await photos.pendingPhotoRow(fileName, ownerId);
    if (!photo) return undefined;
    const photoId = await insertPhotoRow(tx, {
      ...photo,
      ...initialCutoutState('pending'),
    });
    return insertGarment(tx, ownerId, fields, photoId);
  });
  if (id === undefined) {
    logger.warn(`Link photo ${fileName} could not be claimed`);
    return undefined;
  }
  logger.info(
    `Garment ${id} photo ${fileName} (from a link) queued for background removal`,
  );
  cutouts.wake();
  return id;
}

/**
 * Deletes a pending link photo the form no longer shows (another photo was
 * picked, or none). False, deleting nothing, when the name is not a stored
 * original or has a row: only a photo no garment was ever saved with goes.
 * Under the name's lock, so a save claiming it at the same moment either
 * wins (the row exists, nothing is deleted) or finds it gone.
 */
export async function discardLinkPhoto(
  { db, photos, logger }: WardrobeDeps,
  fileName: string,
): Promise<boolean> {
  if (parseStoredName(fileName)?.variant !== 'original') return false;
  const discarded = await db.transaction(async (tx) => {
    await lockPhotoName(tx, fileName);
    if (await photoRowExists(tx, fileName)) return false;
    await photos.deleteVariants(fileName);
    return true;
  });
  if (discarded) logger.info(`Discarded link photo ${fileName}`);
  return discarded;
}

/**
 * A copy of `source` in the requester's own wardrobe with the posted fields
 * and its own copy of the photo set (bytes and row), owned by the requester.
 * The copy's cutout starts where the source's is (the bytes are the same);
 * a pending one is queued in its own right.
 */
export async function cloneGarment(
  deps: WardrobeDeps,
  source: GarmentDetail,
  requesterId: number,
  fields: GarmentFields,
): Promise<number> {
  // copy() is undefined when the source's bytes are gone: a clone without a photo.
  const photo = source.photo
    ? await deps.photos.copy(source.photo.fileName, requesterId)
    : undefined;
  if (!photo || !source.photo) {
    return insertGarment(deps.db, requesterId, fields, null);
  }
  const status = source.photo.cutoutStatus;
  const id = await commitWithPhoto(
    deps,
    { ...photo, ...initialCutoutState(status) },
    (tx, photoId) => insertGarment(tx, requesterId, fields, photoId),
  );
  if (status === 'pending') deps.cutouts.wake();
  return id;
}

/**
 * POST /wardrobe/:id/photo: stores the multipart photo, queues its cutout,
 * points the garment at it and removes the photo it replaces, rows in one
 * transaction and the old bytes after it. The new `file` row belongs to the
 * wardrobe's owner, whoever uploads (their account deletion takes it). A
 * 404 when the garment left the wardrobe meanwhile, a 400 without a photo.
 */
export async function replacePhoto(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
  parts: AsyncIterable<MultipartFile>,
): Promise<void> {
  const photo = await deps.photos.storeUploadParts(parts, ownerId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  const replaced = await commitWithPhoto(
    deps,
    // The `request` event: every new photo is queued for its cutout.
    { ...photo, ...initialCutoutState('pending') },
    async (tx, photoId) => {
      const locked = await lockGarment(tx, id, ownerId);
      if (!locked) throw new HttpError(404, 'Garment not found');
      await replacePhotoRow(tx, id, photoId, locked.photoId);
      return locked.fileName;
    },
  );
  deps.logger.info(
    `Garment ${id} photo ${photo.fileName} queued for background removal`,
  );
  deps.cutouts.wake();
  if (replaced) {
    await deps.photos.deleteVariants(replaced);
    deps.logger.info(
      `Garment ${id} photo replaced: ${replaced} -> ${photo.fileName}`,
    );
  } else {
    deps.logger.info(`Garment ${id} photo added: ${photo.fileName}`);
  }
}

/**
 * Deletes the garment and its photo's row, then the photo's bytes. False
 * when the garment is not in `ownerId`'s wardrobe.
 */
export async function removeGarment(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const fileName = await deleteGarment(deps.db, id, ownerId);
  if (fileName === undefined) return false;
  // Only after commit: an unlink cannot be rolled back.
  if (fileName) await deps.photos.deleteVariants(fileName);
  return true;
}
