import { useLayoutEffect, type RefObject } from 'react';

/** The gap kept between a clamped panel and the viewport's edge, in px. */
export const VIEWPORT_MARGIN = 8;

/**
 * Keep an absolutely placed panel (a popover under its button) inside the
 * viewport: while `open`, shift it sideways by just enough that neither edge
 * leaves the page, and again when the window is resized. On a phone a panel
 * anchored to a button near either edge would otherwise run off the screen.
 *
 * The panel must be `hidden` while closed: it has no box to measure until
 * `open` flips, so this runs only once there is one. Give the panel a width
 * that fits the viewport (`w-[min(24rem,calc(100vw-2rem))]`) so a shift is
 * always enough.
 */
export function useViewportClamp(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  margin: number = VIEWPORT_MARGIN
) {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;

    const place = () => {
      panel.style.transform = '';
      const rect = panel.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      let shift = 0;
      if (rect.right > width - margin) shift = width - margin - rect.right;
      if (rect.left + shift < margin) shift = margin - rect.left;
      panel.style.transform = shift !== 0 ? `translateX(${Math.round(shift)}px)` : '';
    };

    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      panel.style.transform = '';
    };
  }, [panelRef, open, margin]);
}
