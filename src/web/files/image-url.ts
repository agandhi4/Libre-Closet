import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type ImageVariant, type StoredPhoto } from './image-variant';

/**
 * A photo a share may show (a garment's, or a pending photo shown to the
 * user who stored it) as its URL names it: the stored set its row points at
 * (StoredPhoto: select PHOTO_REF_COLUMNS, src/web/files/queries.ts) and
 * `file.version`. The variant key is required on purpose: an outfit
 * selfie's query selects none (SelfiePhoto), so a selfie cannot reach
 * imageUrl, whose signature is what lets /file/** serve without asking the
 * database whether a name is a selfie.
 */
export interface ImageRef extends StoredPhoto {
  version?: number;
}

/**
 * A garment's photo as the plinth draws it (PlinthImage, layout/parts.tsx):
 * `cutout` is showsCutout of its cutout status (src/cutout/state.ts).
 */
export interface PlinthPhoto extends ImageRef {
  cutout: boolean;
}

/** An outfit selfie's photo (#19): never keyed, never under /file/**. */
export interface SelfiePhoto {
  fileName: string;
  version?: number;
}

// The single source of truth for photo paths (/file/** and /selfies/*), for
// JSX views and view-models that pre-build URLs. The routes are in
// routes.ts beside this file and src/web/selfies/routes.ts, and must stay
// in step.
//
// A /file URL names the exact files it shows: `v` (File.version), `k` (the
// variant key, absent while unkeyed) and `s`, a signature over the name,
// key and version (signedPhoto). The route serves a verified URL's files
// straight from storage, without a statement, so the bytes behind one URL
// never change: every variant is immutable for a year. The signature does
// not depend on the variant, so a photo's three URLs differ only in their
// path.
export function imageUrl(image: ImageRef, variant: ImageVariant): string {
  const version = image.version ?? 1;
  const key = image.variantKey === null ? '' : `&k=${image.variantKey}`;
  const signature = photoSignature(image.fileName, image.variantKey, version);
  return `${variantPath('/file', image.fileName, variant)}?v=${version}${key}&s=${signature}`;
}

/**
 * An outfit selfie's URL (#19): served only to its owner by
 * src/web/selfies/routes.ts, never under the public /file/** (which
 * refuses selfie names). A selfie keeps its background, so it has no nobg.
 */
export function selfieUrl(
  image: SelfiePhoto,
  variant: Exclude<ImageVariant, 'nobg'>,
): string {
  return `${variantPath('/selfies', image.fileName, variant)}?v=${image.version ?? 1}`;
}

function variantPath(
  root: string,
  fileName: string,
  variant: ImageVariant,
): string {
  const prefix = variant === 'original' ? root : `${root}/${variant}`;
  return `${prefix}/${encodeURIComponent(fileName)}`;
}

// Until createApp configures it (configurePhotoUrls), a key of this process
// alone: URLs it signs verify here and nowhere else, which is all a unit
// spec rendering a view needs. Process-wide because imageUrl is called from
// views and view-models that have no app to ask.
let signingKey: Buffer = randomBytes(32);

// 96 bits: forging one means guessing it over the network, one request each.
const SIGNATURE_BYTES = 12;
const SIGNATURE = /^[A-Za-z0-9_-]{16}$/;
const VARIANT_KEY = /^[0-9a-f]{12}$/;
const VERSION = /^[1-9][0-9]{0,9}$/;

/**
 * Derives the /file URL signing key from ACCESS_TOKEN_SECRET (createApp).
 * Rotating that secret changes every photo URL: URLs signed before it are
 * served through the row lookup until their pages are rendered again,
 * so nothing breaks, and devices download each photo once more.
 */
export function configurePhotoUrls(secret: string): void {
  signingKey = createHmac('sha256', secret)
    .update('closet /file URL signature v1')
    .digest();
}

function photoSignature(
  fileName: string,
  variantKey: string | null,
  version: number,
): string {
  return createHmac('sha256', signingKey)
    .update(`${fileName}\n${variantKey ?? ''}\n${version}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

/** A /file URL's query as the route reads it: each value is whatever was sent. */
export interface PhotoUrlQuery {
  v?: string;
  k?: string;
  s?: string;
}

/**
 * The StoredPhoto an imageUrl names, when its signature holds: then the
 * name is one the server rendered through imageUrl, which only photos a
 * share may show reach (never a selfie: SelfiePhoto), with the variant key its
 * row had then. Undefined for anything else (an old page's unsigned URL, a
 * URL signed under another secret, a changed parameter), which the route
 * answers through the row as it always did.
 */
export function signedPhoto(
  fileName: string,
  query: PhotoUrlQuery,
): StoredPhoto | undefined {
  const { v, k, s } = query;
  if (s === undefined || !SIGNATURE.test(s)) return undefined;
  if (v === undefined || !VERSION.test(v)) return undefined;
  if (k !== undefined && !VARIANT_KEY.test(k)) return undefined;
  const variantKey = k ?? null;
  const expected = Buffer.from(photoSignature(fileName, variantKey, Number(v)));
  const given = Buffer.from(s);
  // Same length by the pattern; constant time all the same.
  if (!timingSafeEqual(expected, given)) return undefined;
  return { fileName, variantKey };
}
