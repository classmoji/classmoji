import { useLayoutEffect, useState } from 'react';

/**
 * Where the tick boxes of checkable headings go: in the gutter left of the
 * heading (the default), or inside the heading before its text when the
 * gutter would be cut off.
 *
 * The gutter is cut off by the nearest ancestor that clips its overflow (the
 * pages app's scroll pane) or by the window's own left edge (the webapp's
 * side panel frames the page with a narrow margin). The room between that
 * edge and each shown checkable heading is measured, and the viewer root gets
 * `data-section-checks="inline"` when any heading has less than the gutter
 * needs (page-sections.css). The viewport width plays no part.
 *
 * Each heading is measured by its block content box. The inline layout pads
 * the inside of that box, so its left edge is the same in both layouts and
 * the result never feeds back into the measurement.
 */

/**
 * Room the gutter layout needs left of a heading, in px: the box sits 34px
 * out (`.pg-section-check` `left`) with a 4px focus ring. Its hover tooltip
 * starts at the box's left edge and runs right, so it needs no more.
 */
export const SECTION_CHECK_GUTTER = 38;

export type SectionCheckLayout = 'gutter' | 'inline';

/**
 * The left edge, in viewport px, past which `element`'s overflow is not
 * shown: the right-most padding edge of its clipping ancestors, or the
 * window's left edge (0).
 */
export function clipLeftOf(element: Element): number {
  const view = element.ownerDocument.defaultView;
  const html = element.ownerDocument.documentElement;
  let left = 0;
  for (let node = element.parentElement; node && node !== html; node = node.parentElement) {
    const overflow = view?.getComputedStyle(node).overflowX;
    if (!overflow || overflow === 'visible') continue;
    left = Math.max(left, node.getBoundingClientRect().left + node.clientLeft);
  }
  return left;
}

/**
 * The layout for the tick boxes under `root`: inline when any shown
 * checkable heading has less than `SECTION_CHECK_GUTTER` px of room, null
 * when no tick box is shown (none on the page, the reader cannot tick, or
 * all inside collapsed blocks).
 */
export function sectionCheckLayout(root: Element): SectionCheckLayout | null {
  let room = Infinity;
  const headings = root.querySelectorAll(".bn-block-content[data-checkable='true']");
  for (const content of Array.from(headings)) {
    const button = content.querySelector(':scope > .pg-section-check');
    if (!button || (button as HTMLElement).hidden) continue;
    const rect = content.getBoundingClientRect();
    // Not laid out (inside a collapsed toggle or locked section).
    if (rect.width === 0 && rect.height === 0) continue;
    room = Math.min(room, rect.left - clipLeftOf(content));
  }
  if (room === Infinity) return null;
  return room < SECTION_CHECK_GUTTER ? 'inline' : 'gutter';
}

/**
 * Keep `data-section-checks` on the viewer root in step with the room the
 * tick boxes have. Returns the ref for the root.
 *
 * Measured before the first paint, then again (one frame later) whenever the
 * root or any ancestor changes size (the window, the frame, the sidebar,
 * blocks opening) and on window resize. The attribute is written on the DOM
 * directly, so the viewer does not re-render for it.
 */
export function useSectionCheckGutter(enabled: boolean): (element: HTMLElement | null) => void {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!container) return;
    const apply = () => {
      const layout = enabled ? sectionCheckLayout(container) : null;
      if (layout === 'inline') {
        if (container.dataset.sectionChecks !== 'inline')
          container.dataset.sectionChecks = 'inline';
      } else if (container.dataset.sectionChecks !== undefined) {
        delete container.dataset.sectionChecks;
      }
    };
    apply();
    if (!enabled) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };
    const observer = new ResizeObserver(schedule);
    for (let node: Element | null = container; node; node = node.parentElement) {
      observer.observe(node);
    }
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [container, enabled]);

  return setContainer;
}
