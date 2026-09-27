/**
 * The app bar's back arrow (src/web/layout/app-bar.tsx, `data-history-back`)
 * goes back like a native app's: to the page the user came from, as history
 * holds it (htmx's snapshot: Styling's rows as they were left), whenever
 * that page is in the app. On a cold entry (a shared link, a push
 * notification, a fresh launch of the installed app) there is nothing in the
 * app to go back to, and the arrow follows its href, the page's fixed
 * parent, as the boosted link it is.
 *
 * "The previous entry is in the app" is recorded, never guessed. Every
 * history entry this tab makes carries its trail, the app's entries from the
 * cold one up to itself, in history.state:
 *  - history.state is per entry, so back/forward, a reload and the bfcache
 *    each find the trail of the entry they land on; it is per tab, and it
 *    works everywhere, iOS Safari standalone included (the Navigation API
 *    reached Safari only in 26.x, and would need this as its fallback).
 *  - A same-origin document.referrer cannot tell: a boosted navigation never
 *    changes it. sessionStorage cannot either: nothing in the History API
 *    says which entry a back/forward landed on.
 * htmx overwrites an entry's state with `{htmx: true}` when it snapshots the
 * page (before every navigation, and on every history restore), so the
 * trail on screen is kept here and written back after each.
 *
 * A native post (every PostForm, src/web/auth/form.tsx) loads a new
 * document, whose entry starts without state: the submit hands the trail
 * over in sessionStorage, and the next document takes it only when its
 * referrer is the page that posted (a push notification's navigation never
 * matches).
 *
 * A form page (AppBar `formPage`: an edit or add page) is done once saved:
 * the page its save lands on goes back past it, past a refused attempt's
 * re-render, and past the entries of its own page (the garment as it was
 * before the edit). Garment, Edit, Save, back: to where the garment page was
 * opened from, never to the stale form. "Its own page" is the pathname: a
 * page that saves in place lands on itself with a flag in the query
 * (`?saved=1`), and back from it skips the copy from before the save.
 *
 * A save makes what history holds stale: htmx's snapshots (and a bfcached
 * document) were taken before it, so the Wardrobe went back to showing the
 * garment's old name. A native post marks the tab dirty (sessionStorage),
 * and the next page restored from history while it is marked is reloaded
 * in place (the entry landed on, so no new entry; its trail survives in
 * history.state). One reload per save: an entry further back that was
 * snapshotted before the save still shows its snapshot when a later
 * back/forward restores it. A document a back/forward loads again counts
 * as restored (the browser's HTTP cache answers it). htmx writes (autosave, hx-post) do
 * not mark it: they answer the part of the page they change.
 *
 * Evaluated once per document (a module; boosted navigations swap only the
 * body): the listeners sit on the document and the window.
 */

const STATE_KEY = 'closetTrail';
const HANDOFF_KEY = 'closet-back-handoff';
const DIRTY_KEY = 'closet-back-dirty';
/** Plenty for any real back chain; keeps history.state small. */
const TRAIL_LIMIT = 50;

const here = () => location.pathname + location.search;
const last = (entries) => entries[entries.length - 1];
const pathnameOf = (path) => path.split('?')[0];
const coldTrail = () => [{ path: here(), afterForm: false }];

/** The page on screen is a form its save leaves (AppBar `formPage`). */
const onFormPage = () =>
  document.querySelector('header.app-bar[data-form-page]') !== null;

/**
 * A trail read back from history.state or the handoff, if it is one: a
 * list of entries ending at `path`.
 */
function trailEndingAt(value, path) {
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry?.path === 'string' && typeof entry.afterForm === 'boolean',
    );
  return valid && last(value).path === path ? value : null;
}

/** The trail of the entry on screen. */
let trail = [];

function remember(entries) {
  trail = entries.slice(-TRAIL_LIMIT);
  history.replaceState({ ...history.state, [STATE_KEY]: trail }, '');
}

/**
 * The trail a native post from the referring page handed over. Read once:
 * whatever this document's entry is, the handoff is spent.
 */
function takeHandoff() {
  let handoff;
  try {
    handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? 'null');
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch (error) {
    console.warn('[back] could not read the handed-over trail', error);
    return null;
  }
  if (!handoff || !document.referrer) return null;
  const referrer = new URL(document.referrer);
  if (referrer.origin !== location.origin) return null;
  const from = trailEndingAt(
    handoff.trail,
    referrer.pathname + referrer.search,
  );
  return from ? { trail: from, afterForm: handoff.afterForm === true } : null;
}

