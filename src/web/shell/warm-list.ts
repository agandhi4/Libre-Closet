import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { GarmentStatus } from '../../wardrobe/status';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import { weekOf } from '../calendar/calendar-view';
import { weekUrl } from '../calendar/urls';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { savedOutfitsSql } from '../outfits/queries';
import { outfitUrl } from '../outfits/urls';
import { TAB_ROOTS } from '../page-cache';
import { GRID_PAGE_SIZE } from '../wardrobe/queries';
import { inCloset, onWishlist } from '../wardrobe/status';
import { garmentUrl } from '../wardrobe/urls';
import { EMPTY_SEARCH, tilesUrl } from '../wardrobe/wardrobe-page';
import type { WarmList } from './offline-warm';

/**
 * Caps on what one device warms (docs/plans/2026-09-28-caching-and-offline.md,
 * section 2): the newest first, about 20 MB at the cap. The demo wardrobe
 * (83 garments, 26 outfits) is well under both.
 */
export const WARM_GARMENT_CAP = 300;
export const WARM_OUTFIT_CAP = 80;

/**
 * The warm list of `ownerId`'s own wardrobe (#286): the tab roots, this
 * week and the next, every closet garment's page and every outfit's (newest
 * first, capped), the closet grid's later pages, and the thumbs they show.
 * Always the requester's own: a grantee's device never warms a wardrobe
 * shared with them. One statement: the garments still owned or wished for,
 * and every outfit with its garments' photos (what the Saved tab reads).
 */
export async function warmList(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<WarmList> {
  const { garments, outfits } = await selectScalars(db, {
    garments: ownGarmentsSql(ownerId),
    outfits: savedOutfitsSql(ownerId),
  });
  const closet = garments.filter((row) => row.status === 'closet');
  const warmed = closet.slice(0, WARM_GARMENT_CAP);
  const warmedIds = new Set(warmed.map((row) => row.id));
  const warmedOutfits = outfits.slice(0, WARM_OUTFIT_CAP);

  const thumbs = new Set<string>();
  const addThumb = (photo: SignablePhotoRef | null) => {
    if (photo) thumbs.add(imageUrl(photo, 'thumb'));
  };
  warmed.forEach((row) => addThumb(row.photo));
  warmedOutfits.forEach((row) =>
    row.garments.forEach((g) => addThumb(g.photo)),
  );

  return {
    pages: [
      ...TAB_ROOTS,
      weekUrl(addDays(weekOf(today).start, 7)),
      ...warmed.map((row) => garmentUrl(row.id, undefined)),
      ...warmedOutfits.map((row) => outfitUrl(row.id)),
    ],
    fragments: gridPageCursors(closet.map((row) => row.id))
      .filter((before) => warmedIds.has(before))
      .map((before) => tilesUrl(undefined, EMPTY_SEARCH, before)),
    images: [...thumbs],
    keep: [
      ...garments
        .filter((row) => !warmedIds.has(row.id))
        .map((row) => garmentUrl(row.id, undefined)),
      ...outfits.slice(WARM_OUTFIT_CAP).map((row) => outfitUrl(row.id)),
    ],
  };
}

interface OwnGarment {
  id: number;
  status: GarmentStatus;
  photo: SignablePhotoRef | null;
}

/**
 * The owner's closet and wishlist garments, newest first, with their
 * photos. Archived ones are left out, so their cached pages go.
 */
function ownGarmentsSql(ownerId: number): SQL<OwnGarment[]> {
  return sql<OwnGarment[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'status', ${garment.status},
          'photo', ${photoRefJson}
        )
        order by ${garment.id} desc
      ),
      '[]'
    )
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(eq(garment.ownerId, ownerId), or(inCloset(), onWishlist()))}
  )`;
}

/**
 * Each later grid page's `before`, as gridPage pages the closet: newest
 * first, GRID_PAGE_SIZE a page, and a page after every full one that has
 * more behind it. `ids` is the whole closet, newest first.
 */
function gridPageCursors(ids: number[]): number[] {
  const cursors: number[] = [];
  for (let end = GRID_PAGE_SIZE; end < ids.length; end += GRID_PAGE_SIZE) {
    cursors.push(ids[end - 1]);
  }
  return cursors;
}
