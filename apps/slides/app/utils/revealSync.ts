/**
 * After the editor adds or removes sections, Reveal's `sync()` re-reads the
 * deck. Since reveal.js 6 it also re-applies the present/past/future classes
 * at the indices it held before the change, so removing a slide before the
 * one on screen moves the view one slide on; and it marks every slide but its
 * remembered current one `inert`, which leaves the slide now on screen dead
 * to input when that remembered slide was the one removed. Only `slide()`
 * moves that remembered slide.
 *
 * So after a sync the deck is put back on a slide: the one the caller names
 * when it is still in the deck, else the one Reveal now shows.
 *
 * No imports, on purpose: the unit suite loads this module as it is beside
 * reveal.js in Chrome (tests/unit/reveal-sync.spec.ts).
 */
export function syncShowing(deck: RevealApi, slide: HTMLElement | null): void {
  deck.sync();
  showAgain(deck, slide);
}

/**
 * Add `slide` to the left of `current` (before its stack when `current` is a
 * stack child) and show it.
 */
export function addSlideLeftOf(deck: RevealApi, current: HTMLElement, slide: HTMLElement): void {
  const parent = current.parentElement;
  if (!parent) return;
  const next = parent.tagName === 'SECTION' ? parent : current;
  next.parentElement?.insertBefore(slide, next);
  syncShowing(deck, slide);
}

/**
 * The slide to show once `slide`, the slide on screen, is deleted, picked
 * while it is still in place: the one above it in its stack, else the one
 * below; for a slide alone at its level (top-level, or a stack's only child)
 * the one to its left, else the one to its right, a stack entered on the
 * child Reveal resumes it on (reveal.js 6.0.2 js/reveal.js:1060-1071,
 * :1296-1300). These are the slides the toolbar's delete has always moved to.
 * Null when there is no other slide.
 */
export function slideBeside(deck: RevealApi, slide: HTMLElement): HTMLElement | null {
  const parent = slide.parentElement;
  const stack = parent?.localName === 'section' ? parent : null;
  if (stack) {
    const siblings = sectionChildren(stack);
    if (siblings.length > 1) {
      const at = siblings.indexOf(slide);
      return siblings[at > 0 ? at - 1 : at + 1] ?? null;
    }
  }
  const tops = sectionChildren(deck.getSlidesElement());
  const at = tops.indexOf(stack ?? slide);
  const beside = tops[at > 0 ? at - 1 : at + 1];
  if (!beside) return null;
  const children = sectionChildren(beside);
  if (children.length === 0) return beside;
  const remembered = beside.hasAttribute('data-start-indexv')
    ? 'data-start-indexv'
    : 'data-previous-indexv';
  const resume = parseInt(beside.getAttribute(remembered) ?? '', 10) || 0;
  return children[Math.max(Math.min(resume, children.length - 1), 0)];
}

/**
 * Point Reveal at `slide` (when it is still in the deck) or at the slide its
 * classes now show, so its current slide, and what it marks inert, follow
 * the DOM. Nothing happens when neither exists.
 *
 * When that is the slide Reveal already holds as current, only its indices
 * may be out of date (a slide before it went): see `moveQuietly`.
 *
 * When it is another slide at the indices Reveal already holds, Reveal's
 * `slide()` sees no change (reveal.js 6.0.2 js/reveal.js:1321-1325): it
 * starts the media of the slide now shown (:1418-1421, `!previousSlide`), but
 * stops nothing, clears nothing and sends no `slidechanged` (:1412-1415),
 * even though another element is on screen than before. So, only then:
 *  - the slide moved off, when it is still in the deck, has its media stopped
 *    first (Reveal's `stopEmbeddedContent` acts on the slide it still holds as
 *    current); a slide taken out of the document stops on its own;
 *  - what Reveal clears on a slide change goes (`clearMediaPlaybackErrors`);
 *  - `slidechanged` is sent the way Reveal sends it (its `dispatchEvent`, with
 *    `dispatchSlideChanged`'s fields, :768-781), so everything that follows
 *    the current slide (the notes panel, the live bridge, Ask Moji) does.
 * When Reveal sends `slidechanged` itself, nothing more is sent.
 */
