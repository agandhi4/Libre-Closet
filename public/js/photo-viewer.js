/**
 * The shared photo viewer (src/web/files/photo-viewer.tsx, #313): one
 * document-level listener opens `<dialog id="photo-viewer">` for any element
 * carrying `data-photo-open="<set id>"` (and `data-photo-large`, the photo
 * it was tapped on). The set is the server's `<template data-photo-set>`; a
 * boosted navigation or an htmx swap needs no re-binding because nothing is
 * bound to the triggers.
 *
 * What the platform does not do alone, and so lives here: stepping and
 * keyboard arrows between slides (the row itself is native scroll-snap, so a
 * swipe needs no code), the zoom toggle (click on a mouse, double tap on
 * touch; pinch is the browser's own), swipe down to close, and loading each
 * slide's large image over the thumb the page already holds. Focus moving in
 * and Esc are showModal's; focus going back is restored here, as WebKit does
 * not focus a tapped button for the dialog to return to.
 *
 * Offline: the slide starts as the thumb (cached with the page) and only
 * swaps to the large image once it loads, so a cutout never viewed stays on
 * its thumb, as the garment page does (offline-warm.md).
 */

const DOUBLE_TAP_MS = 350;
const SWIPE_DOWN_PX = 90;

const viewer = () => document.getElementById('photo-viewer');
const track = (dialog) => dialog.querySelector('[data-photo-track]');

let opener = null;
let slides = [];
let index = 0;
let lastTap = 0;
let frame = 0;

function setSet(id) {
  const template = document.querySelector(
    `template[data-photo-set="${CSS.escape(id)}"]`,
  );
  return template ? [...template.content.querySelectorAll('img')] : [];
}

function buildSlide(source) {
  const slide = document.createElement('div');
  slide.className = 'photo-viewer-slide';
  const img = document.createElement('img');
  img.alt = source.alt;
  img.src = source.dataset.thumb;
  img.draggable = false;
  slide.append(img);
  slide.dataset.large = source.getAttribute('src');
  return slide;
}

/** Swap a slide's thumb for the large image once that loads; keep the thumb when it can't. */
function loadLarge(slide) {
  if (!slide || slide.dataset.requested) return;
  slide.dataset.requested = '';
  const probe = new Image();
  probe.onload = () => {
    slide.querySelector('img').src = slide.dataset.large;
  };
  probe.src = slide.dataset.large;
}

function setZoom(dialog, on, point) {
  const slide = slides[index];
  const row = track(dialog);
  const img = slide.querySelector('img');
  const button = dialog.querySelector('[data-photo-zoom]');
  const rect = img.getBoundingClientRect();
  if (on) {
    slide.dataset.zoomed = '';
    row.dataset.zoomed = '';
    // Keep the tapped spot under the finger: the centre when keyboard or button.
    const fx = point ? (point.x - rect.left) / rect.width : 0.5;
    const fy = point ? (point.y - rect.top) / rect.height : 0.5;
    slide.scrollLeft = fx * img.offsetWidth - slide.clientWidth / 2;
    slide.scrollTop = fy * img.offsetHeight - slide.clientHeight / 2;
  } else {
    delete slide.dataset.zoomed;
    delete row.dataset.zoomed;
  }
  button.setAttribute(
    'aria-label',
    dialog.dataset[on ? 'textZoomOut' : 'textZoomIn'],
  );
  button.setAttribute('aria-pressed', String(on));
}

function isZoomed(dialog) {
  return 'zoomed' in track(dialog).dataset;
}

function sync(dialog, next) {
  if (isZoomed(dialog)) setZoom(dialog, false);
  index = next;
  for (const i of [next - 1, next, next + 1]) loadLarge(slides[i]);
  const img = slides[next].querySelector('img');
  dialog.querySelector('[data-photo-caption]').textContent = img.alt;
  dialog.querySelector('[data-photo-position]').textContent =
    dialog.dataset.textPosition
      .replace('{current}', String(next + 1))
      .replace('{total}', String(slides.length));
  for (const button of dialog.querySelectorAll('[data-photo-step]')) {
    const target = next + Number(button.dataset.photoStep);
    button.hidden = slides.length < 2;
    button.disabled = target < 0 || target >= slides.length;
  }
}