// This document's first entry: its own trail when it has one (a reload, a
// back/forward into another document), the one a native post handed over,
// or a cold entry.
{
  const handoff = takeHandoff();
  const stored = trailEndingAt(history.state?.[STATE_KEY], here());
  if (stored) {
    trail = stored;
  } else if (handoff) {
    remember([
      ...handoff.trail,
      { path: here(), afterForm: handoff.afterForm },
    ]);
  } else {
    console.debug(`[back] cold entry at ${here()}`);
    remember(coldTrail());
  }
}

/**
 * How many entries back the arrow goes: to the one before this, skipping
 * the form page a save left (and, while each skipped entry was itself a
 * save's result, the form before it) and entries of this very page. 0
 * when that runs past the trail's start: nothing in the app to go back to.
 */
function stepsBack(entries) {
  const current = entries.length - 1;
  const page = pathnameOf(entries[current].path);
  let from = current;
  let target = current - 1;
  while (
    target >= 0 &&
    (entries[from].afterForm || pathnameOf(entries[target].path) === page)
  ) {
    from = target;
    target -= 1;
  }
  return target < 0 ? 0 : current - target;
}

// Capture phase: ahead of htmx's own click listener on the (boosted) link,
// which would otherwise also navigate forward to the href.
document.addEventListener(
  'click',
  (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const link = event.target.closest('a[data-history-back]');
    if (!link) return;
    const steps = stepsBack(trail);
    if (steps === 0) {
      console.info(
        `[back] nothing in-app before ${here()}: following ${link.getAttribute('href')}`,
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    console.info(
      `[back] ${here()} -> ${trail[trail.length - 1 - steps].path} (${steps} back)`,
    );
    history.go(-steps);
  },
  { capture: true },
);

// htmx has just snapshotted the page being left, dropping the trail from its
// entry. A boosted navigation is never a form page's save (every post form
// is a native PostForm, test/integration/pages.ts), so its entry is never
// afterForm.
document.addEventListener('htmx:beforeHistoryUpdate', () => remember(trail));
document.addEventListener('htmx:pushedIntoHistory', () => {
  remember([...trail, { path: here(), afterForm: false }]);
});
document.addEventListener('htmx:replacedInHistory', () => {
  remember([
    ...trail.slice(0, -1),
    { path: here(), afterForm: last(trail).afterForm },
  ]);
});

// Back/forward within this document: the entry landed on has its own trail
// (event.state, read before htmx's restore overwrites it). An entry without
// one is a fragment link's (`#day-…`: the same address, a new entry, no
// state), which continues the trail, or one made before this module
// shipped, which starts cold. htmx:historyRestore writes it back once htmx
// is done with the entry.
window.addEventListener('popstate', (event) => {
  const stored = trailEndingAt(event.state?.[STATE_KEY], here());
  if (stored) remember(stored);
  else if (last(trail).path === here()) {
    remember([...trail, { path: here(), afterForm: false }]);
  } else remember(coldTrail());
});
document.addEventListener('htmx:historyRestore', () => {
  remember(trail);
  reloadIfDirty('history restore');
});

// Safari (and Chromium) may bring a whole document back from the bfcache
// instead. When it lands on another of its entries, popstate and htmx's
// restore follow and reload it above; the task after pageshow catches the
// entry the document was left on.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) setTimeout(() => reloadIfDirty('bfcache'));
});
// A document a back/forward loads again is no fresher: the browser answers
// history navigations from its HTTP cache where it can, and the worker's
// tab roots open from the page cache (only a reload revalidates them).
if (performance.getEntriesByType('navigation')[0]?.type === 'back_forward') {
  reloadIfDirty('back/forward load');
}

function reloadIfDirty(how) {
  if (!isDirty()) return;
  setDirty(false);
  console.info(`[back] ${here()} restored (${how}) after a save: reloading`);
  location.reload();
}

function isDirty() {
  try {
    return sessionStorage.getItem(DIRTY_KEY) !== null;
  } catch (error) {
    console.warn('[back] could not read the save mark', error);
    return false;
  }
}

function setDirty(dirty) {
  try {
    if (dirty) sessionStorage.setItem(DIRTY_KEY, '1');
    else sessionStorage.removeItem(DIRTY_KEY);
  } catch (error) {
    console.warn('[back] could not write the save mark', error);
  }
}

// A native submit leaves this document: hand the trail to the next one. A
// boosted form's submit is htmx's (prevented), as is one a confirm() or
// submit-once (loaded before this module) cancelled.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (
    event.defaultPrevented ||
    !(form instanceof HTMLFormElement) ||
    (form.target && form.target !== '_self')
  ) {
    return;
  }
  const posts = form.method === 'post';
  if (posts) setDirty(true);
  const handoff = { trail, afterForm: posts && onFormPage() };
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch (error) {
    console.warn('[back] could not hand the trail over', error);
  }
});
