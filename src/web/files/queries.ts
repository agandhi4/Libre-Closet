import { eq, sql } from 'drizzle-orm';
import { CUTOUT_QUEUED_NOTIFY } from '../../cutout/queries';
import {
  type CutoutStatus,
  type InitialCutoutColumns,
  showsCutout,
} from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file, garment } from '../../db/schema';
import type { PlinthPhoto } from './image-url';

/**
 * A `file` row's columns for imageUrl (an ImageRef): the name, the version
 * and the variant key its URL signs, so /file/** serves it without a
 * statement. Every query that feeds a photo to imageUrl selects these (as a
 * left join's `photo`) or builds photoRefJson; an outfit selfie's never
 * does (selfieUrl).
 */
export const PHOTO_REF_COLUMNS = {
  fileName: file.fileName,
  version: file.version,
  variantKey: file.variantKey,
};

/** PHOTO_REF_COLUMNS for a relational query's `with: { photo: ... }`. */
export const PHOTO_REF_RELATION = {
  columns: { fileName: true, version: true, variantKey: true },
} as const;

/**
 * PHOTO_REF_COLUMNS as a JSON object, for a photo inside a json_agg or a
 * json_build_object; null when the left join found no `file` row (a garment
 * without a photo).
 */
export const photoRefJson = sql`case when ${file.id} is null then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}) end`;

/**
 * A left-joined `file` row's columns for a photo the plinth draws (the
 * wardrobe grid's tiles, the capsule strips): select them as the row's
 * `photo`, then map it through plinthPhoto.
 */
export const PLINTH_PHOTO_COLUMNS = {
  ...PHOTO_REF_COLUMNS,
  cutoutStatus: file.cutoutStatus,
};

export function plinthPhoto(
  photo: {
    fileName: string;
    version: number;
    variantKey: string | null;
    cutoutStatus: CutoutStatus;
  } | null,
): PlinthPhoto | null {
  if (!photo) return null;
  const { cutoutStatus, ...ref } = photo;
  return { ...ref, cutout: showsCutout(cutoutStatus) };
}

/**
 * A `file` row's StoredPhoto (image-variant.ts): what serving or deleting
 * its bytes needs. Every query that hands a photo to Photos.getVariant,
 * copy or deleteVariants selects these.
 */
export const STORED_PHOTO_COLUMNS = {
  fileName: file.fileName,
  variantKey: file.variantKey,
};

/** The row's variant key; undefined when no row has that name. */
export async function findVariantKey(
  q: Queryable,
  fileName: string,
): Promise<string | null | undefined> {
  const [row] = await q
    .select({ variantKey: file.variantKey })
    .from(file)
    .where(eq(file.fileName, fileName));
  return row?.variantKey;
}

/**
 * A photo's `file` row as Photos returns it after writing the bytes, not yet
 * inserted: the caller commits it in the transaction that also points a
 * garment at it (insertPhotoRow with its tx), and calls deleteVariants if
 * that transaction fails. Version starts at the column default, 1.
 */
export interface NewPhotoRow {
  fileName: string;
  shareableId: string;
  /** ISO timestamp as text, as the column has always held it. */
  createdOn: string;
  createdById: number;
}

/**
 * Inserts the row inside the caller's transaction; returns its id. The
 * cutout columns (initialCutoutState) default to `none`; a pending row
 * notifies the cutout queues on commit, whichever process inserts it.
 */
export async function insertPhotoRow(
  q: Queryable,
  row: NewPhotoRow & Partial<InitialCutoutColumns>,
): Promise<number> {
  const [inserted] = await q
    .insert(file)
    .values(row)
    .returning({
      id: file.id,
      ...(row.cutoutStatus === 'pending' && { notified: CUTOUT_QUEUED_NOTIFY }),
    });
  return inserted.id;
}

/**
 * Serializes every transaction that decides the fate of a stored name that
 * may have no row yet (a link import's pending photo: claimed by a garment
 * save, or discarded when another photo is picked). A row cannot be locked
 * before it exists, so the name itself is: a transaction-scoped advisory
 * lock, released at commit or rollback.
 */
export async function lockPhotoName(
  tx: Queryable,
  fileName: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`closet:photo:${fileName}`}))`,
  );
}

export async function photoRowExists(
  q: Queryable,
  fileName: string,
): Promise<boolean> {
  const [row] = await q
    .select({ id: file.id })
    .from(file)
    .where(eq(file.fileName, fileName))
    .limit(1);
  return row !== undefined;
}

/**
 * The stored name behind a share link's image (the watermark route): a
 * garment's photo, the only kind a share page shows. Any other row (an
 * outfit selfie, #19, whose share id is never rendered) is not found.
 */
export async function findPhotoByShareableId(
  db: Db,
  shareableId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ fileName: file.fileName })
    .from(file)
    .innerJoin(garment, eq(garment.photoId, file.id))
    .where(eq(file.shareableId, shareableId))
    .limit(1);
  return row?.fileName;
}
