/**
 * Opening a deck link with a slide hash (`#/34/0`, `#/slide-id`) on a phone
 * (#763). Below reveal's `scrollActivationWidth` the deck switches to reveal's
 * scroll view: every slide becomes a page the viewport scrolls through.
 * reveal turns the hash into a scroll position in proportion to the slide
 * count, read at init, before our layout settles, and off by a page whenever a
 * page before the target is taller than the screen. So the viewer scrolls the
 * target slide's own page to the top itself, once the layout has settled and
 * on each hash change.
 */

/**
 * The slide a reveal hash names, under `root`, or null. Same reading as
 * reveal's: a name starting with a digit is `h[/v]` (indices from 0), anything
 * else is a slide id.
 */
export function slideForHash(hash: string, root: ParentNode): Element | null {
  const name = hash.replace(/^#\/?/, '');
  if (!name) return null;

  const indices = /^(\d+)(?:\/(\d+))?/.exec(name);
  if (!indices) {
    let id: string;
    try {
      id = decodeURIComponent(name.split('/')[0]);
    } catch {
      return null;
    }
    // Compared, not built into a selector: an id can hold any character.
    return Array.from(root.querySelectorAll('section')).find(section => section.id === id) ?? null;
  }

  const h = indices[1];
  const v = indices[2] ?? '0';
  return (
    root.querySelector(`section[data-index-h="${h}"][data-index-v="${v}"]`) ??
    root.querySelector(`section[data-index-h="${h}"]`)
  );
}

/**
 * Scroll `viewport` so the page holding `slide` starts at its top, below
 * `offset` px of fixed chrome (the navbar). Returns whether it scrolled.
 */
export function scrollToSlidePage(viewport: Element, slide: Element, offset = 0): boolean {
  const page = slide.closest('.scroll-page') ?? slide;
  const top =
    page.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top +
    viewport.scrollTop -
    offset;
  if (!Number.isFinite(top)) return false;
  viewport.scrollTop = Math.max(0, Math.round(top));
  return true;
}

/**
 * The hash reveal would write for a slide (it doesn't while scrolling in its
 * scroll view): `#/<id>` for a slide with an id, else `#/h` or `#/h/v`.
 */
export function hashForSlide(slide: Element | null, h: number, v: number): string {
  if (slide?.id) return `#/${encodeURIComponent(slide.id)}`;
  return v > 0 ? `#/${h}/${v}` : `#/${h}`;
}
