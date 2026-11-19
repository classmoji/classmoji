/**
 * After the editor adds or removes sections, Reveal's `sync()` re-reads the
 * deck. Since reveal.js 6 it also re-applies the present/past/future classes
 * at the indices it held before the change, so removing a slide before the
 * one on screen moves the view one slide on; and it marks every slide but its
 * remembered current one `inert`, which leaves the slide now on screen dead
 * to input when that remembered slide was the one removed. Only `slide()`
 * moves that remembered slide.
 *
 * So after a sync the deck is put back on a slide with `slide()`: the one the
 * caller names when it is still in the deck, else the one Reveal now shows.
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
 * Point Reveal at `slide` (when it is still in the deck) or at the slide its
 * classes now show, so its current slide, and what it marks inert, follow
 * the DOM. Nothing happens when neither exists.
 *
 * When that slide sits at the indices Reveal already holds, Reveal's
 * `slide()` sees no change (reveal.js 6.0.2 js/reveal.js:1321-1325): it
 * starts the media of the slide now shown (:1418-1421, `!previousSlide`), but
 * stops nothing and sends no `slidechanged` (:1412-1415), even though another
 * element is on screen than before. So, only then:
 *  - the slide moved off, when it is still in the deck, has its media stopped
 *    first (Reveal's `stopEmbeddedContent` acts on the slide it still holds as
 *    current); a slide taken out of the document stops on its own;
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
  if (unchanged && before && before !== target && before.isConnected) {
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

/** The slide Reveal's classes show: the present stack's present child, else the present slide. */
function shownSlide(deck: RevealApi): HTMLElement | null {
  const top = deck.getSlidesElement()?.querySelector<HTMLElement>(':scope > section.present');
  if (!top) return null;
  return top.querySelector<HTMLElement>(':scope > section.present') ?? top;
}
