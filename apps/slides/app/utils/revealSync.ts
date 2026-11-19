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
 */
export function syncShowing(deck: RevealApi, slide: HTMLElement | null): void {
  deck.sync();
  showAgain(deck, slide);
}

/**
 * Point Reveal at `slide` (when it is still in the deck) or at the slide its
 * classes now show, so its current slide, and what it marks inert, follow
 * the DOM. Nothing happens when neither exists.
 */
export function showAgain(deck: RevealApi, slide: HTMLElement | null): void {
  const target = slide?.isConnected ? slide : shownSlide(deck);
  if (!target) return;
  const { h, v } = deck.getIndices(target);
  deck.slide(h, v ?? 0);
}

/** The slide Reveal's classes show: the present stack's present child, else the present slide. */
function shownSlide(deck: RevealApi): HTMLElement | null {
  const top = deck.getSlidesElement()?.querySelector<HTMLElement>(':scope > section.present');
  if (!top) return null;
  return top.querySelector<HTMLElement>(':scope > section.present') ?? top;
}
