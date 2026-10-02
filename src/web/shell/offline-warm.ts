/**
 * What the server's warm list and the service worker's warm agree on
 * (#286; views/assets/src-sw.ts bundles this file: keep it free of Node and
 * DOM). The worker asks GET WARM_LIST_PATH for the signed-in account's own
 * wardrobe and fetches what its caches lack, so the installed app can read
 * every garment and outfit offline (src/web/shell/offline-warm.md).
 */

/** The warm list's route (src/web/shell/routes.tsx). */
export const WARM_LIST_PATH = '/offline/warm';

/**
 * On every request a warm makes (the list, each page, each thumb), so the
 * server's request log tells warming apart from a person (app.ts).
 */
export const WARM_REQUEST_HEADER = 'X-Closet-Warm';

/** A warm re-fetches a copy older than this, and runs at most this often. */
export const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A warm stops once the origin's storage use passes this. */
export const WARM_USAGE_BUDGET_BYTES = 50 * 1024 * 1024;

/**
 * The warm list: same-origin paths with their query, nothing else.
 *  - pages: whole pages (tab roots, weeks, garments, outfits);
 *  - fragments: the wardrobe grid's later pages, fetched as htmx requests so
 *    they land under the `|hx` key the grid's own scroll reads;
 *  - images: the thumbs those pages show;
 *  - keep: detail pages that still exist but are not warmed (wishlist items,
 *    pieces past the caps): a visited copy of one stays. Every other cached
 *    garment or outfit page (isWarmedDetailPage) is of a deleted or archived
 *    one, and a warm removes it.
 */
export interface WarmList {
  pages: string[];
  fragments: string[];
  images: string[];
  keep: string[];
}

// A garment's or an outfit's own page, the owner's (no ?ownerId=, so never
// a shared wardrobe's), exactly as garmentUrl and outfitUrl build them.
const DETAIL_PAGE = /^\/(?:wardrobe|outfits)\/\d+$/;

/** Whether a warm owns this cached page's fate: kept only while listed. */
export function isWarmedDetailPage(url: {
  pathname: string;
  search: string;
}): boolean {
  return url.search === '' && DETAIL_PAGE.test(url.pathname);
}

const LIST_KEYS = ['pages', 'fragments', 'images', 'keep'] as const;

/**
 * The server's answer, checked at the worker's boundary: undefined unless
 * every list is an array of root-relative paths (never another origin, never
 * a protocol-relative `//host`).
 */
export function parseWarmList(value: unknown): WarmList | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const lists = LIST_KEYS.map((key) => record[key]);
  if (!lists.every(isPathList)) return undefined;
  const [pages, fragments, images, keep] = lists;
  return { pages, fragments, images, keep };
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (path) =>
        typeof path === 'string' &&
        path.startsWith('/') &&
        !path.startsWith('//'),
    )
  );
}