function step(dialog, by) {
  if (isZoomed(dialog)) setZoom(dialog, false);
  const target = Math.min(Math.max(index + by, 0), slides.length - 1);
  if (target === index) return;
  const row = track(dialog);
  row.scrollTo({
    left: target * row.clientWidth,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth',
  });
}

function open(trigger) {
  const dialog = viewer();
  if (!dialog || dialog.open) return;
  const sources = setSet(trigger.dataset.photoOpen);
  if (sources.length === 0) return;
  opener = trigger;
  const row = track(dialog);
  slides = sources.map(buildSlide);
  row.replaceChildren(...slides);
  const start = Math.max(
    sources.findIndex(
      (source) => source.getAttribute('src') === trigger.dataset.photoLarge,
    ),
    0,
  );
  dialog.showModal();
  row.scrollTo({ left: start * row.clientWidth, behavior: 'instant' });
  sync(dialog, start);
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-photo-open]');
  if (trigger) {
    event.preventDefault();
    open(trigger);
    return;
  }
  const dialog = viewer();
  if (!dialog?.open || !dialog.contains(event.target)) return;
  if (event.target.closest('[data-photo-close]')) {
    dialog.close();
  } else if (event.target.closest('[data-photo-zoom]')) {
    setZoom(dialog, !isZoomed(dialog));
  } else if (event.target.closest('[data-photo-step]')) {
    step(
      dialog,
      Number(event.target.closest('[data-photo-step]').dataset.photoStep),
    );
  } else if (event.target.closest('.photo-viewer-slide img')) {
    // A mouse click toggles; a touch needs a double tap, a single one being
    // the start of a swipe or pinch as far as the reader can tell.
    const point = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      const double = event.timeStamp - lastTap < DOUBLE_TAP_MS;
      lastTap = double ? 0 : event.timeStamp;
      if (!double) return;
    }
    setZoom(dialog, !isZoomed(dialog), point);
  }
});

// A photo that is not a native button (a collage piece's <img role="button">).
document.addEventListener('keydown', (event) => {
  const dialog = viewer();
  if (dialog?.open && dialog.contains(event.target)) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') step(dialog, -1);
    else if (event.key === 'ArrowRight') step(dialog, 1);
    else return;
    event.preventDefault();
    return;
  }
  const trigger = event.target.closest?.('[data-photo-open]');
  if (
    trigger &&
    trigger.tagName !== 'BUTTON' &&
    [' ', 'Enter'].includes(event.key)
  ) {
    event.preventDefault();
    open(trigger);
  }
});

// scroll and close do not bubble: capture them from the document.
document.addEventListener(
  'scroll',
  (event) => {
    const dialog = viewer();
    if (!dialog?.open || event.target !== track(dialog)) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const row = track(dialog);
      const current = Math.round(row.scrollLeft / row.clientWidth);
      if (current !== index && slides[current]) sync(dialog, current);
    });
  },
  true,
);

document.addEventListener(
  'close',
  (event) => {
    if (event.target.id !== 'photo-viewer') return;
    const dialog = event.target;
    track(dialog).replaceChildren();
    delete track(dialog).dataset.zoomed;
    slides = [];
    if (opener?.isConnected) opener.focus();
    opener = null;
  },
  true,
);

// Swipe down closes, unless the page is pinch-zoomed or a slide is.
let touchStart = null;
document.addEventListener(
  'touchstart',
  (event) => {
    const dialog = viewer();
    touchStart =
      dialog?.open &&
      event.touches.length === 1 &&
      dialog.contains(event.target)
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null;
  },
  { passive: true },
);
document.addEventListener(
  'touchend',
  (event) => {
    const dialog = viewer();
    if (!touchStart || !dialog?.open || isZoomed(dialog)) return;
    if ((window.visualViewport?.scale ?? 1) > 1.01) return;
    const touch = event.changedTouches[0];
    const dy = touch.clientY - touchStart.y;
    const dx = Math.abs(touch.clientX - touchStart.x);
    touchStart = null;
    if (dy > SWIPE_DOWN_PX && dx < dy * 0.5) dialog.close();
  },
  { passive: true },
);