export function showAgain(deck: RevealApi, slide: HTMLElement | null): void {
  const target = slide?.isConnected ? slide : shownSlide(deck);
  if (!target) return;
  const before: HTMLElement | null = deck.getCurrentSlide() ?? null;
  const held = deck.getIndices();
  const { h, v } = deck.getIndices(target);
  const unchanged = h === held.h && (v ?? 0) === (held.v ?? 0);
  if (before === target) {
    // sync() has already shown it at the indices Reveal holds, and marked
    // inert everything else.
    if (!unchanged) moveQuietly(deck, target, held, h, v ?? 0);
    return;
  }
  if (unchanged && before?.isConnected) {
    deck.stopEmbeddedContent?.();
  }

  let announced = false;
  const onSlideChanged = () => {
    announced = true;
  };
  deck.on('slidechanged', onSlideChanged);
  try {
    deck.slide(h, v ?? 0);
  } finally {
    deck.off('slidechanged', onSlideChanged);
  }

  const after: HTMLElement | null = deck.getCurrentSlide() ?? null;
  if (announced || !after || after === before) return;
  clearMediaPlaybackErrors(deck, before);
  const now = deck.getIndices();
  deck.dispatchEvent({
    type: 'slidechanged',
    data: {
      indexh: now.h,
      indexv: now.v,
      previousSlide: before,
      currentSlide: after,
      origin: undefined,
    },
  });
}

/**
 * Move Reveal's indices to `h`/`v`, where `slide`, the slide it holds as
 * current and the one on screen, now is: nothing changes on screen.
 *
 * `slide()` alone would see a change from `slide` to itself: send
 * `slidechanged` with previous === current, stop the slide's media and
 * frames (pausing its videos, unloading its lazy frames) and start them over
 * from the beginning (reveal.js 6.0.2 js/reveal.js:1412-1421;
 * js/controllers/slidecontent.js:445-456, :564-616). So, for one call, Reveal
 * is pointed at an empty stand-in put where its indices still point (indices
 * unchanged: nothing is stopped, cleared or sent, js/reveal.js:1321-1325),
 * the stand-in is taken out, and `slide()` moves from it to `slide`: Reveal
 * stops nothing on a slide out of the document (slidecontent.js:571), and
 * the one `slidechanged` it sends is not passed on. The stand-in carries
 * `slide`'s id, so the URL Reveal writes for it (js/controllers/
 * location.js:201-238) is the one it already shows.
 *
 * What Reveal still does to `slide` is start it (js/reveal.js:1420): a video
 * playing plays on and a frame already loaded is not loaded again, but a
 * video paused there would be sought to its start and played
 * (slidecontent.js:452-455), so it is paused again where it was. It also
 * clears its media errors (js/reveal.js:1413).
 */
function moveQuietly(
  deck: RevealApi,
  slide: HTMLElement,
  held: { h: number; v?: number },
  h: number,
  v: number
): void {
  const top = sectionChildren(deck.getSlidesElement())[held.h];
  const at = (held.v ?? 0) > 0 ? sectionChildren(top ?? null)[held.v ?? 0] : top;
  if (!at) {
    deck.slide(h, v);
    return;
  }
  const doc = slide.ownerDocument;
  const standIn = doc.createElement('section');
  if (slide.id) standIn.id = slide.id;
  const unannounced = (event: Event & { previousSlide?: unknown }) => {
    if (event.previousSlide === standIn) event.stopImmediatePropagation();
  };
  const paused = Array.from(slide.querySelectorAll<HTMLMediaElement>('video, audio'))
    .filter(media => media.paused)
    .map(media => [media, media.currentTime] as const);
  doc.addEventListener('slidechanged', unannounced, true);
  try {
    at.before(standIn);
    deck.slide(held.h, held.v ?? 0);
    standIn.remove();
    deck.slide(h, v);
  } finally {
    standIn.remove();
    doc.removeEventListener('slidechanged', unannounced, true);
  }
  for (const [media, time] of paused) {
    if (media.paused) continue;
    media.pause();
    media.currentTime = time;
  }
}

/**
 * Reveal's own clean-up on a slide change (js/reveal.js:1413,
 * js/controllers/slidecontent.js:683-712 `clearMediaPlaybackErrors`, which
 * it does not expose): a video it muted to autoplay is unmuted and unmarked,
 * and its play/unmute button goes. `previous` is the slide moved off, which
 * may be out of the document already.
 */
function clearMediaPlaybackErrors(deck: RevealApi, previous: HTMLElement | null): void {
  const root = deck.getRevealElement?.() ?? deck.getSlidesElement();
  root?.querySelectorAll('.r-media-play-button').forEach(button => button.remove());
  for (const scope of [root, previous]) {
    scope?.querySelectorAll<HTMLMediaElement>('[data-muted-by-reveal]').forEach(media => {
      media.muted = false;
      media.removeAttribute('data-muted-by-reveal');
    });
  }
}

/** The slide Reveal's classes show: the present stack's present child, else the present slide. */
function shownSlide(deck: RevealApi): HTMLElement | null {
  const top = deck.getSlidesElement()?.querySelector<HTMLElement>(':scope > section.present');
  if (!top) return null;
  return top.querySelector<HTMLElement>(':scope > section.present') ?? top;
}

/** The `<section>` children of `el`: the deck's slides, or a stack's. */
function sectionChildren(el: Element | null): HTMLElement[] {
  if (!el) return [];
  return Array.from(el.children).filter(
    (child): child is HTMLElement => child.localName === 'section'
  );
}
