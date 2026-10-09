import type { AwayReason } from './availability';
import type { GarmentStatus } from './status';

/**
 * What a garment's status mark can say, in the order a badge shows them:
 * the first is the one in words, the rest go to screen readers. Status
 * first (not owned yet, owned once), then why an owned garment cannot be
 * worn now (away, then the wash). `set-aside` is a Muse pick the owner
 * turned down and stands in for `to-buy`, so the two never meet; only a
 * wishlist garment is set aside (buying one keeps its `dismissedAt`).
 *
 * The badge itself (one daisyUI variant and one string per mark) is
 * `<GarmentMark>`, src/web/layout/garment-mark.tsx; this is the rule every
 * surface derives its marks with, so a mark means the same thing on each.
 */
export const GARMENT_MARKS = [
  'to-buy',
  'archived',
  'away:lent',
  'away:repair',
  'needs-wash',
  'set-aside',
] as const;
export type GarmentMarkKind = (typeof GARMENT_MARKS)[number];

/**
 * What a surface knows of a garment. Status is always read; the rest is
 * optional because a surface marks only what it already reads (the grid
 * reads away and the wash for the owner, Muse reads setAside, Styling
 * neither): an absent field is no mark, never a guess.
 */
export interface MarkedGarment {
  status: GarmentStatus;
  away?: AwayReason | null;
  needsWash?: boolean;
  setAside?: boolean;
}

export interface MarkOptions {
  /**
   * The wardrobe's owner is looking. Away and the wash are the owner's own
   * records: a viewer of a shared wardrobe never gets those marks, even
   * when the surface passes them.
   */
  ownerView: boolean;
}

export function garmentMarks(
  garment: MarkedGarment,
  { ownerView }: MarkOptions,
): GarmentMarkKind[] {
  const marks: GarmentMarkKind[] = [];
  if (garment.status === 'wishlist' && !garment.setAside) marks.push('to-buy');
  if (garment.status === 'archived') marks.push('archived');
  if (ownerView && garment.away) marks.push(`away:${garment.away}`);
  if (ownerView && garment.needsWash) marks.push('needs-wash');
  if (garment.status === 'wishlist' && garment.setAside)
    marks.push('set-aside');
  return marks;
}
