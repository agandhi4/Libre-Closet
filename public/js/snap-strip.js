/**
 * The snap strip's observer (src/web/strip/snap-strip.tsx): which item a
 * strip holds is the one scrolled to its centre. Swiping is the browser's
 * own scroll-snap, so there are no touch handlers here at all; an
 * IntersectionObserver per strip, rooted on the strip with its margins
 * pulled in to a line down the middle, says which item crosses that line,
 * and that item becomes the choice: its `data-snap-value` goes into the
 * strip's hidden input (the element right after the strip),
 * and `data-selected` and `aria-selected` move to it.
 *
 * - initSnapStrips(root) centres each strip on its `data-selected` item and
 *   starts watching it. A page's inline module calls it on every visit (a
 *   boosted navigation brings new strips; a <script src> module would run
 *   once per document); htmx:load covers strips swapped in later and a
 *   history restore, whose snapshot keeps the chosen item marked. Calling it
 *   twice on a strip is harmless, and a strip's next page (new items in a
 *   watched strip) is observed as it lands.
 * - A tap on a neighbour centres it (and so chooses it) instead of opening
 *   it; a tap on the chosen item behaves as the item does (a boosted link
 *   opens).
 * - A mouse has two more ways in (#311): the strip's previous/next buttons
 *   (`data-snap-step`, CSS-hidden on touch devices) and the arrow keys while
 *   focus is in a strip. Both centre the neighbour of the chosen item, so
 *   the choice moves through the same observer and `snap-strip:choose`.
 * - A page with rules of its own listens on the document, nothing else:
 *   `snap-strip:choose` (cancelable, on the strip, detail.item) before an
 *   item is chosen, cancelled to keep the choice as it is; `snap-strip:watch`
 *   (on the strip) after it has been (re)scanned. Styling's locks use both.
 *
 * Evaluated once per document: the listeners below sit on the document and
 * serve every page's strips.
 */

/** Strips already watched, each with its observer. */
const watched = new WeakMap();

export function initSnapStrips(root) {
  if (!root) return;
  for (const strip of root.querySelectorAll('[data-snap-strip]')) watch(strip);
}

function watch(strip) {
  let observer = watched.get(strip);
  if (!observer) {
    centre(strip, strip.querySelector('[data-selected]'), 'instant');
    observer = new IntersectionObserver(
      (entries) => chooseFrom(strip, entries),
      {
        root: strip,
        // A zero-width band down the middle: an item intersects it only while
        // it covers the centre, which is where scroll-snap parks the choice.
        rootMargin: '0px -50% 0px -50%',
        threshold: 0,
      },
    );
    watched.set(strip, observer);
  }
  // A strip's next page arrives as new items: observing one twice is a no-op.
  for (const item of strip.querySelectorAll('[data-snap-item]')) {
    observer.observe(item);
  }
  strip.dispatchEvent(new CustomEvent('snap-strip:watch', { bubbles: true }));
}

function chooseFrom(strip, entries) {
  const crossing = entries.find((entry) => entry.isIntersecting);
  if (!crossing) return;
  const proceed = strip.dispatchEvent(
    new CustomEvent('snap-strip:choose', {
      bubbles: true,
      cancelable: true,
      detail: { item: crossing.target },
    }),
  );
  if (proceed) choose(strip, crossing.target);
}

function choose(strip, item) {
  // SnapStrip emits its input directly after the strip, so strips sharing a
  // container each write to their own.
  // A strip without a `name` has no input and writes nothing.
  const field = strip.nextElementSibling;
  if (field instanceof HTMLInputElement && field.type === 'hidden') {
    // A hidden input's value is its attribute, so htmx's history snapshot
    // keeps the choice too.
    field.value = item.dataset.snapValue;
  }
  for (const other of strip.querySelectorAll('[data-snap-item]')) {
    const chosen = other === item;
    other.toggleAttribute('data-selected', chosen);
    // Only an `option` has a selected state (snapItem's `listbox: false`).
    if (other.hasAttribute('aria-selected')) {
      other.setAttribute('aria-selected', String(chosen));
    }
  }
}

/** Scrolls `item` to the middle of its strip. */
export function centre(strip, item, behavior) {
  if (!item) return;
  const left = item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2;
  strip.scrollTo({ left, behavior });
}

function smooth() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : 'smooth';
}

// A neighbour peeking at the edge: a tap brings it to the middle (and so
// chooses it); only the chosen item's tap reaches the item. In the capture
// phase: an item may be a boosted link, and htmx's own click listener on it
// would start the navigation before a listener on the document heard the
// click bubble up. A page that makes neighbours inert (Styling's locked
// rows) gets no click on them at all: it lands on the strip.
document.addEventListener(
  'click',
  (event) => {
    const item = event.target.closest('[data-snap-item]');
    if (!item || item.hasAttribute('data-selected')) return;
    const strip = item.closest('[data-snap-strip]');
    if (!strip) return;
    event.preventDefault();
    event.stopPropagation();
    centre(strip, item, smooth());
  },
  { capture: true },
);

/** Centres the item `step` places from the chosen one; a no-op at an end. */
function stepStrip(strip, step) {
  const items = [...strip.querySelectorAll('[data-snap-item]')];
  const from = items.findIndex((item) => item.hasAttribute('data-selected'));
  const target = items[from + step];
  // Not inert: a locked Styling row's neighbours are, and stay unchosen.
  if (from < 0 || !target || target.inert) return;
  centre(strip, target, smooth());
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-snap-step]');
  if (!button) return;
  const strip = button.parentElement.querySelector('[data-snap-strip]');
  if (strip) stepStrip(strip, Number(button.dataset.snapStep));
});

// Arrow keys while focus is in a strip (an item or the scroller itself). Not
// in a field: its caret keys are its own.
document.addEventListener('keydown', (event) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  const strip = event.target.closest('[data-snap-strip]');
  if (!strip) return;
  event.preventDefault();
  stepStrip(strip, step);
});

// Strips swapped in after the page loaded, and history restores.
document.addEventListener('htmx:load', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const strip = target.closest('[data-snap-strip]');
  if (strip) watch(strip);
  else initSnapStrips(target);
});
